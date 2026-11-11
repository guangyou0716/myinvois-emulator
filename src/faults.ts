import { readFileSync } from 'node:fs';
import { mixSeed } from './ids.js';
import { RATE_LIMIT_ENDPOINTS, type RateLimitEndpoint } from './rate-limit.js';

export const FAULT_KINDS = ['error500', 'latency', 'rateLimit429', 'reset'] as const;
export type FaultKind = (typeof FAULT_KINDS)[number];

export const FAULT_ENDPOINTS = [...RATE_LIMIT_ENDPOINTS, '*'] as const;
export type FaultEndpoint = (typeof FAULT_ENDPOINTS)[number];

export interface FaultRule {
  endpoint: FaultEndpoint;
  kind: FaultKind;
  /** Inclusive 0..1. Mutually exclusive with `nth`. */
  probability?: number;
  /** 1-based request counts for this rule's endpoint. Mutually exclusive with `probability`. */
  nth?: number[];
  /** Required for `latency`. Integer milliseconds in 0..60000. */
  latencyMs?: number;
  /** Optional for `rateLimit429`. Positive integer. Default 60. */
  retryAfterSeconds?: number;
}

export type FaultAction = {
  delayMs: number;
  kind: 'none' | 'error500' | 'rateLimit429' | 'reset';
  retryAfterSeconds: number;
};

export class FaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FaultError';
  }
}

const KIND_SET = new Set<string>(FAULT_KINDS);
const ENDPOINT_SET = new Set<string>(FAULT_ENDPOINTS);
const ENDPOINT_LIST = FAULT_ENDPOINTS.join(', ');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mulberry32(seed: number): () => number {
  // Mix the full safe-integer seed first. `seed ^ k` is a 32-bit op and would
  // drop bits above 32, so seeds 2^32 apart would share a stream.
  let state = (mixSeed(seed) ^ 0xa5a5a5a5) >>> 0;
  if (state === 0) state = 0x6d2b79f5;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function cloneRule(rule: FaultRule): FaultRule {
  const cloned: FaultRule = { endpoint: rule.endpoint, kind: rule.kind };
  if (rule.probability !== undefined) cloned.probability = rule.probability;
  if (rule.nth !== undefined) cloned.nth = [...rule.nth];
  if (rule.latencyMs !== undefined) cloned.latencyMs = rule.latencyMs;
  if (rule.retryAfterSeconds !== undefined) cloned.retryAfterSeconds = rule.retryAfterSeconds;
  return cloned;
}

function parseRule(value: unknown, label: string): FaultRule {
  if (!isRecord(value)) throw new FaultError(`${label} must be an object`);

  if (typeof value.endpoint !== 'string' || !ENDPOINT_SET.has(value.endpoint)) {
    throw new FaultError(`${label}.endpoint must be one of ${ENDPOINT_LIST}`);
  }
  if (typeof value.kind !== 'string' || !KIND_SET.has(value.kind)) {
    throw new FaultError(`${label}.kind must be error500, latency, rateLimit429, or reset`);
  }

  const hasProbability = value.probability !== undefined;
  const hasNth = value.nth !== undefined;
  if (hasProbability === hasNth) {
    throw new FaultError(`${label} must have either probability or nth`);
  }

  const rule: FaultRule = {
    endpoint: value.endpoint as FaultEndpoint,
    kind: value.kind as FaultKind,
  };

  if (hasProbability) {
    if (
      typeof value.probability !== 'number' ||
      !Number.isFinite(value.probability) ||
      value.probability < 0 ||
      value.probability > 1
    ) {
      throw new FaultError(`${label}.probability must be a number from 0 to 1`);
    }
    rule.probability = value.probability;
  }

  if (hasNth) {
    if (!Array.isArray(value.nth) || value.nth.length === 0) {
      throw new FaultError(`${label}.nth must be a non-empty array of positive integers`);
    }
    rule.nth = value.nth.map((entry, index) => {
      if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 1 || !Number.isSafeInteger(entry)) {
        throw new FaultError(`${label}.nth[${index}] must be a positive integer`);
      }
      return entry;
    });
  }

  if (rule.kind === 'latency') {
    if (value.latencyMs === undefined) {
      throw new FaultError(`${label}.latencyMs is required for kind latency`);
    }
    if (
      typeof value.latencyMs !== 'number' ||
      !Number.isInteger(value.latencyMs) ||
      value.latencyMs < 0 ||
      value.latencyMs > 60_000
    ) {
      throw new FaultError(`${label}.latencyMs must be an integer from 0 to 60000`);
    }
    rule.latencyMs = value.latencyMs;
  } else if (value.latencyMs !== undefined) {
    throw new FaultError(`${label}.latencyMs is only valid for kind latency`);
  }

  if (value.retryAfterSeconds !== undefined) {
    if (rule.kind !== 'rateLimit429') {
      throw new FaultError(`${label}.retryAfterSeconds is only valid for kind rateLimit429`);
    }
    if (
      typeof value.retryAfterSeconds !== 'number' ||
      !Number.isInteger(value.retryAfterSeconds) ||
      value.retryAfterSeconds < 1 ||
      !Number.isSafeInteger(value.retryAfterSeconds)
    ) {
      throw new FaultError(`${label}.retryAfterSeconds must be a positive integer`);
    }
    rule.retryAfterSeconds = value.retryAfterSeconds;
  }

  return rule;
}

export function parseFaults(value: unknown, source = 'faults'): FaultRule[] {
  let raw: unknown;
  let label: string;
  if (Array.isArray(value)) {
    raw = value;
    label = source;
  } else if (isRecord(value) && value.faults !== undefined) {
    raw = value.faults;
    label = `${source}: faults`;
  } else {
    throw new FaultError(`${source}: must be a JSON array or {"faults": [...]}`);
  }
  if (!Array.isArray(raw)) {
    throw new FaultError(`${source}: faults must be an array`);
  }
  return raw.map((entry, index) => parseRule(entry, `${label}[${index}]`));
}

export function loadFaultsFile(path: string): FaultRule[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new FaultError(`Cannot read faults ${path}: ${detail}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new FaultError(`Faults ${path} is not valid JSON: ${detail}`);
  }
  return parseFaults(parsed, path);
}

export class FaultInjector {
  private rules: FaultRule[] = [];
  private readonly counters = new Map<string, number>();
  private readonly rng: () => number;

  constructor(seed: number, rules: FaultRule[] = []) {
    this.rng = mulberry32(seed);
    this.replace(rules);
  }

  snapshot(): FaultRule[] {
    return this.rules.map(cloneRule);
  }

  replace(rules: FaultRule[]): FaultRule[] {
    this.rules = rules.map(cloneRule);
    this.resetCounters();
    return this.snapshot();
  }

  resetCounters(): void {
    this.counters.clear();
  }

  evaluate(endpoint: RateLimitEndpoint | null): FaultAction {
    this.bump('*');
    if (endpoint !== null) this.bump(endpoint);

    let delayMs = 0;
    for (const rule of this.rules) {
      if (!endpointMatches(rule.endpoint, endpoint)) continue;
      const count = this.counters.get(rule.endpoint) ?? 0;
      if (!this.triggerMatches(rule, count)) continue;
      if (rule.kind === 'latency') {
        delayMs += rule.latencyMs ?? 0;
        continue;
      }
      if (rule.kind === 'rateLimit429') {
        return { delayMs, kind: 'rateLimit429', retryAfterSeconds: rule.retryAfterSeconds ?? 60 };
      }
      return { delayMs, kind: rule.kind, retryAfterSeconds: 0 };
    }
    return { delayMs, kind: 'none', retryAfterSeconds: 0 };
  }

  private bump(key: string): void {
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  private triggerMatches(rule: FaultRule, count: number): boolean {
    if (rule.nth !== undefined) return rule.nth.includes(count);
    if (rule.probability !== undefined) return this.rng() < rule.probability;
    return false;
  }
}

function endpointMatches(ruleEndpoint: FaultEndpoint, requestEndpoint: RateLimitEndpoint | null): boolean {
  if (ruleEndpoint === '*') return true;
  return requestEndpoint === ruleEndpoint;
}

import type { Clock } from './clock.js';
import { RATE_LIMIT_WINDOW_MS } from './constants.js';

/**
 * Shared bucket for requests that have no OAuth client_id (token) and no
 * authenticatable bearer (API). Prefixed so it cannot collide with a tenant id.
 */
export const RATE_LIMIT_UNAUTHENTICATED = '\0unauthenticated';

export const RATE_LIMIT_ENDPOINTS = [
  'token',
  'submit',
  'getSubmission',
  'cancelReject',
  'getDocument',
  'getDocumentDetails',
  'validateTin',
] as const;

export type RateLimitEndpoint = (typeof RATE_LIMIT_ENDPOINTS)[number];

export type RateLimitRpm = Record<RateLimitEndpoint, number>;

/**
 * Defaults from the MyInvois integration-practices RPM table.
 * Search and recent-document routes are not implemented; see README.
 */
export const DEFAULT_RPM: RateLimitRpm = {
  token: 12,
  submit: 100,
  getSubmission: 300,
  cancelReject: 12,
  getDocument: 60,
  getDocumentDetails: 125,
  validateTin: 60,
};

export interface RateLimitOptions {
  /** Default true. */
  enabled?: boolean;
  /** Multiply each RPM, then floor, minimum 1. Default 1. Must be finite and > 0. */
  scale?: number;
  /** Partial base-RPM overrides, applied before scale. */
  rpm?: Partial<RateLimitRpm>;
}

export interface ResolvedRateLimit {
  enabled: boolean;
  rpm: RateLimitRpm;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
  headers: Record<string, string>;
}

interface Bucket {
  windowStart: number;
  count: number;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function resolveRateLimit(options: RateLimitOptions | undefined): ResolvedRateLimit {
  const enabled = options?.enabled ?? true;
  if (typeof enabled !== 'boolean') {
    throw new Error('rateLimit.enabled must be a boolean');
  }
  const scale = options?.scale ?? 1;
  if (!isPositiveFinite(scale)) {
    throw new Error('rateLimit.scale must be a finite number greater than 0');
  }
  const base: RateLimitRpm = { ...DEFAULT_RPM };
  if (options?.rpm !== undefined) {
    if (typeof options.rpm !== 'object' || options.rpm === null || Array.isArray(options.rpm)) {
      throw new Error('rateLimit.rpm must be an object');
    }
    for (const endpoint of RATE_LIMIT_ENDPOINTS) {
      const value = options.rpm[endpoint];
      if (value === undefined) continue;
      if (!isPositiveFinite(value)) {
        throw new Error(`rateLimit.rpm.${endpoint} must be a finite number greater than 0`);
      }
      base[endpoint] = value;
    }
  }
  const rpm = { ...base };
  for (const endpoint of RATE_LIMIT_ENDPOINTS) {
    rpm[endpoint] = Math.max(1, Math.floor(base[endpoint] * scale));
  }
  return { enabled, rpm };
}

export function rateLimitHeaders(
  limit: number,
  remaining: number,
  resetAt: number,
  retryAfterSeconds?: number,
): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Rate-Limit-Limit': String(limit),
    'X-Rate-Limit-Remaining': String(remaining),
    'X-Rate-Limit-Reset': new Date(resetAt).toISOString(),
  };
  if (retryAfterSeconds !== undefined) {
    headers['Retry-After'] = String(retryAfterSeconds);
  }
  return headers;
}

function windowBounds(now: number): { windowStart: number; resetAt: number } {
  const windowStart = Math.floor(now / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS;
  return { windowStart, resetAt: windowStart + RATE_LIMIT_WINDOW_MS };
}

export function retryAfterSeconds(now: number, resetAt: number): number {
  return Math.max(1, Math.ceil((resetAt - now) / 1000));
}

export class RateLimiter {
  readonly enabled: boolean;
  readonly rpm: RateLimitRpm;
  private readonly clock: Clock;
  private readonly buckets = new Map<string, Bucket>();

  constructor(clock: Clock, resolved: ResolvedRateLimit) {
    this.clock = clock;
    this.enabled = resolved.enabled;
    this.rpm = resolved.rpm;
  }

  reset(): void {
    this.buckets.clear();
  }

  hit(clientId: string, endpoint: RateLimitEndpoint): RateLimitDecision {
    const limit = this.rpm[endpoint];
    const now = this.clock.now();
    const { windowStart, resetAt } = windowBounds(now);
    const retryAfter = retryAfterSeconds(now, resetAt);

    if (!this.enabled) {
      return {
        allowed: true,
        limit,
        remaining: limit,
        resetAt,
        retryAfterSeconds: retryAfter,
        headers: {},
      };
    }

    const key = `${clientId}\n${endpoint}`;
    let bucket = this.buckets.get(key);
    if (bucket === undefined || bucket.windowStart !== windowStart) {
      bucket = { windowStart, count: 0 };
      this.buckets.set(key, bucket);
    }

    if (bucket.count >= limit) {
      return {
        allowed: false,
        limit,
        remaining: 0,
        resetAt,
        retryAfterSeconds: retryAfter,
        headers: rateLimitHeaders(limit, 0, resetAt, retryAfter),
      };
    }

    bucket.count += 1;
    const remaining = limit - bucket.count;
    return {
      allowed: true,
      limit,
      remaining,
      resetAt,
      retryAfterSeconds: retryAfter,
      headers: rateLimitHeaders(limit, remaining, resetAt),
    };
  }
}

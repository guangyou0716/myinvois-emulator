import { readFileSync } from 'node:fs';
import {
  DEFAULT_ERROR_CODES,
  DEFAULT_STATUS_CODES,
  DEFAULT_TENANTS,
  defaultConfig,
} from './defaults.js';

export type TenantRole = 'supplier' | 'buyer' | 'intermediary';

export interface TenantConfig {
  tin: string;
  name: string;
  role: TenantRole;
  clientId: string;
  clientSecret: string;
  idType: string;
  idValue: string;
}

export interface ErrorCodeMap {
  operationPeriodOver: string;
  incorrectState: string;
  invalidClient: string;
  badStructure: string;
  maximumSizeExceeded: string;
  incorrectSubmitter: string;
  duplicateSubmission: string;
  unauthorized: string;
  notFound: string;
  invalidRequest: string;
}

export interface StatusCodeMap {
  invalidClient: number;
  missingParameters: number;
  badStructure: number;
  maximumSizeExceeded: number;
  incorrectSubmitter: number;
  duplicateSubmission: number;
  unauthorized: number;
  notFound: number;
  incorrectState: number;
  operationPeriodOver: number;
}

export interface EmulatorConfig {
  validationDelayMs?: number;
  duplicateWindowMs?: number;
  cancelWindowMs?: number;
  tokenTtlSeconds?: number;
  errorCodes?: Partial<ErrorCodeMap>;
  statusCodes?: Partial<StatusCodeMap>;
  tenants?: TenantConfig[];
}

export interface ResolvedConfig {
  validationDelayMs: number;
  duplicateWindowMs: number;
  cancelWindowMs: number;
  tokenTtlSeconds: number;
  errorCodes: ErrorCodeMap;
  statusCodes: StatusCodeMap;
  tenants: TenantConfig[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const ERROR_CODE_KEYS = Object.keys(DEFAULT_ERROR_CODES) as (keyof ErrorCodeMap)[];
const STATUS_CODE_KEYS = Object.keys(DEFAULT_STATUS_CODES) as (keyof StatusCodeMap)[];
const ROLES = new Set<TenantRole>(['supplier', 'buyer', 'intermediary']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonNegativeInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ConfigError(`${label} must be a non-negative integer`);
  }
  return value;
}

function readTenant(value: unknown, label: string): TenantConfig {
  if (!isRecord(value)) throw new ConfigError(`${label} must be an object`);
  const tin = readText(value.tin, `${label}.tin`);
  const name = readText(value.name, `${label}.name`);
  const clientId = readText(value.clientId, `${label}.clientId`);
  const clientSecret = readText(value.clientSecret, `${label}.clientSecret`);
  const idType = readText(value.idType, `${label}.idType`);
  const idValue = readText(value.idValue, `${label}.idValue`);
  if (typeof value.role !== 'string' || !ROLES.has(value.role as TenantRole)) {
    throw new ConfigError(`${label}.role must be supplier, buyer, or intermediary`);
  }
  return {
    tin,
    name,
    role: value.role as TenantRole,
    clientId,
    clientSecret,
    idType,
    idValue,
  };
}

function readText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function readTenants(value: unknown, source: string): TenantConfig[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConfigError(`${source}: tenants must be a non-empty array`);
  }
  const tenants = value.map((entry, index) => readTenant(entry, `${source}: tenants[${index}]`));
  const tins = new Set<string>();
  const clientIds = new Set<string>();
  for (const tenant of tenants) {
    if (tins.has(tenant.tin)) throw new ConfigError(`${source}: duplicate tenant TIN ${tenant.tin}`);
    if (clientIds.has(tenant.clientId)) {
      throw new ConfigError(`${source}: duplicate clientId ${tenant.clientId}`);
    }
    tins.add(tenant.tin);
    clientIds.add(tenant.clientId);
  }
  return tenants;
}

export function parseConfig(value: unknown, source = 'config'): EmulatorConfig {
  if (!isRecord(value)) throw new ConfigError(`${source}: config must be a JSON object`);
  const config: EmulatorConfig = {};
  if (value.validationDelayMs !== undefined) {
    config.validationDelayMs = readNonNegativeInt(value.validationDelayMs, `${source}: validationDelayMs`);
  }
  if (value.duplicateWindowMs !== undefined) {
    config.duplicateWindowMs = readNonNegativeInt(value.duplicateWindowMs, `${source}: duplicateWindowMs`);
  }
  if (value.cancelWindowMs !== undefined) {
    config.cancelWindowMs = readNonNegativeInt(value.cancelWindowMs, `${source}: cancelWindowMs`);
  }
  if (value.tokenTtlSeconds !== undefined) {
    const ttl = readNonNegativeInt(value.tokenTtlSeconds, `${source}: tokenTtlSeconds`);
    if (ttl < 1) throw new ConfigError(`${source}: tokenTtlSeconds must be at least 1`);
    config.tokenTtlSeconds = ttl;
  }
  if (value.errorCodes !== undefined) {
    if (!isRecord(value.errorCodes)) throw new ConfigError(`${source}: errorCodes must be an object`);
    const codes: Partial<ErrorCodeMap> = {};
    for (const key of ERROR_CODE_KEYS) {
      if (value.errorCodes[key] !== undefined) {
        codes[key] = readText(value.errorCodes[key], `${source}: errorCodes.${key}`);
      }
    }
    config.errorCodes = codes;
  }
  if (value.statusCodes !== undefined) {
    if (!isRecord(value.statusCodes)) throw new ConfigError(`${source}: statusCodes must be an object`);
    const codes: Partial<StatusCodeMap> = {};
    for (const key of STATUS_CODE_KEYS) {
      const raw = value.statusCodes[key];
      if (raw !== undefined) {
        if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 100 || raw > 599) {
          throw new ConfigError(`${source}: statusCodes.${key} must be an integer HTTP status`);
        }
        codes[key] = raw;
      }
    }
    config.statusCodes = codes;
  }
  if (value.tenants !== undefined) config.tenants = readTenants(value.tenants, source);
  return config;
}

export function loadConfigFile(path: string): EmulatorConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new ConfigError(`Cannot read config ${path}: ${detail}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new ConfigError(`Config ${path} is not valid JSON: ${detail}`);
  }
  return parseConfig(parsed, path);
}

export function resolveConfig(override?: EmulatorConfig): ResolvedConfig {
  const base = defaultConfig();
  const merged: EmulatorConfig = override ?? {};
  const validationDelayMs = merged.validationDelayMs ?? base.validationDelayMs ?? 0;
  const duplicateWindowMs = merged.duplicateWindowMs ?? base.duplicateWindowMs ?? 0;
  const cancelWindowMs = merged.cancelWindowMs ?? base.cancelWindowMs ?? 0;
  const tokenTtlSeconds = merged.tokenTtlSeconds ?? base.tokenTtlSeconds ?? 1;
  return {
    validationDelayMs,
    duplicateWindowMs,
    cancelWindowMs,
    tokenTtlSeconds,
    errorCodes: { ...DEFAULT_ERROR_CODES, ...base.errorCodes, ...merged.errorCodes },
    statusCodes: { ...DEFAULT_STATUS_CODES, ...base.statusCodes, ...merged.statusCodes },
    tenants: (merged.tenants ?? base.tenants ?? DEFAULT_TENANTS).map((tenant) => ({ ...tenant })),
  };
}

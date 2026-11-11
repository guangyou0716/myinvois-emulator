export const COLLECTION_URL: string;
export const PINNED_SHA256: string;
export const CLOCK_ADVANCE_NAME: string;
export const CLOCK_ADVANCE_MS: number;

export const SYNTHETIC: {
  taxpayerClientId: string;
  taxpayerClientSecret: string;
  intermediaryClientId: string;
  intermediaryClientSecret: string;
  tin: string;
  idType: string;
  idValue: string;
  codeNumber: string;
  format: string;
};

export interface InScopeRequest {
  name: string;
  expectedStatus: number;
  capture?: 'token' | 'submission';
  note?: string;
}

export interface SkippedRequest {
  name: string;
  reason: string;
}

export const IN_SCOPE: readonly InScopeRequest[];
export const SKIPPED: readonly SkippedRequest[];

export interface TransformOptions {
  baseUrl: string;
  documentBase64: string;
  documentHash: string;
  format?: string;
  codeNumber?: string;
  taxpayerClientId?: string;
  taxpayerClientSecret?: string;
  intermediaryClientId?: string;
  intermediaryClientSecret?: string;
  tin?: string;
  idType?: string;
  idValue?: string;
}

export interface TransformResult {
  collection: {
    info: Record<string, unknown>;
    variable: Array<{ key: string; value: string }>;
    item: unknown[];
  };
  inScope: Array<{ name: string; expectedStatus: number; note?: string }>;
  skipped: Array<{ name: string; reason: string; present: boolean }>;
  helper: { name: string; expectedStatus: number };
}

export function sha256Hex(data: string | Buffer | Uint8Array): string;
export function assertPinnedSha256(bytes: string | Buffer | Uint8Array, expected?: string): string;
export function listRequestNames(collection: unknown): string[];
export function findMissingInScope(collection: unknown): string[];
export function transformCollection(collection: unknown, options: TransformOptions): TransformResult;

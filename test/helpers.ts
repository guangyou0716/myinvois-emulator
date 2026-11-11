import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { sha256Hex } from '../src/hash.js';
import { createEmulator, type Emulator } from '../src/emulator.js';
import type { RateLimitOptions } from '../src/rate-limit.js';

export function samplePath(name: string): string {
  return fileURLToPath(new URL(`../fixtures/samples/${name}`, import.meta.url));
}

export function readSample(name: string): Buffer {
  return readFileSync(samplePath(name));
}

export function minimalInvoice(supplierTin: string, buyerTin: string, id = 'INV-1'): string {
  return JSON.stringify({
    Invoice: [
      {
        ID: [{ _: id }],
        AccountingSupplierParty: [
          {
            Party: [
              {
                PartyIdentification: [{ ID: [{ _: supplierTin, schemeID: 'TIN' }] }],
              },
            ],
          },
        ],
        AccountingCustomerParty: [
          {
            Party: [
              {
                PartyIdentification: [{ ID: [{ _: buyerTin, schemeID: 'TIN' }] }],
              },
            ],
          },
        ],
      },
    ],
  });
}

export function encodeDocument(
  content: string | Buffer,
  format: 'JSON' | 'XML',
  codeNumber: string,
  documentHash?: string,
): { format: 'JSON' | 'XML'; document: string; documentHash: string; codeNumber: string } {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return {
    format,
    document: bytes.toString('base64'),
    documentHash: documentHash ?? sha256Hex(bytes),
    codeNumber,
  };
}

export async function startServer(options?: {
  clock?: 'fake' | 'real';
  seed?: number;
  rateLimit?: RateLimitOptions;
}): Promise<{
  emulator: Emulator;
  base: string;
}> {
  const emulator = createEmulator({
    clock: options?.clock ?? 'fake',
    seed: options?.seed ?? 42,
    host: '127.0.0.1',
    rateLimit: options?.rateLimit,
  });
  const info = await emulator.start({ port: 0, host: '127.0.0.1' });
  if (!info.url.startsWith('http://127.0.0.1:')) {
    await emulator.stop();
    throw new Error(`refusing non-loopback server URL ${info.url}`);
  }
  return { emulator, base: info.url };
}

export function assertCorrelation(res: Response): void {
  expect(res.headers.get('correlationid')).toMatch(/^[A-Z0-9]{26}$/);
}

export interface ApiErrorBody {
  error: {
    propertyName: string | null;
    propertyPath: string | null;
    errorCode: string;
    error: string;
    errorMS: string;
    target: string | null;
    innerError: unknown;
  };
}

export async function expectError(res: Response, status: number, errorCode: string): Promise<ApiErrorBody['error']> {
  assertCorrelation(res);
  expect(res.status).toBe(status);
  const body = (await res.json()) as ApiErrorBody;
  expect(body.error.errorCode).toBe(errorCode);
  expect(body.error.error.length).toBeGreaterThan(0);
  expect(body.error.errorMS.length).toBeGreaterThan(0);
  expect(body.error).toHaveProperty('propertyName');
  expect(body.error).toHaveProperty('propertyPath');
  expect(body.error).toHaveProperty('target');
  expect(body.error).toHaveProperty('innerError');
  return body.error;
}

export async function login(base: string, clientId: string, clientSecret: string): Promise<string> {
  const res = await fetch(`${base}/connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'InvoicingAPI',
    }),
  });
  assertCorrelation(res);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { access_token: string; token_type: string; expires_in: number; scope: string };
  expect(body.token_type).toBe('Bearer');
  expect(body.expires_in).toBe(3600);
  expect(body.scope).toBe('InvoicingAPI');
  expect(body.access_token).toMatch(/^[A-Z0-9]{26}$/);
  return body.access_token;
}

export function authHeaders(token: string, json = false): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (json) headers['content-type'] = 'application/json';
  return headers;
}

export async function advance(base: string, ms: number): Promise<void> {
  const res = await fetch(`${base}/_emulator/clock/advance`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ms }),
  });
  assertCorrelation(res);
  expect(res.status).toBe(200);
}

export async function submitRaw(base: string, token: string, raw: string): Promise<Response> {
  return fetch(`${base}/api/v1.0/documentsubmissions/`, {
    method: 'POST',
    headers: authHeaders(token, true),
    body: raw,
  });
}

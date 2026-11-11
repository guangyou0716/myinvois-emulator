import { readFileSync } from 'node:fs';
import { REDACTED, redactJson, type RecordEntry } from './record.js';

/** One recorded exchange whose replayed outcome differed. */
export interface ReplayMismatch {
  seq: number;
  method: string;
  target: string;
  /** What differed: status, body, or a request that could not be replayed. */
  kind: 'status' | 'body' | 'skipped';
  expected: string;
  actual: string;
}

export interface ReplayResult {
  total: number;
  matched: number;
  mismatches: ReplayMismatch[];
}

export interface ReplayOptions {
  /** Base URL of a fresh emulator started with the same seed, clock mode, config and faults. */
  baseUrl: string;
  /** client_id -> client_secret, used where the recording has `[redacted]`. */
  secrets: Readonly<Record<string, string>>;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

export class RecordingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordingError';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/** Parses a `--record` JSONL file body. Blank lines are ignored; anything malformed throws. */
export function parseRecording(text: string): RecordEntry[] {
  const entries: RecordEntry[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').trim();
    if (line === '') continue;
    const where = `line ${index + 1}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new RecordingError(`${where}: not valid JSON`);
    }
    if (!isObject(parsed)) throw new RecordingError(`${where}: expected a JSON object`);
    const { seq, at, method, target, requestHeaders, requestBody, status, responseBody } = parsed;
    const authFrom = parsed.authFrom ?? null;
    if (typeof seq !== 'number' || !Number.isInteger(seq)) throw new RecordingError(`${where}: seq must be an integer`);
    if (typeof at !== 'string') throw new RecordingError(`${where}: at must be a string`);
    if (typeof method !== 'string' || method === '') throw new RecordingError(`${where}: method must be a string`);
    if (typeof target !== 'string' || !target.startsWith('/')) {
      throw new RecordingError(`${where}: target must be a path starting with /`);
    }
    if (!isObject(requestHeaders) || !Object.values(requestHeaders).every((v) => typeof v === 'string')) {
      throw new RecordingError(`${where}: requestHeaders must map names to strings`);
    }
    if (!nullableString(requestBody)) throw new RecordingError(`${where}: requestBody must be a string or null`);
    if (status !== null && (typeof status !== 'number' || !Number.isInteger(status))) {
      throw new RecordingError(`${where}: status must be an integer or null`);
    }
    if (!nullableString(responseBody)) throw new RecordingError(`${where}: responseBody must be a string or null`);
    if (authFrom !== null && (typeof authFrom !== 'number' || !Number.isInteger(authFrom))) {
      throw new RecordingError(`${where}: authFrom must be an integer or null`);
    }
    entries.push({
      seq,
      at,
      method,
      target,
      requestHeaders: requestHeaders as Record<string, string>,
      requestBody,
      status,
      responseBody,
      authFrom,
    });
  }
  return entries;
}

export function loadRecordingFile(path: string): RecordEntry[] {
  return parseRecording(readFileSync(path, 'utf8'));
}

function isTokenRequest(entry: RecordEntry): boolean {
  return entry.method === 'POST' && /^\/connect\/token\/?(\?|$)/.test(entry.target);
}

/** Puts the real secret back into a redacted token request. Returns null when no secret is known. */
function restoreSecret(entry: RecordEntry, secrets: Readonly<Record<string, string>>): string | null | undefined {
  const body = entry.requestBody;
  if (body === null) return body;
  const contentType = entry.requestHeaders['content-type'] ?? '';
  if (!contentType.includes('application/x-www-form-urlencoded')) return body;
  const form = new URLSearchParams(body);
  if (form.get('client_secret') !== REDACTED) return body;
  const clientId = form.get('client_id') ?? '';
  const secret = Object.hasOwn(secrets, clientId) ? secrets[clientId] : undefined;
  if (secret === undefined) return undefined;
  form.set('client_secret', secret);
  return form.toString();
}

function accessToken(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isObject(parsed) && typeof parsed.access_token === 'string') return parsed.access_token;
  } catch {
    return null;
  }
  return null;
}

/**
 * Sends each recorded request, in `seq` order, to `baseUrl` and compares the status and the
 * redacted response body with the recording. Requests that sent a token issued during the
 * recording get the matching fresh token. Stops at nothing: every entry is replayed once.
 */
export async function replayRecording(entries: readonly RecordEntry[], options: ReplayOptions): Promise<ReplayResult> {
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, '');
  const freshTokens = new Map<number, string>();
  const mismatches: ReplayMismatch[] = [];
  const ordered = [...entries].sort((a, b) => a.seq - b.seq);

  for (const entry of ordered) {
    const mismatch = (kind: ReplayMismatch['kind'], expected: string, actual: string) => {
      mismatches.push({
        seq: entry.seq,
        method: entry.method,
        target: entry.target,
        kind,
        expected,
        actual,
      });
    };

    let body: string | null | undefined = entry.requestBody;
    if (isTokenRequest(entry)) {
      body = restoreSecret(entry, options.secrets);
      if (body === undefined) {
        const clientId = new URLSearchParams(entry.requestBody ?? '').get('client_id') ?? '';
        mismatch('skipped', 'a client_secret to replay the token request', `no secret for client_id ${clientId}`);
        continue;
      }
    }

    const headers: Record<string, string> = { ...entry.requestHeaders };
    if (entry.authFrom !== null) {
      const token = freshTokens.get(entry.authFrom);
      if (token === undefined) {
        mismatch('skipped', `a fresh token from seq ${entry.authFrom}`, 'that token request was not replayed');
        continue;
      }
      headers.authorization = `Bearer ${token}`;
    }

    let status: number | null;
    let text: string | null;
    try {
      const response = await doFetch(`${base}${entry.target}`, {
        method: entry.method,
        headers,
        body: body === null || entry.method === 'GET' || entry.method === 'HEAD' ? undefined : body,
      });
      status = response.status;
      const raw = await response.text();
      text = raw === '' ? null : raw;
    } catch {
      status = null;
      text = null;
    }

    if (status === 200 && text !== null && isTokenRequest(entry)) {
      const token = accessToken(text);
      if (token !== null) freshTokens.set(entry.seq, token);
    }

    if (status !== entry.status) {
      mismatch('status', String(entry.status), String(status));
      continue;
    }
    const actualBody = text === null ? null : redactJson(text);
    if (actualBody !== entry.responseBody) {
      mismatch('body', entry.responseBody ?? 'null', actualBody ?? 'null');
    }
  }

  return {
    total: ordered.length,
    matched: ordered.length - mismatches.length,
    mismatches,
  };
}

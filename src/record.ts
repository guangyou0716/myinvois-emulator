import { appendFileSync } from 'node:fs';

/** One recorded exchange. Secrets are replaced with `[redacted]`; Authorization is never stored. */
export interface RecordEntry {
  seq: number;
  /** Emulator clock time when the response finished, ISO 8601. */
  at: string;
  method: string;
  /** Raw request target, including the query string. */
  target: string;
  /** Request headers worth replaying: content-type and onbehalfof. */
  requestHeaders: Record<string, string>;
  /** UTF-8 request body, or null when the handler did not read one. */
  requestBody: string | null;
  /** HTTP status, or null when the connection was dropped (for example a `reset` fault). */
  status: number | null;
  /** UTF-8 response body, or null when there was none. */
  responseBody: string | null;
  /**
   * `seq` of the recorded `/connect/token` response that issued the bearer token this request
   * sent, or null when it sent none or a token not issued during this recording. The token
   * itself is never stored; replay uses this to send the matching fresh token.
   */
  authFrom: number | null;
}

export type Recorder = (entry: RecordEntry) => void;

export const REDACTED = '[redacted]';

const SECRET_FORM_FIELDS = new Set(['client_secret']);
const SECRET_JSON_FIELDS = new Set(['access_token', 'client_secret']);

/** Redacts secret fields in an x-www-form-urlencoded body. Leaves other text untouched. */
export function redactForm(body: string): string {
  const params = new URLSearchParams(body);
  let changed = false;
  for (const key of SECRET_FORM_FIELDS) {
    if (params.has(key)) {
      params.set(key, REDACTED);
      changed = true;
    }
  }
  return changed ? params.toString() : body;
}

/** Redacts top-level secret fields in a JSON object body. Non-JSON text is returned unchanged. */
export function redactJson(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return body;
  const record = parsed as Record<string, unknown>;
  let changed = false;
  for (const key of SECRET_JSON_FIELDS) {
    if (key in record) {
      record[key] = REDACTED;
      changed = true;
    }
  }
  return changed ? JSON.stringify(record) : body;
}

/**
 * Appends one JSON line per entry to `path`. Fails early when the file cannot be opened
 * for append. Writes are synchronous so lines keep request-finish order.
 */
export function createJsonlRecorder(path: string): Recorder {
  appendFileSync(path, '');
  return (entry) => {
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
  };
}

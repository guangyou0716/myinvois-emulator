import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Emulator } from '../src/emulator.js';
import { createJsonlRecorder, redactForm, redactJson, REDACTED, type RecordEntry } from '../src/record.js';
import { run } from '../src/cli.js';
import { authHeaders, login, startServer } from './helpers.js';

describe('redaction helpers', () => {
  it('redacts client_secret in a form body and keeps other fields', () => {
    const out = new URLSearchParams(redactForm('grant_type=client_credentials&client_id=a&client_secret=s3cret'));
    expect(out.get('client_secret')).toBe(REDACTED);
    expect(out.get('client_id')).toBe('a');
    expect(redactForm('client_id=a')).toBe('client_id=a');
  });

  it('redacts top-level access_token / client_secret in JSON and leaves other text alone', () => {
    expect(JSON.parse(redactJson('{"access_token":"T","expires_in":3600}'))).toEqual({
      access_token: REDACTED,
      expires_in: 3600,
    });
    expect(redactJson('{"a":1}')).toBe('{"a":1}');
    expect(redactJson('not json')).toBe('not json');
    expect(redactJson('[1,2]')).toBe('[1,2]');
  });
});

describe('recorder', () => {
  let emulator: Emulator | null = null;
  let dir: string | null = null;

  afterEach(async () => {
    if (emulator) await emulator.stop();
    emulator = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('records each exchange in order with secrets redacted and no Authorization header', async () => {
    const entries: RecordEntry[] = [];
    const started = await startServer({ rateLimit: { enabled: false }, record: (e) => entries.push(e) });
    emulator = started.emulator;
    const token = await login(started.base, 'sample-supplier', 'sample-supplier-secret');
    const tin = await fetch(`${started.base}/api/v1.0/taxpayer/validate/C1?idType=BRN&idValue=X`, {
      headers: authHeaders(token),
    });
    await tin.arrayBuffer();
    await fetch(`${started.base}/_emulator/health`).then((r) => r.arrayBuffer());

    await expect.poll(() => entries.length).toBe(3);
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);

    const [tokenEntry, tinEntry, healthEntry] = entries as [RecordEntry, RecordEntry, RecordEntry];
    expect(tokenEntry.method).toBe('POST');
    expect(tokenEntry.target).toBe('/connect/token');
    expect(tokenEntry.status).toBe(200);
    expect(tokenEntry.requestHeaders['content-type']).toContain('application/x-www-form-urlencoded');
    const form = new URLSearchParams(tokenEntry.requestBody ?? '');
    expect(form.get('client_id')).toBe('sample-supplier');
    expect(form.get('client_secret')).toBe(REDACTED);
    const tokenBody = JSON.parse(tokenEntry.responseBody ?? '{}') as Record<string, unknown>;
    expect(tokenBody.access_token).toBe(REDACTED);
    expect(tokenBody.token_type).toBe('Bearer');

    expect(tinEntry.method).toBe('GET');
    expect(tinEntry.target).toBe('/api/v1.0/taxpayer/validate/C1?idType=BRN&idValue=X');
    expect(tinEntry.status).toBe(tin.status);
    expect(tinEntry.requestBody).toBeNull();
    expect(JSON.stringify(entries)).not.toContain(token);
    expect(JSON.stringify(entries)).not.toContain('sample-supplier-secret');
    expect(Object.keys(tinEntry.requestHeaders)).not.toContain('authorization');

    expect(healthEntry.target).toBe('/_emulator/health');
    expect(healthEntry.status).toBe(200);
    expect(new Date(healthEntry.at).toISOString()).toBe(healthEntry.at);
  });

  it('records a reset fault as a dropped exchange with null status', async () => {
    const entries: RecordEntry[] = [];
    const started = await startServer({
      faults: [{ endpoint: 'token', kind: 'reset', probability: 1 }],
      record: (e) => entries.push(e),
    });
    emulator = started.emulator;
    await expect(
      fetch(`${started.base}/connect/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials&client_id=x&client_secret=y',
      }),
    ).rejects.toThrow();
    await expect.poll(() => entries.length).toBe(1);
    expect(entries[0]?.status).toBeNull();
    expect(entries[0]?.responseBody).toBeNull();
  });

  it('reports a throwing recorder through onError and still answers', async () => {
    const errors: unknown[] = [];
    const { createEmulator } = await import('../src/emulator.js');
    emulator = createEmulator({
      clock: 'fake',
      record: () => {
        throw new Error('disk full');
      },
      onError: (e) => errors.push(e),
    });
    const info = await emulator.start({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`${info.url}/_emulator/health`);
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    await expect.poll(() => errors.length).toBe(1);
    expect(String(errors[0])).toContain('disk full');
  });

  it('createJsonlRecorder appends one JSON line per entry', () => {
    dir = mkdtempSync(join(tmpdir(), 'emu-record-'));
    const path = join(dir, 'log.jsonl');
    const recorder = createJsonlRecorder(path);
    const entry: RecordEntry = {
      seq: 1,
      at: '2026-01-01T00:00:00.000Z',
      method: 'GET',
      target: '/x',
      requestHeaders: {},
      requestBody: null,
      status: 404,
      responseBody: null,
    };
    recorder(entry);
    recorder({ ...entry, seq: 2 });
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
    expect(lines.map((l) => (JSON.parse(l) as RecordEntry).seq)).toEqual([1, 2]);
  });

  it('createJsonlRecorder fails early on an unwritable path', () => {
    expect(() => createJsonlRecorder(join(tmpdir(), 'no-such-dir-emu', 'x', 'log.jsonl'))).toThrow();
  });

  it('CLI rejects --record without a value and an unwritable --record path', async () => {
    const err: string[] = [];
    const io = { stdout: () => undefined, stderr: (t: string) => err.push(t) };
    expect(await run(['start', '--record'], io)).toBe(2);
    expect(err.join('')).toContain('--record requires a value');
    err.length = 0;
    expect(await run(['start', '--record', join(tmpdir(), 'no-such-dir-emu', 'x', 'log.jsonl')], io)).toBe(2);
    expect(err.join('')).toContain('--record:');
  });
});

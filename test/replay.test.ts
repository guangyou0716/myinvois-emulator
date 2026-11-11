import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import type { Emulator } from '../src/emulator.js';
import type { FaultRule } from '../src/faults.js';
import type { RecordEntry } from '../src/record.js';
import { parseRecording, RecordingError, replayRecording } from '../src/replay.js';
import { advance, authHeaders, encodeDocument, login, minimalInvoice, startServer, submitRaw } from './helpers.js';

const SECRETS = {
  'supplier-a': 'supplier-a-secret',
  'buyer-a': 'buyer-a-secret',
};

let running: Emulator[] = [];
let dir: string | null = null;

afterEach(async () => {
  await Promise.all(running.map((e) => e.stop()));
  running = [];
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

async function server(
  options: {
    seed?: number;
    faults?: FaultRule[];
    record?: (e: RecordEntry) => void;
  } = {},
) {
  const started = await startServer({
    rateLimit: { enabled: false },
    ...options,
  });
  running.push(started.emulator);
  return started.base;
}

/** Records a two-client session: logins, a submission, a clock advance, reads and a 401. */
async function recordSession(seed = 42): Promise<RecordEntry[]> {
  const entries: RecordEntry[] = [];
  const base = await server({ seed, record: (e) => entries.push(e) });
  const supplier = await login(base, 'supplier-a', 'supplier-a-secret');
  const buyer = await login(base, 'buyer-a', 'buyer-a-secret');
  const doc = encodeDocument(minimalInvoice('C00000000000', 'IG00000000000', 'INV-R1'), 'JSON', 'INV-R1');
  const submit = await submitRaw(base, supplier, JSON.stringify({ documents: [doc] }));
  expect(submit.status).toBe(202);
  const { submissionUid } = (await submit.json()) as { submissionUid: string };
  await advance(base, 5_000);
  await fetch(`${base}/api/v1.0/documentsubmissions/${submissionUid}`, {
    headers: authHeaders(supplier),
  }).then((r) => r.arrayBuffer());
  await fetch(`${base}/api/v1.0/documents/recent`, {
    headers: authHeaders(buyer),
  }).then((r) => r.arrayBuffer());
  await fetch(`${base}/api/v1.0/documents/recent`, {
    headers: authHeaders('not-a-token'),
  }).then((r) => r.arrayBuffer());
  await expect.poll(() => entries.length).toBe(7);
  return entries;
}

describe('recorder authFrom', () => {
  it('links each authenticated request to the token response that issued its bearer token', async () => {
    const entries = await recordSession();
    const bySeq = new Map(entries.map((e) => [e.seq, e]));
    const supplierTokenSeq = entries.find((e) => e.requestBody?.includes('client_id=supplier-a'))?.seq;
    const buyerTokenSeq = entries.find((e) => e.requestBody?.includes('client_id=buyer-a'))?.seq;
    expect(supplierTokenSeq).toBeDefined();
    expect(buyerTokenSeq).toBeDefined();
    const submit = entries.find((e) => e.method === 'POST' && e.target.startsWith('/api/v1.0/documentsubmissions'));
    expect(submit?.authFrom).toBe(supplierTokenSeq);
    const recent = entries.filter((e) => e.target === '/api/v1.0/documents/recent');
    expect(recent.map((e) => e.authFrom)).toEqual([buyerTokenSeq, null]);
    expect(recent[1]?.status).toBe(401);
    expect(bySeq.get(supplierTokenSeq ?? -1)?.authFrom).toBeNull();
    expect(entries.find((e) => e.target === '/_emulator/clock/advance')?.authFrom).toBeNull();
  });
});

describe('replayRecording', () => {
  it('matches every exchange against a fresh emulator with the same seed and fake clock', async () => {
    const entries = await recordSession();
    const target = await server({ seed: 42 });
    const result = await replayRecording(entries, {
      baseUrl: target,
      secrets: SECRETS,
    });
    expect(result.mismatches).toEqual([]);
    expect(result).toMatchObject({ total: 7, matched: 7 });
  });

  it('reports body mismatches against a different seed', async () => {
    const entries = await recordSession();
    const target = await server({ seed: 43 });
    const result = await replayRecording(entries, {
      baseUrl: `${target}/`,
      secrets: SECRETS,
    });
    expect(result.matched).toBeLessThan(result.total);
    expect(result.mismatches.some((m) => m.kind === 'body')).toBe(true);
    expect(result.mismatches.every((m) => m.kind !== 'skipped')).toBe(true);
  });

  it('skips a token request with no known secret and every request that depended on it', async () => {
    const entries = await recordSession();
    const target = await server({ seed: 42 });
    const result = await replayRecording(entries, {
      baseUrl: target,
      secrets: { 'buyer-a': 'buyer-a-secret' },
    });
    const skipped = result.mismatches.filter((m) => m.kind === 'skipped');
    expect(skipped.map((m) => m.target)).toEqual([
      '/connect/token',
      '/api/v1.0/documentsubmissions/',
      expect.stringMatching(/^\/api\/v1\.0\/documentsubmissions\/.+/),
    ]);
    expect(skipped[0]?.actual).toContain('supplier-a');
    expect(skipped[0]?.actual).not.toContain('secret-');
  });

  it('treats a dropped connection as matching a recorded dropped connection', async () => {
    const faults: FaultRule[] = [{ endpoint: 'token', kind: 'reset', probability: 1 }];
    const entries: RecordEntry[] = [];
    const base = await server({ faults, record: (e) => entries.push(e) });
    await expect(
      fetch(`${base}/connect/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials&client_id=supplier-a&client_secret=supplier-a-secret',
      }),
    ).rejects.toThrow();
    await expect.poll(() => entries.length).toBe(1);

    const same = await replayRecording(entries, {
      baseUrl: await server({ faults }),
      secrets: SECRETS,
    });
    expect(same.mismatches).toEqual([]);
    const healthy = await replayRecording(entries, {
      baseUrl: await server(),
      secrets: SECRETS,
    });
    // The reset happened before the body was read, so none was recorded; a healthy target answers instead.
    expect(healthy.mismatches).toMatchObject([{ kind: 'status', expected: 'null' }]);
    expect(healthy.mismatches[0]?.actual).toMatch(/^\d{3}$/);
  });

  it('never sends the redacted placeholder as a secret', async () => {
    const sent: string[] = [];
    const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      sent.push(String(init?.body ?? ''));
      return new Response('{"access_token":"T"}', { status: 200 });
    }) as typeof fetch;
    const entries = parseRecording(
      JSON.stringify({
        seq: 1,
        at: '2026-01-01T00:00:00.000Z',
        method: 'POST',
        target: '/connect/token',
        requestHeaders: { 'content-type': 'application/x-www-form-urlencoded' },
        requestBody: 'grant_type=client_credentials&client_id=supplier-a&client_secret=%5Bredacted%5D',
        status: 200,
        responseBody: '{"access_token":"[redacted]"}',
        authFrom: null,
      }),
    );
    const result = await replayRecording(entries, {
      baseUrl: 'http://127.0.0.1:1',
      secrets: SECRETS,
      fetch: fakeFetch,
    });
    expect(result.mismatches).toEqual([]);
    expect(new URLSearchParams(sent[0]).get('client_secret')).toBe('supplier-a-secret');
  });
});

describe('parseRecording', () => {
  const valid = {
    seq: 1,
    at: '2026-01-01T00:00:00.000Z',
    method: 'GET',
    target: '/_emulator/health',
    requestHeaders: {},
    requestBody: null,
    status: 200,
    responseBody: '{}',
  };

  it('accepts lines without authFrom (recordings from before this field) and skips blank lines', () => {
    const entries = parseRecording(
      `${JSON.stringify(valid)}\n\n${JSON.stringify({ ...valid, seq: 2, authFrom: 1 })}\n`,
    );
    expect(entries.map((e) => [e.seq, e.authFrom])).toEqual([
      [1, null],
      [2, 1],
    ]);
  });

  it.each([
    ['not json', 'line 1: not valid JSON'],
    ['[]', 'line 1: expected a JSON object'],
    [JSON.stringify({ ...valid, seq: 'x' }), 'seq must be an integer'],
    [JSON.stringify({ ...valid, target: 'http://evil/' }), 'target must be a path'],
    [JSON.stringify({ ...valid, requestHeaders: { a: 1 } }), 'requestHeaders'],
    [JSON.stringify({ ...valid, status: '200' }), 'status must be an integer or null'],
    [JSON.stringify({ ...valid, authFrom: 'x' }), 'authFrom'],
  ])('rejects %s', (line, message) => {
    expect(() => parseRecording(line)).toThrow(RecordingError);
    expect(() => parseRecording(line)).toThrow(message);
  });
});

describe('cli replay', () => {
  function io() {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      io: {
        stdout: (t: string) => out.push(t),
        stderr: (t: string) => err.push(t),
      },
    };
  }

  it('exits 0 when every exchange matches and 1 when some differ', async () => {
    const entries = await recordSession();
    dir = mkdtempSync(join(tmpdir(), 'emu-replay-'));
    const file = join(dir, 'session.jsonl');
    writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n'));

    const ok = io();
    expect(await run(['replay', file, '--target', await server({ seed: 42 })], ok.io)).toBe(0);
    expect(ok.out.join('')).toContain('replay: 7/7 matched');

    const bad = io();
    expect(await run(['replay', file, '--target', await server({ seed: 43 })], bad.io)).toBe(1);
    expect(bad.out.join('')).toMatch(/seq \d+ \S+ \S+: body expected/);
  });

  it.each([
    [['replay'], 'replay needs a recording file'],
    [['replay', 'x.jsonl'], 'replay needs --target'],
    [['replay', 'x.jsonl', '--target', 'ftp://h'], '--target must be an http(s) URL'],
    [['replay', 'x.jsonl', '--target', 'http://h', '--port', '1'], 'Unknown option for replay: --port'],
    [['replay', 'a', 'b', '--target', 'http://h'], 'Unexpected argument: b'],
  ])('rejects %j with exit 2', async (argv, message) => {
    const r = io();
    expect(await run(argv, r.io)).toBe(2);
    expect(r.err.join('')).toContain(message);
  });

  it('exits 2 for a missing recording file', async () => {
    const r = io();
    expect(await run(['replay', '/nonexistent/x.jsonl', '--target', 'http://127.0.0.1:1'], r.io)).toBe(2);
    expect(r.err.join('')).toContain('ENOENT');
  });
});

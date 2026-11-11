import { afterEach, describe, expect, it } from 'vitest';
import { FAKE_CLOCK_START_MS, RATE_LIMIT_WINDOW_MS } from '../src/constants.js';
import { defaultConfig } from '../src/defaults.js';
import { createEmulator, type Emulator } from '../src/emulator.js';
import { FaultError, FaultInjector, parseFaults, type FaultRule } from '../src/faults.js';
import {
  assertCorrelation,
  encodeDocument,
  expectError,
  login,
  minimalInvoice,
  startServer,
  submitRaw,
} from './helpers.js';

const tenants = defaultConfig().tenants ?? [];
const foundSupplier = tenants.find((tenant) => tenant.clientId === 'sample-supplier');
const foundBuyer = tenants.find((tenant) => tenant.clientId === 'sample-buyer');
if (!foundSupplier || !foundBuyer) throw new Error('built-in sample tenants are missing');
const supplier = foundSupplier;
const buyer = foundBuyer;

function tokenBody(): URLSearchParams {
  return new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: supplier.clientId,
    client_secret: supplier.clientSecret,
    scope: 'InvoicingAPI',
  });
}

async function tokenRequest(base: string): Promise<Response> {
  return fetch(`${base}/connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: tokenBody(),
  });
}

describe('parseFaults', () => {
  it('accepts an array and a { faults } object', () => {
    const rule: FaultRule = { endpoint: 'token', kind: 'error500', probability: 1 };
    expect(parseFaults([rule])).toEqual([rule]);
    expect(parseFaults({ faults: [rule] })).toEqual([rule]);
  });

  it('rejects rules that are missing a trigger or use an unknown endpoint', () => {
    expect(() => parseFaults([{ endpoint: 'token', kind: 'error500' }])).toThrow(FaultError);
    expect(() => parseFaults([{ endpoint: 'nope', kind: 'error500', probability: 1 }])).toThrow(/endpoint/);
    expect(() => parseFaults([{ endpoint: 'token', kind: 'latency', probability: 1 }])).toThrow(/latencyMs/);
    expect(() => parseFaults([{ endpoint: 'token', kind: 'error500', probability: 1.2 }])).toThrow(/probability/);
    expect(() => parseFaults([{ endpoint: 'token', kind: 'error500', nth: [] }])).toThrow(/nth/);
    expect(() => parseFaults([{ endpoint: 'token', kind: 'error500', nth: [0] }])).toThrow(/nth/);
    expect(() =>
      parseFaults([{ endpoint: 'token', kind: 'error500', probability: 1, latencyMs: 10 }]),
    ).toThrow(/latencyMs is only valid/);
  });
});

describe('FaultInjector', () => {
  it('fires error500 on the 2nd submit and leaves other counts independent', () => {
    const injector = new FaultInjector(1, [{ endpoint: 'submit', kind: 'error500', nth: [2] }]);
    expect(injector.evaluate('submit').kind).toBe('none');
    expect(injector.evaluate('submit').kind).toBe('error500');
    expect(injector.evaluate('submit').kind).toBe('none');
    expect(injector.evaluate('token').kind).toBe('none');
  });

  it('accumulates matching latency then applies the first non-latency fault', () => {
    const injector = new FaultInjector(1, [
      { endpoint: '*', kind: 'latency', latencyMs: 10, probability: 1 },
      { endpoint: '*', kind: 'latency', latencyMs: 15, probability: 1 },
      { endpoint: '*', kind: 'error500', probability: 1 },
    ]);
    expect(injector.evaluate('token')).toEqual({ delayMs: 25, kind: 'error500', retryAfterSeconds: 0 });
  });

  it('is deterministic for a seed and differs when the seed differs', () => {
    const rule: FaultRule[] = [{ endpoint: '*', kind: 'error500', probability: 0.5 }];
    const left = new FaultInjector(7, rule);
    const right = new FaultInjector(7, rule);
    const other = new FaultInjector(8, rule);
    const seq = (injector: FaultInjector) =>
      Array.from({ length: 50 }, () => injector.evaluate('token').kind === 'error500');
    const a = seq(left);
    expect(seq(right)).toEqual(a);
    expect(seq(other)).not.toEqual(a);
  });

  it('mixes both 32-bit halves so probability sequences for seeds 2^32 apart differ', () => {
    const rule: FaultRule[] = [{ endpoint: '*', kind: 'error500', probability: 0.5 }];
    const seq = (seed: number) => {
      const injector = new FaultInjector(seed, rule);
      return Array.from({ length: 50 }, () => injector.evaluate('token').kind === 'error500');
    };
    const low = seq(1);
    const high = seq(1 + 2 ** 32);
    expect(high).not.toEqual(low);
    expect(seq(1 + 2 ** 32)).toEqual(high);
  });
});

describe('http fault injection', () => {
  let emulator: Emulator;
  let base: string;

  afterEach(async () => {
    if (emulator) await emulator.stop();
  });

  it('returns 500 SystemError on the 2nd submit and 202 on the 1st and 3rd', async () => {
    const started = await startServer({
      rateLimit: { enabled: false },
      faults: [{ endpoint: 'submit', kind: 'error500', nth: [2] }],
    });
    emulator = started.emulator;
    base = started.base;
    const token = await login(base, supplier.clientId, supplier.clientSecret);

    const statuses: number[] = [];
    for (let index = 1; index <= 3; index += 1) {
      const res = await submitRaw(
        base,
        token,
        JSON.stringify({
          documents: [encodeDocument(minimalInvoice(supplier.tin, buyer.tin, `INV-${index}`), 'JSON', `NTH-${index}`)],
        }),
      );
      statuses.push(res.status);
      if (index === 2) {
        const error = await expectError(res, 500, 'SystemError');
        expect(error.error.length).toBeGreaterThan(0);
        expect(error.errorMS.length).toBeGreaterThan(0);
      } else {
        assertCorrelation(res);
        expect(res.status).toBe(202);
      }
    }
    expect(statuses).toEqual([202, 500, 202]);
  });

  it('replays the same probability sequence for a seed and differs for another seed', async () => {
    const rule: FaultRule[] = [{ endpoint: 'token', kind: 'error500', probability: 0.5 }];
    const statusesOf = async (seed: number): Promise<number[]> => {
      const started = await startServer({ seed, rateLimit: { enabled: false }, faults: rule });
      try {
        const out: number[] = [];
        for (let i = 0; i < 50; i += 1) {
          out.push((await tokenRequest(started.base)).status);
        }
        return out;
      } finally {
        await started.emulator.stop();
      }
    };

    const first = await statusesOf(11);
    const replay = await statusesOf(11);
    const other = await statusesOf(12);
    expect(replay).toEqual(first);
    expect(other).not.toEqual(first);
    expect(first.some((status) => status === 500)).toBe(true);
    expect(first.some((status) => status === 200)).toBe(true);
  });

  it('returns rate-limit 429 headers without consuming the real counters', async () => {
    const started = await startServer({
      faults: [{ endpoint: 'token', kind: 'rateLimit429', probability: 1, retryAfterSeconds: 15 }],
    });
    emulator = started.emulator;
    base = started.base;

    const resetIso = new Date(FAKE_CLOCK_START_MS + RATE_LIMIT_WINDOW_MS).toISOString();
    const limited = await tokenRequest(base);
    const error = await expectError(limited, 429, 'RateLimitExceeded');
    expect(error.errorMS.length).toBeGreaterThan(0);
    expect(limited.headers.get('retry-after')).toBe('15');
    expect(limited.headers.get('x-rate-limit-limit')).toBe('12');
    expect(limited.headers.get('x-rate-limit-remaining')).toBe('0');
    expect(limited.headers.get('x-rate-limit-reset')).toBe(resetIso);

    const clear = await fetch(`${base}/_emulator/faults`, { method: 'DELETE' });
    expect(clear.status).toBe(200);
    const ok = await tokenRequest(base);
    assertCorrelation(ok);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-rate-limit-remaining')).toBe('11');
  });

  it('delays a normal response by at least latencyMs on the real clock', async () => {
    const started = await startServer({
      faults: [{ endpoint: 'token', kind: 'latency', latencyMs: 50, probability: 1 }],
    });
    emulator = started.emulator;
    base = started.base;
    const startedAt = Date.now();
    const res = await tokenRequest(base);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50);
    assertCorrelation(res);
    expect(res.status).toBe(200);
  });

  it('destroys the socket on a reset fault', async () => {
    const started = await startServer({
      faults: [{ endpoint: 'token', kind: 'reset', probability: 1 }],
    });
    emulator = started.emulator;
    base = started.base;
    await expect(tokenRequest(base)).rejects.toThrow();
    const health = await fetch(`${base}/_emulator/health`);
    expect(health.status).toBe(200);
  });

  it('serves POST/GET/DELETE /_emulator/faults and never faults control routes', async () => {
    const started = await startServer({ rateLimit: { enabled: false } });
    emulator = started.emulator;
    base = started.base;

    const empty = await fetch(`${base}/_emulator/faults`);
    assertCorrelation(empty);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ faults: [] });

    const posted = await fetch(`${base}/_emulator/faults`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ endpoint: '*', kind: 'error500', nth: [1] }]),
    });
    expect(posted.status).toBe(200);
    expect(await posted.json()).toEqual({ faults: [{ endpoint: '*', kind: 'error500', nth: [1] }] });

    const listed = await fetch(`${base}/_emulator/faults`);
    expect(await listed.json()).toEqual({ faults: [{ endpoint: '*', kind: 'error500', nth: [1] }] });

    const invalid = await fetch(`${base}/_emulator/faults`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ endpoint: 'token', kind: 'nope', probability: 1 }]),
    });
    await expectError(invalid, 400, 'invalid_request');
    expect(await (await fetch(`${base}/_emulator/faults`)).json()).toEqual({
      faults: [{ endpoint: '*', kind: 'error500', nth: [1] }],
    });

    const health = await fetch(`${base}/_emulator/health`);
    expect(health.status).toBe(200);
    const faultsGet = await fetch(`${base}/_emulator/faults`);
    expect(faultsGet.status).toBe(200);
    await expectError(await tokenRequest(base), 500, 'SystemError');

    const resetCounters = await fetch(`${base}/_emulator/reset`, { method: 'POST' });
    expect(resetCounters.status).toBe(200);
    await expectError(await tokenRequest(base), 500, 'SystemError');

    const cleared = await fetch(`${base}/_emulator/faults`, { method: 'DELETE' });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ faults: [] });
    expect((await tokenRequest(base)).status).toBe(200);
  });

  it('throws when createEmulator is given an invalid rule', () => {
    expect(() =>
      createEmulator({
        faults: [{ endpoint: 'token', kind: 'error500' }] as FaultRule[],
      }),
    ).toThrow(FaultError);
  });

  it('cancels pending latency timers when the server stops', async () => {
    const started = await startServer({
      faults: [{ endpoint: 'token', kind: 'latency', latencyMs: 5000, probability: 1 }],
    });
    emulator = started.emulator;
    base = started.base;
    const pending = tokenRequest(base);
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    await emulator.stop();
    await expect(pending).rejects.toThrow();
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../src/clock.js';
import { FAKE_CLOCK_START_MS, RATE_LIMIT_WINDOW_MS } from '../src/constants.js';
import { createEmulator, type Emulator } from '../src/emulator.js';
import {
  DEFAULT_RPM,
  RATE_LIMIT_UNAUTHENTICATED,
  RateLimiter,
  resolveRateLimit,
} from '../src/rate-limit.js';
import { defaultConfig } from '../src/defaults.js';
import {
  advance,
  assertCorrelation,
  authHeaders,
  encodeDocument,
  expectError,
  minimalInvoice,
  startServer,
} from './helpers.js';

const tenants = defaultConfig().tenants ?? [];
const foundSupplier = tenants.find((tenant) => tenant.clientId === 'sample-supplier');
const foundBuyer = tenants.find((tenant) => tenant.clientId === 'sample-buyer');
if (!foundSupplier || !foundBuyer) throw new Error('built-in sample tenants are missing');
const supplier = foundSupplier;
const buyer = foundBuyer;

function limiter(scale = 1, rpm?: Partial<typeof DEFAULT_RPM>, enabled = true): RateLimiter {
  const clock = new FakeClock(FAKE_CLOCK_START_MS);
  return new RateLimiter(clock, resolveRateLimit({ enabled, scale, rpm }));
}

describe('resolveRateLimit', () => {
  it('applies scale then floor with a minimum of 1', () => {
    expect(resolveRateLimit({ scale: 0.5 }).rpm.token).toBe(6);
    expect(resolveRateLimit({ scale: 0.5 }).rpm.submit).toBe(50);
    expect(resolveRateLimit({ scale: 0.5 }).rpm.getDocumentDetails).toBe(62);
    expect(resolveRateLimit({ scale: 0.01 }).rpm.token).toBe(1);
    expect(resolveRateLimit({ rpm: { token: 3 }, scale: 2 }).rpm.token).toBe(6);
  });

  it('rejects a non-positive or non-finite scale', () => {
    expect(() => resolveRateLimit({ scale: 0 })).toThrow(/finite number greater than 0/);
    expect(() => resolveRateLimit({ scale: -1 })).toThrow(/finite number greater than 0/);
    expect(() => resolveRateLimit({ scale: Number.POSITIVE_INFINITY })).toThrow(/finite number greater than 0/);
    expect(() => resolveRateLimit({ scale: Number.NaN })).toThrow(/finite number greater than 0/);
  });
});

describe('RateLimiter', () => {
  it('allows up to the RPM then denies in the same window', () => {
    const clock = new FakeClock(FAKE_CLOCK_START_MS);
    const rl = new RateLimiter(clock, resolveRateLimit({ rpm: { token: 2 } }));
    const first = rl.hit('a', 'token');
    const second = rl.hit('a', 'token');
    const third = rl.hit('a', 'token');
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(1);
    expect(second.allowed).toBe(true);
    expect(second.remaining).toBe(0);
    expect(third.allowed).toBe(false);
    expect(third.remaining).toBe(0);
    expect(third.retryAfterSeconds).toBe(60);
    expect(third.headers['Retry-After']).toBe('60');
    expect(third.headers['X-Rate-Limit-Limit']).toBe('2');
    expect(third.headers['X-Rate-Limit-Remaining']).toBe('0');
    expect(third.headers['X-Rate-Limit-Reset']).toBe(new Date(FAKE_CLOCK_START_MS + RATE_LIMIT_WINDOW_MS).toISOString());
    expect(first.headers['Retry-After']).toBeUndefined();
    expect(first.headers['X-Rate-Limit-Reset']).toBe(third.headers['X-Rate-Limit-Reset']);
  });

  it('resets counts when the clock leaves the 60-second window', () => {
    const clock = new FakeClock(FAKE_CLOCK_START_MS);
    const rl = new RateLimiter(clock, resolveRateLimit({ rpm: { token: 1 } }));
    expect(rl.hit('a', 'token').allowed).toBe(true);
    expect(rl.hit('a', 'token').allowed).toBe(false);
    clock.advance(RATE_LIMIT_WINDOW_MS);
    expect(rl.hit('a', 'token').allowed).toBe(true);
  });

  it('isolates counters per client and per endpoint', () => {
    const rl = limiter(1, { token: 1, submit: 1 });
    expect(rl.hit('a', 'token').allowed).toBe(true);
    expect(rl.hit('a', 'token').allowed).toBe(false);
    expect(rl.hit('b', 'token').allowed).toBe(true);
    expect(rl.hit('a', 'submit').allowed).toBe(true);
    expect(rl.hit(RATE_LIMIT_UNAUTHENTICATED, 'token').allowed).toBe(true);
  });

  it('clears counters on reset and never denies when disabled', () => {
    const clock = new FakeClock(FAKE_CLOCK_START_MS);
    const rl = new RateLimiter(clock, resolveRateLimit({ rpm: { token: 1 } }));
    expect(rl.hit('a', 'token').allowed).toBe(true);
    expect(rl.hit('a', 'token').allowed).toBe(false);
    rl.reset();
    expect(rl.hit('a', 'token').allowed).toBe(true);

    const off = new RateLimiter(clock, resolveRateLimit({ enabled: false, rpm: { token: 1 } }));
    for (let i = 0; i < 5; i += 1) {
      const decision = off.hit('a', 'token');
      expect(decision.allowed).toBe(true);
      expect(decision.headers).toEqual({});
    }
  });

  it('uses Retry-After of at least 1 near the end of the window', () => {
    const clock = new FakeClock(FAKE_CLOCK_START_MS);
    const rl = new RateLimiter(clock, resolveRateLimit({ rpm: { token: 1 } }));
    expect(rl.hit('a', 'token').allowed).toBe(true);
    clock.advance(RATE_LIMIT_WINDOW_MS - 1);
    const denied = rl.hit('a', 'token');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBe(1);
    expect(denied.headers['Retry-After']).toBe('1');
  });
});

describe('http rate limits', () => {
  let emulator: Emulator;
  let base: string;

  afterEach(async () => {
    if (emulator) await emulator.stop();
  });

  async function tokenRequest(clientId: string, clientSecret: string): Promise<Response> {
    return fetch(`${base}/connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'InvoicingAPI',
      }),
    });
  }

  it('returns 429 on the 13th token request and 200 after advancing 60s', async () => {
    const started = await startServer();
    emulator = started.emulator;
    base = started.base;

    const resetIso = new Date(FAKE_CLOCK_START_MS + RATE_LIMIT_WINDOW_MS).toISOString();
    for (let i = 0; i < 12; i += 1) {
      const res = await tokenRequest(supplier.clientId, supplier.clientSecret);
      assertCorrelation(res);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-rate-limit-limit')).toBe('12');
      expect(res.headers.get('x-rate-limit-remaining')).toBe(String(11 - i));
      expect(res.headers.get('x-rate-limit-reset')).toBe(resetIso);
      expect(res.headers.get('retry-after')).toBeNull();
    }

    const limited = await tokenRequest(supplier.clientId, supplier.clientSecret);
    const error = await expectError(limited, 429, 'RateLimitExceeded');
    expect(error.errorMS.length).toBeGreaterThan(0);
    expect(limited.headers.get('retry-after')).toBe('60');
    expect(limited.headers.get('x-rate-limit-limit')).toBe('12');
    expect(limited.headers.get('x-rate-limit-remaining')).toBe('0');
    expect(limited.headers.get('x-rate-limit-reset')).toBe(resetIso);

    await advance(base, RATE_LIMIT_WINDOW_MS);
    const after = await tokenRequest(supplier.clientId, supplier.clientSecret);
    assertCorrelation(after);
    expect(after.status).toBe(200);
    expect(after.headers.get('x-rate-limit-remaining')).toBe('11');
  });

  it('keeps counters per client and per endpoint', async () => {
    const started = await startServer({
      rateLimit: { rpm: { token: 1, validateTin: 1, submit: 5 } },
    });
    emulator = started.emulator;
    base = started.base;

    const first = await tokenRequest(supplier.clientId, supplier.clientSecret);
    expect(first.status).toBe(200);
    const supplierLimited = await tokenRequest(supplier.clientId, supplier.clientSecret);
    await expectError(supplierLimited, 429, 'RateLimitExceeded');

    const buyerTokenRes = await tokenRequest(buyer.clientId, buyer.clientSecret);
    expect(buyerTokenRes.status).toBe(200);

    const token = (await first.json()) as { access_token: string };
    const tin = await fetch(`${base}/api/v1.0/taxpayer/validate/C00000000000?idType=BRN&idValue=201901000001`, {
      headers: authHeaders(token.access_token),
    });
    expect(tin.status).toBe(200);
    const tinLimited = await fetch(`${base}/api/v1.0/taxpayer/validate/C00000000000?idType=BRN&idValue=201901000001`, {
      headers: authHeaders(token.access_token),
    });
    await expectError(tinLimited, 429, 'RateLimitExceeded');

    const submit = await fetch(`${base}/api/v1.0/documentsubmissions/`, {
      method: 'POST',
      headers: authHeaders(token.access_token, true),
      body: JSON.stringify({
        documents: [encodeDocument(minimalInvoice(supplier.tin, buyer.tin), 'JSON', 'RL-1')],
      }),
    });
    assertCorrelation(submit);
    expect(submit.status).toBe(202);
    expect(submit.headers.get('x-rate-limit-limit')).toBe('5');
  });

  it('clears counters on reset and never limits /_emulator/*', async () => {
    const started = await startServer({ rateLimit: { rpm: { token: 1 } } });
    emulator = started.emulator;
    base = started.base;

    expect((await tokenRequest(supplier.clientId, supplier.clientSecret)).status).toBe(200);
    await expectError(await tokenRequest(supplier.clientId, supplier.clientSecret), 429, 'RateLimitExceeded');

    const health = await fetch(`${base}/_emulator/health`);
    assertCorrelation(health);
    expect(health.status).toBe(200);
    expect(health.headers.get('x-rate-limit-limit')).toBeNull();

    const reset = await fetch(`${base}/_emulator/reset`, { method: 'POST' });
    expect(reset.status).toBe(200);
    expect(reset.headers.get('x-rate-limit-limit')).toBeNull();
    expect((await tokenRequest(supplier.clientId, supplier.clientSecret)).status).toBe(200);
  });

  it('honours scale 0.5 and --no-rate-limit via library options', async () => {
    const scaled = await startServer({ rateLimit: { scale: 0.5 } });
    emulator = scaled.emulator;
    base = scaled.base;
    for (let i = 0; i < 6; i += 1) {
      const res = await tokenRequest(supplier.clientId, supplier.clientSecret);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-rate-limit-limit')).toBe('6');
    }
    await expectError(await tokenRequest(supplier.clientId, supplier.clientSecret), 429, 'RateLimitExceeded');
    await emulator.stop();

    const disabled = await startServer({ rateLimit: { enabled: false } });
    emulator = disabled.emulator;
    base = disabled.base;
    for (let i = 0; i < 13; i += 1) {
      const res = await tokenRequest(supplier.clientId, supplier.clientSecret);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-rate-limit-limit')).toBeNull();
    }
  });

  it('uses a shared bucket for unauthenticated API requests', async () => {
    const started = await startServer({ rateLimit: { rpm: { validateTin: 1 } } });
    emulator = started.emulator;
    base = started.base;
    const first = await fetch(`${base}/api/v1.0/taxpayer/validate/C00000000000?idType=BRN&idValue=201901000001`);
    await expectError(first, 401, 'Unauthorized');
    expect(first.headers.get('x-rate-limit-limit')).toBe('1');
    const second = await fetch(`${base}/api/v1.0/taxpayer/validate/C00000000000?idType=BRN&idValue=201901000001`);
    await expectError(second, 429, 'RateLimitExceeded');
  });
});

describe('createEmulator rateLimit option', () => {
  it('throws when scale is invalid', () => {
    expect(() => createEmulator({ rateLimit: { scale: 0 } })).toThrow(/finite number greater than 0/);
  });
});

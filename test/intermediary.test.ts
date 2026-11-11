import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, parseConfig, resolveConfig, splitOnBehalfOf, type EmulatorConfig } from '../src/config.js';
import { defaultConfig } from '../src/defaults.js';
import type { Emulator } from '../src/emulator.js';
import {
  advance,
  assertCorrelation,
  authHeaders,
  encodeDocument,
  expectError,
  login,
  minimalInvoice,
  startServer,
  submitRaw,
} from './helpers.js';

const INTERMEDIARY = { clientId: 'intermediary-a', clientSecret: 'intermediary-a-secret', tin: 'EI00000000020' };
const SUPPLIER_A = { clientId: 'supplier-a', clientSecret: 'supplier-a-secret', tin: 'C00000000000' };
const SUPPLIER_B_TIN = 'C00000000001';
const BUYER_TIN = 'IG00000000000';

interface Summary {
  uuid: string;
  supplierTIN: string | null;
  createdByUserId: string;
  intermediaryTin: string | null;
  intermediaryName: string | null;
  intermediaryRob: string | null;
}

function tokenRequest(base: string, clientId: string, clientSecret: string, onBehalfOf?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (onBehalfOf !== undefined) headers.onbehalfof = onBehalfOf;
  return fetch(`${base}/connect/token`, {
    method: 'POST',
    headers,
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'InvoicingAPI',
    }),
  });
}

async function intermediaryToken(base: string, onBehalfOf?: string): Promise<string> {
  const res = await tokenRequest(base, INTERMEDIARY.clientId, INTERMEDIARY.clientSecret, onBehalfOf);
  assertCorrelation(res);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { access_token: string; token_type: string; expires_in: number };
  expect(body.token_type).toBe('Bearer');
  expect(body.expires_in).toBe(3600);
  return body.access_token;
}

function invoiceBody(supplierTin: string, id: string): string {
  return JSON.stringify({ documents: [encodeDocument(minimalInvoice(supplierTin, BUYER_TIN, id), 'JSON', id)] });
}

async function recent(base: string, token: string): Promise<Response> {
  return fetch(`${base}/api/v1.0/documents/recent?pageSize=100`, { headers: authHeaders(token) });
}

async function recentResults(base: string, token: string): Promise<Summary[]> {
  const res = await recent(base, token);
  assertCorrelation(res);
  expect(res.status).toBe(200);
  return ((await res.json()) as { result: Summary[] }).result;
}

describe('intermediary login (onbehalfof)', () => {
  let emulator: Emulator | undefined;

  async function boot(config?: EmulatorConfig): Promise<string> {
    const started = await startServer({ config });
    emulator = started.emulator;
    return started.base;
  }

  afterEach(async () => {
    await emulator?.stop();
    emulator = undefined;
  });

  it('submits on behalf of an authorized taxpayer and records the intermediary', async () => {
    const base = await boot();
    const token = await intermediaryToken(base, SUPPLIER_A.tin);
    const res = await submitRaw(base, token, invoiceBody(SUPPLIER_A.tin, 'INT-1'));
    assertCorrelation(res);
    expect(res.status).toBe(202);
    await advance(base, 2000);

    const asIntermediary = await recentResults(base, token);
    expect(asIntermediary).toHaveLength(1);
    expect(asIntermediary[0]).toMatchObject({
      supplierTIN: SUPPLIER_A.tin,
      createdByUserId: INTERMEDIARY.clientId,
      intermediaryTin: INTERMEDIARY.tin,
      intermediaryName: 'Fake Intermediary',
      intermediaryRob: '202101000001',
    });

    // The represented taxpayer sees the same document with its own token.
    const ownToken = await login(base, SUPPLIER_A.clientId, SUPPLIER_A.clientSecret);
    const asSupplier = await recentResults(base, ownToken);
    expect(asSupplier.map((doc) => doc.uuid)).toEqual([asIntermediary[0]?.uuid]);
  });

  it('cancels on behalf of the represented supplier', async () => {
    const base = await boot();
    const token = await intermediaryToken(base, SUPPLIER_A.tin);
    expect((await submitRaw(base, token, invoiceBody(SUPPLIER_A.tin, 'INT-CANCEL'))).status).toBe(202);
    await advance(base, 2000);
    const [doc] = await recentResults(base, token);
    if (!doc) throw new Error('document missing');
    const res = await fetch(`${base}/api/v1.0/documents/state/${doc.uuid}/state`, {
      method: 'PUT',
      headers: authHeaders(token, true),
      body: JSON.stringify({ status: 'cancelled', reason: 'wrong buyer' }),
    });
    assertCorrelation(res);
    expect(res.status).toBe(200);
  });

  it('refuses a document whose supplier is not the represented taxpayer', async () => {
    const base = await boot();
    const token = await intermediaryToken(base, SUPPLIER_A.tin);
    await expectError(await submitRaw(base, token, invoiceBody(INTERMEDIARY.tin, 'INT-SELF')), 403, 'IncorrectSubmitter');
  });

  it('issues a token for an unauthorized taxpayer but refuses every API call with it (api mode)', async () => {
    const base = await boot();
    for (const value of [SUPPLIER_B_TIN, 'C99999999999', `${SUPPLIER_A.tin}:201901000001`]) {
      const token = await intermediaryToken(base, value);
      await expectError(await submitRaw(base, token, invoiceBody(SUPPLIER_A.tin, `DENY-${value}`)), 403, 'IncorrectSubmitter');
      await expectError(await recent(base, token), 403, 'IncorrectSubmitter');
    }
  });

  it('refuses the login itself in token mode', async () => {
    const base = await boot({ intermediaryDenial: 'token' });
    const denied = await tokenRequest(base, INTERMEDIARY.clientId, INTERMEDIARY.clientSecret, SUPPLIER_B_TIN);
    await expectError(denied, 403, 'IncorrectSubmitter');
    await intermediaryToken(base, SUPPLIER_A.tin);
  });

  it('rejects onbehalfof from a non-intermediary client and an empty value', async () => {
    const base = await boot();
    await expectError(
      await tokenRequest(base, SUPPLIER_A.clientId, SUPPLIER_A.clientSecret, "Supplier's TIN"),
      400,
      'invalid_request',
    );
    await expectError(
      await tokenRequest(base, INTERMEDIARY.clientId, INTERMEDIARY.clientSecret, '   '),
      400,
      'invalid_request',
    );
  });

  it('acts as itself without onbehalfof and leaves the intermediary fields null', async () => {
    const base = await boot();
    const token = await intermediaryToken(base);
    expect((await submitRaw(base, token, invoiceBody(INTERMEDIARY.tin, 'INT-OWN'))).status).toBe(202);
    const [doc] = await recentResults(base, token);
    expect(doc).toMatchObject({
      supplierTIN: INTERMEDIARY.tin,
      createdByUserId: INTERMEDIARY.clientId,
      intermediaryTin: null,
      intermediaryName: null,
      intermediaryRob: null,
    });
  });

  it('matches TIN:ROB entries exactly', async () => {
    const config = defaultConfig();
    config.tenants = (config.tenants ?? []).map((tenant) =>
      tenant.clientId === INTERMEDIARY.clientId
        ? { ...tenant, representedTins: [`${SUPPLIER_A.tin}:201901000001`] }
        : tenant,
    );
    const base = await boot(config);
    const withRob = await intermediaryToken(base, `${SUPPLIER_A.tin}:201901000001`);
    expect((await submitRaw(base, withRob, invoiceBody(SUPPLIER_A.tin, 'ROB-1'))).status).toBe(202);
    const tinOnly = await intermediaryToken(base, SUPPLIER_A.tin);
    await expectError(await recent(base, tinOnly), 403, 'IncorrectSubmitter');
  });

  it('denies its own TIN even when a programmatic config skips parseConfig', async () => {
    const config = defaultConfig();
    config.tenants = (config.tenants ?? []).map((tenant) =>
      tenant.clientId === INTERMEDIARY.clientId ? { ...tenant, representedTins: [INTERMEDIARY.tin] } : tenant,
    );
    const base = await boot(config);
    const token = await intermediaryToken(base, INTERMEDIARY.tin);
    await expectError(await recent(base, token), 403, 'IncorrectSubmitter');
  });
});

describe('intermediary config', () => {
  const intermediary = {
    tin: 'EI00000000020',
    name: 'Fake Intermediary',
    role: 'intermediary',
    clientId: 'intermediary-a',
    clientSecret: 's',
    idType: 'BRN',
    idValue: '202101000001',
  };
  const supplier = {
    tin: 'C00000000000',
    name: 'Fake Supplier A',
    role: 'supplier',
    clientId: 'supplier-a',
    clientSecret: 's',
    idType: 'BRN',
    idValue: '201901000001',
  };

  function tenantsWith(extra: Record<string, unknown>, supplierExtra: Record<string, unknown> = {}): unknown {
    return { tenants: [{ ...intermediary, ...extra }, { ...supplier, ...supplierExtra }] };
  }

  it('accepts a valid authorization table and defaults intermediaryDenial to api', () => {
    const parsed = parseConfig(tenantsWith({ representedTins: ['C00000000000', 'C00000000000:201901000001'] }));
    const resolved = resolveConfig(parsed);
    expect(resolved.intermediaryDenial).toBe('api');
    expect(resolved.tenants[0]?.representedTins).toEqual(['C00000000000', 'C00000000000:201901000001']);
    expect(resolveConfig(parseConfig({ intermediaryDenial: 'token' })).intermediaryDenial).toBe('token');
  });

  it.each([
    ['representedTins on a supplier', tenantsWith({}, { representedTins: ['EI00000000020'] }), /only allowed for role intermediary/],
    ['a non-array table', tenantsWith({ representedTins: 'C00000000000' }), /must be an array/],
    ['an empty entry', tenantsWith({ representedTins: [''] }), /non-empty string/],
    ['duplicate entries', tenantsWith({ representedTins: ['C00000000000', 'C00000000000'] }), /duplicate entries/],
    ['an unknown TIN', tenantsWith({ representedTins: ['C99999999999'] }), /unknown tenant TIN C99999999999/],
    ['its own TIN', tenantsWith({ representedTins: ['EI00000000020'] }), /cannot represent its own TIN/],
    ['an empty ROB part', tenantsWith({ representedTins: ['C00000000000:'] }), /must be TIN or TIN:ROB/],
    ['a bad intermediaryDenial', { intermediaryDenial: 'never' }, /intermediaryDenial must be api or token/],
  ])('rejects %s', (_label, value, message) => {
    expect(() => parseConfig(value)).toThrow(ConfigError);
    expect(() => parseConfig(value)).toThrow(message);
  });

  it('splits onbehalfof values', () => {
    expect(splitOnBehalfOf('C00000000000')).toEqual({ tin: 'C00000000000', rob: null });
    expect(splitOnBehalfOf('IG12345678912:201901234567')).toEqual({ tin: 'IG12345678912', rob: '201901234567' });
  });
});

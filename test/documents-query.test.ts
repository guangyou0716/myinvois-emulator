import { afterEach, describe, expect, it } from 'vitest';
import { FAKE_CLOCK_START_MS, QUERY_WINDOW_MS, RATE_LIMIT_WINDOW_MS } from '../src/constants.js';
import { defaultConfig } from '../src/defaults.js';
import { parseListQuery } from '../src/document-query.js';
import type { Emulator } from '../src/emulator.js';
import {
  advance,
  assertCorrelation,
  authHeaders,
  encodeDocument,
  expectError,
  login,
  startServer,
  submitRaw,
} from './helpers.js';

const tenants = defaultConfig().tenants ?? [];
const foundSupplier = tenants.find((tenant) => tenant.clientId === 'sample-supplier');
const foundBuyer = tenants.find((tenant) => tenant.clientId === 'sample-buyer');
const foundOther = tenants.find((tenant) => tenant.clientId === 'supplier-a');
if (!foundSupplier || !foundBuyer || !foundOther) throw new Error('built-in sample tenants are missing');
const supplier = foundSupplier;
const buyer = foundBuyer;
const otherSupplier = foundOther;

const SUB_FROM = '2026-01-01T00:00:00.000Z';
const SUB_TO = '2026-01-31T23:59:59.000Z';

interface InvoiceFields {
  id?: string;
  issueDate?: string;
  issueTime?: string;
  typeCode?: string;
  typeVersion?: string;
  supplierName?: string;
  buyerName?: string;
  supplierIdType?: string;
  supplierId?: string;
  buyerIdType?: string;
  buyerId?: string;
  taxExclusive?: number;
  discount?: number;
  net?: number;
  payable?: number;
  classification?: string[];
}

function invoiceJson(supplierTin: string, buyerTin: string, fields: InvoiceFields = {}): string {
  const classification = (fields.classification ?? []).map((code) => ({
    ItemClassificationCode: [{ _: code, listID: 'CLASS' }],
  }));
  return JSON.stringify({
    Invoice: [
      {
        ID: [{ _: fields.id ?? 'INV-1' }],
        IssueDate: fields.issueDate === undefined ? undefined : [{ _: fields.issueDate }],
        IssueTime: fields.issueTime === undefined ? undefined : [{ _: fields.issueTime }],
        InvoiceTypeCode:
          fields.typeCode === undefined
            ? undefined
            : [{ _: fields.typeCode, listVersionID: fields.typeVersion ?? '1.1' }],
        AccountingSupplierParty: [
          {
            Party: [
              {
                PartyIdentification: [
                  { ID: [{ _: supplierTin, schemeID: 'TIN' }] },
                  ...(fields.supplierId === undefined
                    ? []
                    : [{ ID: [{ _: fields.supplierId, schemeID: fields.supplierIdType ?? 'BRN' }] }]),
                ],
                PartyLegalEntity: [{ RegistrationName: [{ _: fields.supplierName ?? 'Supplier Co' }] }],
              },
            ],
          },
        ],
        AccountingCustomerParty: [
          {
            Party: [
              {
                PartyIdentification: [
                  { ID: [{ _: buyerTin, schemeID: 'TIN' }] },
                  ...(fields.buyerId === undefined
                    ? []
                    : [{ ID: [{ _: fields.buyerId, schemeID: fields.buyerIdType ?? 'BRN' }] }]),
                ],
                PartyLegalEntity: [{ RegistrationName: [{ _: fields.buyerName ?? 'Buyer Co' }] }],
              },
            ],
          },
        ],
        LegalMonetaryTotal: [
          {
            LineExtensionAmount: [{ _: fields.net ?? 100 }],
            TaxExclusiveAmount: [{ _: fields.taxExclusive ?? 100 }],
            AllowanceTotalAmount: [{ _: fields.discount ?? 0 }],
            PayableAmount: [{ _: fields.payable ?? 110 }],
          },
        ],
        InvoiceLine:
          classification.length === 0
            ? undefined
            : [{ Item: [{ CommodityClassification: classification }] }],
      },
    ],
  });
}

describe('parseListQuery', () => {
  it('defaults pageNo 1 and pageSize 100 for recent without filters', () => {
    const parsed = parseListQuery(new URLSearchParams(), 'recent');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.query.pageNo).toBe(1);
    expect(parsed.query.pageSize).toBe(100);
    expect(parsed.query.direction).toBeNull();
  });

  it('requires a submission or issue date pair for search', () => {
    const missing = parseListQuery(new URLSearchParams(), 'search');
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.property).toBe('submissionDateFrom');
  });

  it('rejects a date pair with a missing partner', () => {
    const parsed = parseListQuery(new URLSearchParams('submissionDateFrom=2026-01-01T00:00:00Z'), 'recent');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.property).toBe('submissionDateTo');
  });

  it('rejects a range longer than 31 days and from after to', () => {
    const longRange = parseListQuery(
      new URLSearchParams(
        'submissionDateFrom=2026-01-01T00:00:00Z&submissionDateTo=2026-02-01T00:00:00.001Z',
      ),
      'search',
    );
    expect(longRange.ok).toBe(false);

    const exact = parseListQuery(
      new URLSearchParams('submissionDateFrom=2026-01-01T00:00:00Z&submissionDateTo=2026-02-01T00:00:00Z'),
      'search',
    );
    expect(exact.ok).toBe(true);

    const inverted = parseListQuery(
      new URLSearchParams('issueDateFrom=2026-01-10T00:00:00Z&issueDateTo=2026-01-01T00:00:00Z'),
      'search',
    );
    expect(inverted.ok).toBe(false);
    if (inverted.ok) return;
    expect(inverted.property).toBe('issueDateFrom');
  });

  it('rejects receiver filters without direction Sent and issuer filters without Received', () => {
    const receiver = parseListQuery(new URLSearchParams('receiverTin=IG1'), 'recent');
    expect(receiver.ok).toBe(false);
    const issuer = parseListQuery(new URLSearchParams('direction=Sent&issuerTin=C1'), 'recent');
    expect(issuer.ok).toBe(false);
    const ok = parseListQuery(new URLSearchParams('direction=Sent&receiverTin=IG1'), 'recent');
    expect(ok.ok).toBe(true);
  });

  it('rejects invalid paging, status, direction, and searchQuery characters', () => {
    expect(parseListQuery(new URLSearchParams('pageSize=101'), 'recent').ok).toBe(false);
    expect(parseListQuery(new URLSearchParams('pageNo=0'), 'recent').ok).toBe(false);
    expect(parseListQuery(new URLSearchParams('status=Rejected'), 'recent').ok).toBe(false);
    expect(parseListQuery(new URLSearchParams('direction=Both'), 'recent').ok).toBe(false);
    expect(
      parseListQuery(
        new URLSearchParams(`submissionDateFrom=${SUB_FROM}&submissionDateTo=${SUB_TO}&searchQuery=a%2Fb`),
        'search',
      ).ok,
    ).toBe(false);
  });

  it('accepts invoiceDirection and InvoiceDirection aliases', () => {
    const a = parseListQuery(new URLSearchParams('invoiceDirection=Received'), 'recent');
    const b = parseListQuery(new URLSearchParams('InvoiceDirection=sent'), 'recent');
    expect(a.ok && a.query.direction).toBe('Received');
    expect(b.ok && b.query.direction).toBe('Sent');
  });

  it('requires date query params to be full ISO-8601 datetimes with Z or an offset', () => {
    const dateOnly = parseListQuery(
      new URLSearchParams('submissionDateFrom=2026-01-01&submissionDateTo=2026-01-31'),
      'search',
    );
    expect(dateOnly.ok).toBe(false);
    if (dateOnly.ok) return;
    expect(dateOnly.property).toBe('submissionDateFrom');
    expect(dateOnly.message).toMatch(/ISO-8601 datetime with Z or an explicit offset/);

    const offsetLess = parseListQuery(
      new URLSearchParams('issueDateFrom=2026-01-01T00:00:00&issueDateTo=2026-01-02T00:00:00'),
      'search',
    );
    expect(offsetLess.ok).toBe(false);
    if (offsetLess.ok) return;
    expect(offsetLess.property).toBe('issueDateFrom');

    const withZ = parseListQuery(
      new URLSearchParams('submissionDateFrom=2026-01-01T00:00:00Z&submissionDateTo=2026-01-31T23:59:59.000Z'),
      'search',
    );
    expect(withZ.ok).toBe(true);
    if (!withZ.ok) return;
    expect(withZ.query.submissionFrom).toBe(Date.UTC(2026, 0, 1, 0, 0, 0));
    expect(withZ.query.submissionTo).toBe(Date.UTC(2026, 0, 31, 23, 59, 59));

    const withOffset = parseListQuery(
      new URLSearchParams({
        issueDateFrom: '2026-01-01T08:00:00+08:00',
        issueDateTo: '2026-01-01T08:00:00+08:00',
      }),
      'search',
    );
    expect(withOffset.ok).toBe(true);
    if (!withOffset.ok) return;
    expect(withOffset.query.issueFrom).toBe(Date.UTC(2026, 0, 1, 0, 0, 0));
    expect(withOffset.query.issueTo).toBe(Date.UTC(2026, 0, 1, 0, 0, 0));
  });
});

describe('GET recent and search', () => {
  let emulator: Emulator;
  let base: string;

  afterEach(async () => {
    if (emulator) await emulator.stop();
  });

  async function boot(rateLimit?: { rpm?: { getRecent?: number; search?: number } }) {
    const started = await startServer({ rateLimit });
    emulator = started.emulator;
    base = started.base;
    return started;
  }

  async function submitAs(
    token: string,
    content: string,
    codeNumber: string,
  ): Promise<{ uuid: string; submissionUID: string }> {
    const res = await submitRaw(
      base,
      token,
      JSON.stringify({ documents: [encodeDocument(content, 'JSON', codeNumber)] }),
    );
    assertCorrelation(res);
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      submissionUID: string;
      acceptedDocuments: Array<{ uuid: string }>;
    };
    return { uuid: body.acceptedDocuments[0]?.uuid ?? '', submissionUID: body.submissionUID };
  }

  function recent(token: string, query = ''): Promise<Response> {
    return fetch(`${base}/api/v1.0/documents/recent${query}`, { headers: authHeaders(token) });
  }

  function search(token: string, extra = ''): Promise<Response> {
    const joined = extra.startsWith('?') ? extra.slice(1) : extra;
    const qs = `submissionDateFrom=${encodeURIComponent(SUB_FROM)}&submissionDateTo=${encodeURIComponent(SUB_TO)}${
      joined.length > 0 ? `&${joined}` : ''
    }`;
    return fetch(`${base}/api/v1.0/documents/search?${qs}`, { headers: authHeaders(token) });
  }

  interface ListBody {
    result: Array<{
      uuid: string;
      internalId: string;
      status: string;
      typeName: string | null;
      issuerTin: string | null;
      receiverId: string | null;
      supplierTIN: string | null;
      buyerTIN: string | null;
      buyerName: string | null;
      totalPayableAmount: number | null;
      submissionChannel: string | null;
      intermediaryName: string | null;
      createdByUserId: string;
      classificationCodeValues: string[] | null;
    }>;
    metadata: { totalPages: number; totalCount: number };
  }

  async function listJson(res: Response): Promise<ListBody> {
    assertCorrelation(res);
    expect(res.status).toBe(200);
    return (await res.json()) as ListBody;
  }

  it('returns 401 without a bearer token', async () => {
    await boot();
    await expectError(await fetch(`${base}/api/v1.0/documents/recent`), 401, 'Unauthorized');
    await expectError(
      await fetch(
        `${base}/api/v1.0/documents/search?submissionDateFrom=${SUB_FROM}&submissionDateTo=${SUB_TO}`,
      ),
      401,
      'Unauthorized',
    );
  });

  it('scopes visibility by tenant and direction, hiding Submitted from the buyer', async () => {
    await boot();
    const supplierToken = await login(base, supplier.clientId, supplier.clientSecret);
    const buyerToken = await login(base, buyer.clientId, buyer.clientSecret);
    const otherToken = await login(base, otherSupplier.clientId, otherSupplier.clientSecret);
    const created = await submitAs(
      supplierToken,
      invoiceJson(supplier.tin, buyer.tin, { id: 'VIS-1', issueDate: '2026-01-01' }),
      'VIS-1',
    );

    const pendingSupplier = await listJson(await recent(supplierToken, '?direction=Sent'));
    expect(pendingSupplier.result.map((row) => row.uuid)).toEqual([created.uuid]);
    const pendingBuyer = await listJson(await recent(buyerToken, '?direction=Received'));
    expect(pendingBuyer.result).toEqual([]);

    await advance(base, 2000);
    const validBuyer = await listJson(await recent(buyerToken));
    expect(validBuyer.result.map((row) => row.uuid)).toEqual([created.uuid]);
    const other = await listJson(await recent(otherToken));
    expect(other.result).toEqual([]);

    const sentBuyer = await listJson(await recent(buyerToken, '?direction=Sent'));
    expect(sentBuyer.result).toEqual([]);
    const receivedSupplier = await listJson(await recent(supplierToken, '?direction=Received'));
    expect(receivedSupplier.result).toEqual([]);

    const invalid = await submitAs(supplierToken, JSON.stringify({ note: 'not an invoice' }), 'BAD-1');
    await advance(base, 2000);
    const issuerInvalid = await listJson(await recent(supplierToken, '?status=Invalid'));
    expect(issuerInvalid.result.map((row) => row.uuid)).toEqual([invalid.uuid]);
    const buyerInvalid = await listJson(await recent(buyerToken, '?status=Invalid'));
    expect(buyerInvalid.result).toEqual([]);
  });

  it('filters by status, documentType, receiver, issuer, uuid, searchQuery, and classificationCode', async () => {
    await boot();
    const supplierToken = await login(base, supplier.clientId, supplier.clientSecret);
    const buyerToken = await login(base, buyer.clientId, buyer.clientSecret);
    const rich = await submitAs(
      supplierToken,
      invoiceJson(supplier.tin, buyer.tin, {
        id: 'FILT-1',
        issueDate: '2026-01-01',
        typeCode: '01',
        buyerName: 'Acme Buyer',
        buyerId: '201901000099',
        buyerIdType: 'BRN',
        payable: 250.5,
        classification: ['001', '002'],
      }),
      'FILT-1',
    );
    await submitAs(
      supplierToken,
      invoiceJson(supplier.tin, buyer.tin, { id: 'FILT-2', issueDate: '2026-01-01', typeCode: '02' }),
      'FILT-2',
    );
    await advance(base, 2000);

    const byStatus = await listJson(await recent(supplierToken, '?status=Valid'));
    expect(byStatus.result.every((row) => row.status === 'Valid')).toBe(true);
    expect(byStatus.metadata.totalCount).toBe(2);

    const byType = await listJson(await recent(supplierToken, '?documentType=01'));
    expect(byType.result.map((row) => row.internalId)).toEqual(['FILT-1']);
    expect(byType.result[0]?.typeName).toBe('invoice');

    const byReceiver = await listJson(
      await recent(
        supplierToken,
        `?direction=Sent&receiverTin=${encodeURIComponent(buyer.tin)}&receiverIdType=BRN&receiverId=201901000099`,
      ),
    );
    expect(byReceiver.result.map((row) => row.uuid)).toEqual([rich.uuid]);
    expect(byReceiver.result[0]?.receiverId).toBe('201901000099');

    const byIssuer = await listJson(
      await recent(buyerToken, `?direction=Received&issuerTin=${encodeURIComponent(supplier.tin)}`),
    );
    expect(byIssuer.metadata.totalCount).toBe(2);

    const byUuid = await listJson(await search(supplierToken, `uuid=${rich.uuid}`));
    expect(byUuid.result.map((row) => row.uuid)).toEqual([rich.uuid]);

    const byQuery = await listJson(await search(supplierToken, 'searchQuery=Acme'));
    expect(byQuery.result.map((row) => row.internalId)).toEqual(['FILT-1']);

    const byClass = await listJson(await search(supplierToken, 'classificationCode=002,999'));
    expect(byClass.result.map((row) => row.uuid)).toEqual([rich.uuid]);
    expect(byClass.result[0]?.classificationCodeValues).toEqual(['001', '002']);
    expect(byClass.result[0]?.totalPayableAmount).toBe(250.5);
    expect(byClass.result[0]?.submissionChannel).toBe('ERP');
    expect(byClass.result[0]?.intermediaryName).toBeNull();
    expect(byClass.result[0]?.createdByUserId).toBe(supplier.clientId);
  });

  it('returns 400 envelopes for invalid paging and incomplete search dates', async () => {
    await boot();
    const token = await login(base, supplier.clientId, supplier.clientSecret);
    await expectError(await recent(token, '?pageSize=101'), 400, 'BadStructure');
    await expectError(await recent(token, '?pageNo=0'), 400, 'BadStructure');
    await expectError(await recent(token, '?submissionDateFrom=2026-01-01T00:00:00Z'), 400, 'BadStructure');
    const missingRange = await fetch(`${base}/api/v1.0/documents/search`, { headers: authHeaders(token) });
    await expectError(missingRange, 400, 'BadStructure');
    const tooLong = await fetch(
      `${base}/api/v1.0/documents/search?submissionDateFrom=2026-01-01T00:00:00Z&submissionDateTo=2026-02-02T00:00:00Z`,
      { headers: authHeaders(token) },
    );
    await expectError(tooLong, 400, 'BadStructure');
    const dateOnly = await fetch(
      `${base}/api/v1.0/documents/search?submissionDateFrom=2026-01-01&submissionDateTo=2026-01-31`,
      { headers: authHeaders(token) },
    );
    await expectError(dateOnly, 400, 'BadStructure');
    const offsetLess = await fetch(
      `${base}/api/v1.0/documents/search?issueDateFrom=2026-01-01T00:00:00&issueDateTo=2026-01-02T00:00:00`,
      { headers: authHeaders(token) },
    );
    await expectError(offsetLess, 400, 'BadStructure');
  });

  it('limits recent results to the last 31 days on the emulator clock', async () => {
    await boot();
    const token = await login(base, supplier.clientId, supplier.clientSecret);
    await submitAs(
      token,
      invoiceJson(supplier.tin, buyer.tin, { id: 'OLD', issueDate: '2025-11-01' }),
      'OLD',
    );
    const recentIssued = await submitAs(
      token,
      invoiceJson(supplier.tin, buyer.tin, { id: 'NEW', issueDate: '2026-01-01' }),
      'NEW',
    );
    await advance(base, 2000);
    const body = await listJson(await recent(token));
    expect(body.result.map((row) => row.uuid)).toEqual([recentIssued.uuid]);

    const viaSearch = await listJson(await search(token));
    expect(viaSearch.metadata.totalCount).toBe(2);
  });

  it('pages newest first and reports metadata', async () => {
    await boot();
    const token = await login(base, supplier.clientId, supplier.clientSecret);
    const first = await submitAs(
      token,
      invoiceJson(supplier.tin, buyer.tin, { id: 'P1', issueDate: '2026-01-01' }),
      'P1',
    );
    await advance(base, 1000);
    const second = await submitAs(
      token,
      invoiceJson(supplier.tin, buyer.tin, { id: 'P2', issueDate: '2026-01-01' }),
      'P2',
    );
    await advance(base, 1000);
    const third = await submitAs(
      token,
      invoiceJson(supplier.tin, buyer.tin, { id: 'P3', issueDate: '2026-01-01' }),
      'P3',
    );
    await advance(base, 2000);

    const page1 = await listJson(await recent(token, '?pageNo=1&pageSize=2'));
    expect(page1.result.map((row) => row.uuid)).toEqual([third.uuid, second.uuid]);
    expect(page1.metadata).toEqual({ totalPages: 2, totalCount: 3 });
    const page2 = await listJson(await recent(token, '?pageNo=2&pageSize=2'));
    expect(page2.result.map((row) => row.uuid)).toEqual([first.uuid]);
    expect(page2.metadata).toEqual({ totalPages: 2, totalCount: 3 });
    const empty = await listJson(await recent(token, '?pageNo=9&pageSize=2'));
    expect(empty.result).toEqual([]);
    expect(empty.metadata.totalCount).toBe(3);
  });

  it('drops a document from recent after the 31-day window elapses', async () => {
    await boot();
    const token = await login(base, supplier.clientId, supplier.clientSecret);
    await submitAs(token, invoiceJson(supplier.tin, buyer.tin, { id: 'WIN' }), 'WIN');
    await advance(base, 2000);
    expect((await listJson(await recent(token))).metadata.totalCount).toBe(1);
    await advance(base, QUERY_WINDOW_MS);
    const later = await login(base, supplier.clientId, supplier.clientSecret);
    expect((await listJson(await recent(later))).metadata.totalCount).toBe(0);
  });
});

describe('recent and search rate limits', () => {
  let emulator: Emulator;
  let base: string;

  afterEach(async () => {
    if (emulator) await emulator.stop();
  });

  it('applies getRecent and search RPM independently', async () => {
    const started = await startServer({ rateLimit: { rpm: { getRecent: 1, search: 1 } } });
    emulator = started.emulator;
    base = started.base;
    const token = await login(base, supplier.clientId, supplier.clientSecret);
    const firstRecent = await fetch(`${base}/api/v1.0/documents/recent`, { headers: authHeaders(token) });
    expect(firstRecent.status).toBe(200);
    expect(firstRecent.headers.get('x-rate-limit-limit')).toBe('1');
    await expectError(
      await fetch(`${base}/api/v1.0/documents/recent`, { headers: authHeaders(token) }),
      429,
      'RateLimitExceeded',
    );

    const searchQs = `submissionDateFrom=${SUB_FROM}&submissionDateTo=${SUB_TO}`;
    const firstSearch = await fetch(`${base}/api/v1.0/documents/search?${searchQs}`, {
      headers: authHeaders(token),
    });
    expect(firstSearch.status).toBe(200);
    await expectError(
      await fetch(`${base}/api/v1.0/documents/search?${searchQs}`, { headers: authHeaders(token) }),
      429,
      'RateLimitExceeded',
    );

    await advance(base, RATE_LIMIT_WINDOW_MS);
    expect(
      (await fetch(`${base}/api/v1.0/documents/recent`, { headers: authHeaders(token) })).status,
    ).toBe(200);
  });
});

describe('fault keys for recent and search', () => {
  it('accepts getRecent and search as fault endpoints', async () => {
    const started = await startServer({
      rateLimit: { enabled: false },
      faults: [{ endpoint: 'getRecent', kind: 'error500', nth: [1] }],
    });
    try {
      const token = await login(started.base, supplier.clientId, supplier.clientSecret);
      await expectError(
        await fetch(`${started.base}/api/v1.0/documents/recent`, { headers: authHeaders(token) }),
        500,
        'SystemError',
      );
    } finally {
      await started.emulator.stop();
    }
  });
});

describe('clock origin', () => {
  it('uses the documented fake-clock start for date fixtures', () => {
    expect(new Date(FAKE_CLOCK_START_MS).toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});

import { request as httpRequest } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DOC_MAX_BYTES, MAX_BODY_BYTES, SUBMISSION_MAX_BYTES } from '../src/constants.js';
import { defaultConfig } from '../src/defaults.js';
import { createEmulator, type Emulator } from '../src/emulator.js';
import {
  advance,
  assertCorrelation,
  authHeaders,
  encodeDocument,
  expectError,
  login,
  minimalInvoice,
  readSample,
  startServer,
  submitRaw,
} from './helpers.js';

const tenants = defaultConfig().tenants ?? [];
const foundSupplier = tenants.find((tenant) => tenant.clientId === 'sample-supplier');
const foundBuyer = tenants.find((tenant) => tenant.clientId === 'sample-buyer');
if (!foundSupplier || !foundBuyer) throw new Error('built-in sample tenants are missing');
const supplier = foundSupplier;
const buyer = foundBuyer;

describe('http emulator', () => {
  let emulator: Emulator;
  let base: string;

  beforeEach(async () => {
    const started = await startServer();
    emulator = started.emulator;
    base = started.base;
  });

  afterEach(async () => {
    await emulator.stop();
  });

  async function supplierToken(): Promise<string> {
    return login(base, supplier.clientId, supplier.clientSecret);
  }

  it('reports health and echoes correlation ids', async () => {
    const res = await fetch(`${base}/_emulator/health`);
    assertCorrelation(res);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; clock: string };
    expect(body).toMatchObject({ status: 'ok', clock: 'fake' });
  });

  it('returns 400 for missing, placeholder, and body-less token requests', async () => {
    const missing = await fetch(`${base}/connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    await expectError(missing, 400, 'invalid_request');

    const placeholder = await fetch(`${base}/connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: 'YOUR_CLIENT_ID',
        client_secret: '0',
        scope: 'InvoicingAPI',
      }),
    });
    await expectError(placeholder, 400, 'invalid_request');

    const basicOnly = await fetch(`${base}/connect/token`, {
      method: 'POST',
      headers: { authorization: 'Basic c2FtcGxlOnNlY3JldA==' },
    });
    await expectError(basicOnly, 400, 'invalid_request');
  });

  it('returns 403 invalid_client for bad credentials', async () => {
    const res = await fetch(`${base}/connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: supplier.clientId,
        client_secret: 'wrong-secret',
        scope: 'InvoicingAPI',
      }),
    });
    await expectError(res, 403, 'invalid_client');
  });

  it('returns 401 for a missing bearer and for an expired token', async () => {
    const missing = await fetch(`${base}/api/v1.0/taxpayer/validate/C00000000000?idType=BRN&idValue=201901000001`);
    await expectError(missing, 401, 'Unauthorized');

    const token = await supplierToken();
    const ok = await fetch(`${base}/api/v1.0/taxpayer/validate/C00000000000?idType=BRN&idValue=201901000001`, {
      headers: authHeaders(token),
    });
    expect(ok.status).toBe(200);
    await advance(base, 3600 * 1000);
    const expired = await fetch(`${base}/api/v1.0/taxpayer/validate/C00000000000?idType=BRN&idValue=201901000001`, {
      headers: authHeaders(token),
    });
    await expectError(expired, 401, 'Unauthorized');
  });

  it('validates configured taxpayers and rejects unknown or incomplete queries', async () => {
    const token = await supplierToken();
    const match = await fetch(`${base}/api/v1.0/taxpayer/validate/C00000000000?idType=brn&idValue=201901000001`, {
      headers: authHeaders(token),
    });
    assertCorrelation(match);
    expect(match.status).toBe(200);
    expect(await match.text()).toBe('');

    const missingType = await fetch(`${base}/api/v1.0/taxpayer/validate/C00000000000?idValue=201901000001`, {
      headers: authHeaders(token),
    });
    await expectError(missingType, 400, 'BadStructure');

    const unknown = await fetch(`${base}/api/v1.0/taxpayer/validate/C00000000000?idType=BRN&idValue=nope`, {
      headers: authHeaders(token),
    });
    await expectError(unknown, 404, 'NotFound');
  });

  it('submits a public JSON sample and exposes raw, details, and a valid longId', async () => {
    const token = await supplierToken();
    const bytes = readSample('1.1-Invoice-Sample.json');
    const res = await submitRaw(
      base,
      token,
      JSON.stringify({ documents: [encodeDocument(bytes, 'JSON', 'JSON-INV12345')] }),
    );
    assertCorrelation(res);
    expect(res.status).toBe(202);
    const created = (await res.json()) as {
      submissionUID: string;
      acceptedDocuments: { uuid: string; invoiceCodeNumber: string }[];
      rejectedDocuments: unknown[];
    };
    expect(created.submissionUID).toMatch(/^[A-Z0-9]{26}$/);
    expect(created.rejectedDocuments).toEqual([]);
    expect(created.acceptedDocuments[0]?.invoiceCodeNumber).toBe('JSON-INV12345');
    const uuid = created.acceptedDocuments[0]?.uuid ?? '';
    expect(uuid).toMatch(/^[A-Z0-9]{26}$/);

    const pendingRes = await fetch(`${base}/api/v1.0/documentsubmissions/${created.submissionUID}`, {
      headers: authHeaders(token),
    });
    assertCorrelation(pendingRes);
    const pending = (await pendingRes.json()) as {
      overallStatus: string;
      documentSummary: { status: string; longId: string | null }[];
    };
    expect(pending.overallStatus).toBe('in progress');
    expect(pending.documentSummary[0]).toMatchObject({ status: 'Submitted', longId: null });

    await advance(base, 1999);
    const early = await fetch(`${base}/api/v1.0/documents/${uuid}/details`, { headers: authHeaders(token) });
    const earlyBody = (await early.json()) as { status: string };
    expect(earlyBody.status).toBe('Submitted');

    await advance(base, 1);
    const doneRes = await fetch(`${base}/api/v1.0/documentsubmissions/${created.submissionUID}?pageNo=1&pageSize=10`, {
      headers: authHeaders(token),
    });
    const done = (await doneRes.json()) as {
      overallStatus: string;
      pageNo: number;
      pageSize: number;
      documentSummary: { status: string; longId: string; dateTimeValidated: string }[];
    };
    expect(done.overallStatus).toBe('valid');
    expect(done.pageNo).toBe(1);
    expect(done.pageSize).toBe(10);
    expect(done.documentSummary[0]?.status).toBe('Valid');
    expect(done.documentSummary[0]?.longId).toMatch(/^[A-Z0-9]{26}$/);
    expect(done.documentSummary[0]?.dateTimeValidated).toBe('2026-01-01T00:00:02.000Z');

    const rawRes = await fetch(`${base}/api/v1.0/documents/${uuid}/raw`, { headers: authHeaders(token) });
    assertCorrelation(rawRes);
    const raw = (await rawRes.json()) as { document: string; documentHash: string };
    expect(raw.document).toBe(bytes.toString('utf8'));

    const detailsRes = await fetch(`${base}/api/v1.0/documents/${uuid}/details`, { headers: authHeaders(token) });
    const details = (await detailsRes.json()) as {
      validationResults: { status: string; validationSteps: { status: string; error: unknown }[] };
    };
    expect(details.validationResults.status).toBe('Valid');
    expect(details.validationResults.validationSteps[0]).toMatchObject({ status: 'Valid', error: null });
  });

  it('submits the public XML sample', async () => {
    const token = await supplierToken();
    const bytes = readSample('1.1-Invoice-Sample.xml');
    const res = await submitRaw(
      base,
      token,
      JSON.stringify({ documents: [encodeDocument(bytes, 'XML', 'XML-INV')] }),
    );
    expect(res.status).toBe(202);
    const created = (await res.json()) as { submissionUID: string };
    await advance(base, 2000);
    const done = await fetch(`${base}/api/v1.0/documentsubmissions/${created.submissionUID}`, {
      headers: authHeaders(token),
    });
    const body = (await done.json()) as { overallStatus: string; documentSummary: { longId: string }[] };
    expect(body.overallStatus).toBe('valid');
    expect(body.documentSummary[0]?.longId).toMatch(/^[A-Z0-9]{26}$/);
  });

  it('returns 400 BadStructure when documentHash does not match', async () => {
    const token = await supplierToken();
    const entry = encodeDocument(minimalInvoice(supplier.tin, buyer.tin), 'JSON', 'INV-HASH', 'aaaaaaaa');
    const res = await submitRaw(base, token, JSON.stringify({ documents: [entry] }));
    const error = await expectError(res, 400, 'BadStructure');
    expect(error.propertyPath).toBe('documents[0].documentHash');
    expect(Array.isArray(error.innerError)).toBe(true);
    const inner = error.innerError as { errorCode: string }[];
    expect(inner[0]?.errorCode).toBe('DocumentHashMismatch');
  });

  it('returns 400 MaximumSizeExceeded when the HTTP body exceeds 16 MiB', async () => {
    const size = MAX_BODY_BYTES + 1;
    let sent = 0;
    const chunkSize = 64 * 1024;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= size) {
          controller.close();
          return;
        }
        const n = Math.min(chunkSize, size - sent);
        sent += n;
        controller.enqueue(new Uint8Array(n));
      },
    });
    const res = await fetch(`${base}/connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body,
      // Node fetch requires duplex for a streamed body. The DOM RequestInit
      // type, which this tsconfig includes, does not declare the field.
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    const error = await expectError(res, 400, 'MaximumSizeExceeded');
    expect(error.target).toBe('body');
    expect(error.propertyPath).toBe('body');

    const health = await fetch(`${base}/_emulator/health`);
    assertCorrelation(health);
    expect(health.status).toBe(200);
  });

  it('returns 400 for a malformed request target', async () => {
    const res = await rawGet(base, '/%ZZ');
    const error = await expectError(res, 400, 'invalid_request');
    expect(error.target).toBe('url');
    expect(error.error).toMatch(/malformed/i);
  });

  it('returns 400 MaximumSizeExceeded for 101 documents and accepts 100', async () => {
    const token = await supplierToken();
    const one = (index: number) =>
      encodeDocument(minimalInvoice(supplier.tin, buyer.tin, `N-${index}`), 'JSON', `N-${index}`);
    const tooMany = await submitRaw(
      base,
      token,
      JSON.stringify({ documents: Array.from({ length: 101 }, (_, index) => one(index)) }),
    );
    await expectError(tooMany, 400, 'MaximumSizeExceeded');

    const enough = await submitRaw(
      base,
      token,
      JSON.stringify({ documents: Array.from({ length: 100 }, (_, index) => one(index)) }),
    );
    assertCorrelation(enough);
    expect(enough.status).toBe(202);
    const body = (await enough.json()) as { acceptedDocuments: unknown[] };
    expect(body.acceptedDocuments).toHaveLength(100);
  });

  it('enforces the 300KB and 301KB document limits and the 5MB submission limit', async () => {
    const token = await supplierToken();
    const sized = async (bytes: number, code: string) =>
      submitRaw(base, token, JSON.stringify({ documents: [encodeDocument(Buffer.alloc(bytes, 0x61), 'JSON', code)] }));

    const exact = await sized(DOC_MAX_BYTES, 'EXACT-300');
    expect(exact.status).toBe(202);
    const plusOne = await sized(DOC_MAX_BYTES + 1, 'PLUS-1');
    await expectError(plusOne, 400, 'MaximumSizeExceeded');
    const threeOhOne = await sized(301 * 1024, 'KB-301');
    await expectError(threeOhOne, 400, 'MaximumSizeExceeded');

    const lengths: number[] = [];
    let remaining = SUBMISSION_MAX_BYTES + 1;
    while (remaining > 0) {
      const size = Math.min(DOC_MAX_BYTES, remaining);
      lengths.push(size);
      remaining -= size;
    }
    const overTotal = await submitRaw(
      base,
      token,
      JSON.stringify({
        documents: lengths.map((size, index) => encodeDocument(Buffer.alloc(size, 0x62), 'JSON', `TOT-${index}`)),
      }),
    );
    const totalError = await expectError(overTotal, 400, 'MaximumSizeExceeded');
    expect(totalError.error).toContain(String(SUBMISSION_MAX_BYTES + 1));
  });

  it('returns 422 DuplicateSubmission inside 10 minutes and 202 after 10:01', async () => {
    const token = await supplierToken();
    const raw = JSON.stringify({
      documents: [encodeDocument(minimalInvoice(supplier.tin, buyer.tin), 'JSON', 'INV-DUP')],
    });
    const first = await submitRaw(base, token, raw);
    expect(first.status).toBe(202);

    await advance(base, 9 * 60 * 1000 + 59 * 1000);
    const duplicate = await submitRaw(base, token, raw);
    const error = await expectError(duplicate, 422, 'DuplicateSubmission');
    expect(error.errorCode).toBe('DuplicateSubmission');
    expect(duplicate.headers.get('retry-after')).toBe('2');

    await advance(base, 2 * 1000);
    const again = await submitRaw(base, token, raw);
    assertCorrelation(again);
    expect(again.status).toBe(202);
  });

  it('returns 403 IncorrectSubmitter when the supplier TIN does not match the tenant', async () => {
    const token = await supplierToken();
    const raw = JSON.stringify({
      documents: [encodeDocument(minimalInvoice('C00000000000', buyer.tin), 'JSON', 'INV-OTHER')],
    });
    const res = await submitRaw(base, token, raw);
    await expectError(res, 403, 'IncorrectSubmitter');
  });

  it('refuses a buyer cancel, a supplier reject, and a cancel of an Invalid document', async () => {
    const supplierAccess = await supplierToken();
    const buyerAccess = await login(base, buyer.clientId, buyer.clientSecret);
    const validRaw = JSON.stringify({
      documents: [encodeDocument(minimalInvoice(supplier.tin, buyer.tin), 'JSON', 'INV-PARTY')],
    });
    const created = (await (await submitRaw(base, supplierAccess, validRaw)).json()) as {
      acceptedDocuments: { uuid: string }[];
    };
    const uuid = created.acceptedDocuments[0]?.uuid ?? '';
    await advance(base, 2000);

    const buyerCancel = await fetch(`${base}/api/v1.0/documents/state/${uuid}/state`, {
      method: 'PUT',
      headers: authHeaders(buyerAccess, true),
      body: JSON.stringify({ status: 'cancelled', reason: 'buyer cannot cancel' }),
    });
    await expectError(buyerCancel, 400, 'IncorrectState');

    const supplierReject = await fetch(`${base}/api/v1.0/documents/state/${uuid}/state`, {
      method: 'PUT',
      headers: authHeaders(supplierAccess, true),
      body: JSON.stringify({ status: 'rejected', reason: 'supplier cannot reject' }),
    });
    await expectError(supplierReject, 400, 'IncorrectState');

    const buyerReject = await fetch(`${base}/api/v1.0/documents/state/${uuid}/state`, {
      method: 'PUT',
      headers: authHeaders(buyerAccess, true),
      body: JSON.stringify({ status: 'rejected', reason: 'buyer rejects within 72h' }),
    });
    assertCorrelation(buyerReject);
    expect(buyerReject.status).toBe(200);
    expect(await buyerReject.json()).toMatchObject({ uuid, status: 'Rejected' });

    const invalidRaw = JSON.stringify({
      documents: [encodeDocument(JSON.stringify({ note: 'not an invoice' }), 'JSON', 'INV-BAD')],
    });
    const invalidCreated = (await (await submitRaw(base, supplierAccess, invalidRaw)).json()) as {
      acceptedDocuments: { uuid: string }[];
      submissionUID: string;
    };
    const invalidId = invalidCreated.acceptedDocuments[0]?.uuid ?? '';
    await advance(base, 2000);
    const details = await fetch(`${base}/api/v1.0/documents/${invalidId}/details`, {
      headers: authHeaders(supplierAccess),
    });
    const detailsBody = (await details.json()) as {
      status: string;
      validationResults: { status: string; validationSteps: { error: { innerError: unknown[] } }[] };
    };
    expect(detailsBody.status).toBe('Invalid');
    expect(detailsBody.validationResults.validationSteps[0]?.error.innerError.length).toBeGreaterThan(0);
    const submission = await fetch(`${base}/api/v1.0/documentsubmissions/${invalidCreated.submissionUID}`, {
      headers: authHeaders(supplierAccess),
    });
    const submissionBody = (await submission.json()) as { overallStatus: string };
    expect(submissionBody.overallStatus).toBe('invalid');

    const cancelInvalid = await fetch(`${base}/api/v1.0/documents/state/${invalidId}/state`, {
      method: 'PUT',
      headers: authHeaders(supplierAccess, true),
      body: JSON.stringify({ status: 'cancelled', reason: 'too late to matter' }),
    });
    await expectError(cancelInvalid, 400, 'IncorrectState');
  });

  it('cancels inside 71:59:59 and refuses at 72:00:01', async () => {
    const token = await supplierToken();
    const documents = [0, 1, 2].map((index) =>
      encodeDocument(minimalInvoice(supplier.tin, buyer.tin, `WIN-${index}`), 'JSON', `WIN-${index}`),
    );
    const created = (await (await submitRaw(base, token, JSON.stringify({ documents }))).json()) as {
      acceptedDocuments: { uuid: string }[];
    };
    const uuids = created.acceptedDocuments.map((doc) => doc.uuid);
    await advance(base, 2000);

    const cancel = (uuid: string) =>
      fetch(`${base}/api/v1.0/documents/state/${uuid}/state`, {
        method: 'PUT',
        headers: authHeaders(token, true),
        body: JSON.stringify({ status: 'cancelled', reason: 'window check' }),
      });

    const immediate = await cancel(uuids[0] ?? '');
    expect(immediate.status).toBe(200);

    await advance(base, (71 * 60 * 60 + 59 * 60 + 59) * 1000);
    const laterToken = await supplierToken();
    const cancelLater = (uuid: string) =>
      fetch(`${base}/api/v1.0/documents/state/${uuid}/state`, {
        method: 'PUT',
        headers: authHeaders(laterToken, true),
        body: JSON.stringify({ status: 'cancelled', reason: 'window check' }),
      });
    const stillInside = await cancelLater(uuids[1] ?? '');
    assertCorrelation(stillInside);
    expect(stillInside.status).toBe(200);

    await advance(base, 2 * 1000);
    const outside = await cancelLater(uuids[2] ?? '');
    await expectError(outside, 400, 'OperationPeriodOver');
  });

  it('marks a mixed submission partially valid', async () => {
    const token = await supplierToken();
    const documents = [
      encodeDocument(minimalInvoice(supplier.tin, buyer.tin), 'JSON', 'GOOD'),
      encodeDocument(JSON.stringify({ note: 'nope' }), 'JSON', 'BAD'),
    ];
    const created = (await (await submitRaw(base, token, JSON.stringify({ documents }))).json()) as {
      submissionUID: string;
    };
    await advance(base, 2000);
    const res = await fetch(`${base}/api/v1.0/documentsubmissions/${created.submissionUID}?pageNo=2&pageSize=1`, {
      headers: authHeaders(token),
    });
    const body = (await res.json()) as {
      overallStatus: string;
      documentCount: number;
      documentSummary: { internalId: string }[];
    };
    expect(body.overallStatus).toBe('partially valid');
    expect(body.documentCount).toBe(2);
    expect(body.documentSummary.map((doc) => doc.internalId)).toEqual(['BAD']);
  });

  it('resets submissions and tokens', async () => {
    const token = await supplierToken();
    const created = (await (
      await submitRaw(
        base,
        token,
        JSON.stringify({
          documents: [encodeDocument(minimalInvoice(supplier.tin, buyer.tin), 'JSON', 'RESET')],
        }),
      )
    ).json()) as { submissionUID: string };
    const reset = await fetch(`${base}/_emulator/reset`, { method: 'POST' });
    assertCorrelation(reset);
    expect(reset.status).toBe(200);
    const after = await fetch(`${base}/api/v1.0/documentsubmissions/${created.submissionUID}`, {
      headers: authHeaders(token),
    });
    await expectError(after, 401, 'Unauthorized');
    const state = await fetch(`${base}/_emulator/state`);
    const snapshot = (await state.json()) as { submissionCount: number; documentCount: number };
    expect(snapshot.submissionCount).toBe(0);
    expect(snapshot.documentCount).toBe(0);
  });

  it('repeats submission ids for the same seed', async () => {
    const other = await startServer({ seed: 42 });
    try {
      const raw = JSON.stringify({
        documents: [encodeDocument(minimalInvoice(supplier.tin, buyer.tin), 'JSON', 'DET')],
      });
      const tokenA = await supplierToken();
      const tokenB = await login(other.base, supplier.clientId, supplier.clientSecret);
      expect(tokenA).toBe(tokenB);
      const bodyA = (await (await submitRaw(base, tokenA, raw)).json()) as { submissionUID: string };
      const bodyB = (await (await submitRaw(other.base, tokenB, raw)).json()) as { submissionUID: string };
      expect(bodyA.submissionUID).toBe(bodyB.submissionUID);
    } finally {
      await other.emulator.stop();
    }
  });
});

function rawGet(base: string, path: string): Promise<Response> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: url.hostname, port: url.port, path, method: 'GET' }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => {
        const correlation = incoming.headers.correlationid;
        const correlationId = Array.isArray(correlation) ? correlation[0] : correlation;
        const headers = new Headers();
        if (correlationId !== undefined) headers.set('correlationid', correlationId);
        resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode ?? 0, headers }));
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('handler failures', () => {
  it('returns the SystemError envelope and correlationId when the handler throws', async () => {
    const emulator = createEmulator({
      host: '127.0.0.1',
      clock: {
        now() {
          throw new Error('injected clock failure');
        },
      },
    });
    const info = await emulator.start({ port: 0, host: '127.0.0.1' });
    try {
      const res = await fetch(`${info.url}/_emulator/health`);
      await expectError(res, 500, 'SystemError');
    } finally {
      await emulator.stop();
    }
  });
});

describe('real clock', () => {
  it('rejects clock advance', async () => {
    const started = await startServer({ clock: 'real' });
    try {
      const res = await fetch(`${started.base}/_emulator/clock/advance`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ms: 1 }),
      });
      await expectError(res, 400, 'BadStructure');
    } finally {
      await started.emulator.stop();
    }
  });
});

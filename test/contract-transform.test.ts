import { describe, expect, it } from 'vitest';
import {
  CLOCK_ADVANCE_MS,
  CLOCK_ADVANCE_NAME,
  IN_SCOPE,
  PINNED_SHA256,
  SKIPPED,
  SYNTHETIC,
  assertPinnedSha256,
  findMissingInScope,
  listRequestNames,
  sha256Hex,
  transformCollection,
} from '../scripts/contract-transform.mjs';

interface PostmanUrl {
  raw?: string;
  protocol?: string;
  host?: string[];
  port?: string;
  path?: string[];
  query?: Array<{ key: string; value?: string }>;
  variable?: Array<{ key: string; value?: string }>;
}

interface PostmanRequest {
  method?: string;
  header?: Array<{ key: string; value?: string }>;
  url?: string | PostmanUrl;
  body?: {
    mode?: string;
    raw?: string;
    urlencoded?: Array<{ key: string; value?: string }>;
  };
  auth?: { type?: string; bearer?: Array<{ key: string; value?: string }> };
}

interface PostmanItem {
  name: string;
  disabled?: boolean;
  request?: PostmanRequest | string;
  event?: Array<{ listen?: string; script?: { exec?: string[] } }>;
  item?: PostmanItem[];
}

interface PostmanCollection {
  info?: { name?: string; schema?: string };
  item: PostmanItem[];
}

const BASE = 'http://127.0.0.1:8787';
const DOCUMENT = Buffer.from('{"Invoice":[]}', 'utf8').toString('base64');
const HASH = 'abc123def456';

function requestItem(
  name: string,
  url: string | PostmanUrl,
  extra?: {
    request?: Partial<PostmanRequest>;
    disabled?: boolean;
    event?: PostmanItem['event'];
  },
): PostmanItem {
  const request: PostmanRequest = {
    method: extra?.request?.method ?? 'GET',
    header: extra?.request?.header,
    url: extra?.request?.url ?? url,
    body: extra?.request?.body,
    auth: extra?.request?.auth,
  };
  return { name, disabled: extra?.disabled, event: extra?.event, request };
}

function loginItem(name: string): PostmanItem {
  return requestItem(
    name,
    {
      raw: 'https://{{idSrvBaseUrl}}/connect/token',
      protocol: 'https',
      host: ['{{idSrvBaseUrl}}'],
      path: ['connect', 'token'],
    },
    {
      request: {
        method: 'POST',
        body: {
          mode: 'urlencoded',
          urlencoded: [
            { key: 'client_id', value: '{{clientId}}' },
            { key: 'client_secret', value: '{{clientSecret}}' },
            { key: 'grant_type', value: 'client_credentials' },
            { key: 'scope', value: 'InvoicingAPI' },
          ],
        },
      },
    },
  );
}

function fullCollection(omit?: string): PostmanCollection {
  const einvoicing: PostmanItem[] = [
    requestItem('Validate taxpayer TIN', {
      raw: 'https://{{apiBaseUrl}}/api/v1.0/taxpayer/validate/{tin}?idType={idType}&idValue={idValue}',
      protocol: 'https',
      host: ['{{apiBaseUrl}}'],
      path: ['api', 'v1.0', 'taxpayer', 'validate', '{tin}'],
      query: [
        { key: 'idType', value: '{idType}' },
        { key: 'idValue', value: '{idValue}' },
      ],
    }),
    requestItem(
      'Submit Documents',
      {
        raw: 'https://{{apiBaseUrl}}/api/v1.0/documentsubmissions',
        protocol: 'https',
        host: ['{{apiBaseUrl}}'],
        path: ['api', 'v1.0', 'documentsubmissions'],
      },
      {
        request: {
          method: 'POST',
          body: { mode: 'raw', raw: '{"documents":[]}' },
          auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{generatedAccessToken}}' }] },
        },
      },
    ),
    requestItem(
      'Cancel Document',
      {
        raw: 'https://{{apiBaseUrl}}/api/v1.0/documents/state/:uuid/state',
        protocol: 'https',
        host: ['{{apiBaseUrl}}'],
        path: ['api', 'v1.0', 'documents', 'state', ':uuid', 'state'],
        variable: [{ key: 'uuid', value: '' }],
      },
      { request: { method: 'PUT', body: { mode: 'raw', raw: '{"status":"cancelled","reason":"x"}' } } },
    ),
    requestItem(
      'Reject Document',
      {
        raw: 'https://{{apiBaseUrl}}/api/v1.0/documents/state/:uuid/state',
        protocol: 'https',
        host: ['{{apiBaseUrl}}'],
        path: ['api', 'v1.0', 'documents', 'state', ':uuid', 'state'],
        variable: [{ key: 'uuid', value: '' }],
      },
      { request: { method: 'PUT', body: { mode: 'raw', raw: '{"status":"rejected","reason":"x"}' } } },
    ),
    requestItem('Get Recent Documents', 'https://{{apiBaseUrl}}/api/v1.0/documents/recent?pageNo={pageNo}'),
    requestItem('Get Submission', {
      raw: 'https://{{apiBaseUrl}}/api/v1.0/documentsubmissions/:submissionUid',
      protocol: 'https',
      host: ['{{apiBaseUrl}}'],
      path: ['api', 'v1.0', 'documentsubmissions', ':submissionUid'],
      variable: [{ key: 'submissionUid', value: '' }],
    }),
    requestItem('Get Document', {
      raw: 'https://{{apiBaseUrl}}/api/v1.0/documents/:documentUUID/raw',
      protocol: 'https',
      host: ['{{apiBaseUrl}}'],
      path: ['api', 'v1.0', 'documents', ':documentUUID', 'raw'],
      variable: [{ key: 'documentUUID', value: '' }],
    }),
    requestItem('Get Document Details', {
      raw: 'https://{{apiBaseUrl}}/api/v1.0/documents/:uuid/details',
      protocol: 'https',
      host: ['{{apiBaseUrl}}'],
      path: ['api', 'v1.0', 'documents', ':uuid', 'details'],
      variable: [{ key: 'uuid', value: '' }],
    }),
    requestItem('Search Documents', 'https://{{apiBaseUrl}}/api/v1.0/documents/search?uuid={uuid}'),
  ];
  const platform: PostmanItem[] = [
    loginItem('Login as Taxpayer System'),
    loginItem('Login as Intermediary System'),
    requestItem('Get All Document Types', 'https://{{apiBaseUrl}}/api/v1.0/documenttypes'),
    requestItem('Get Document Type', {
      raw: 'https://{{apiBaseUrl}}/api/v1.0/documenttypes/:id',
      path: ['api', 'v1.0', 'documenttypes', ':id'],
      variable: [{ key: 'id', value: '' }],
    }),
    requestItem('Get Document Type Version', 'https://{{apiBaseUrl}}/api/v1.0/documenttypes/:Id/versions/:vid'),
    requestItem('Get Notifications', 'https://{{apiBaseUrl}}/api/v1.0/notifications/taxpayer'),
  ];
  const drop = (items: PostmanItem[]) => (omit ? items.filter((item) => item.name !== omit) : items);
  return {
    info: {
      name: 'LHDN MyInvois SDK',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: [
      { name: 'Platform', item: drop(platform) },
      { name: 'EInvoicing', item: drop(einvoicing) },
    ],
  };
}

function transform(collection: PostmanCollection = fullCollection()) {
  return transformCollection(collection, {
    baseUrl: BASE,
    documentBase64: DOCUMENT,
    documentHash: HASH,
  });
}

function flatten(items: unknown[]): PostmanItem[] {
  const out: PostmanItem[] = [];
  for (const raw of items) {
    const item = raw as PostmanItem;
    if (Array.isArray(item.item)) out.push(...flatten(item.item));
    else out.push(item);
  }
  return out;
}

function byName(items: PostmanItem[], name: string): PostmanItem {
  const found = items.find((item) => item.name === name);
  if (!found) throw new Error(`missing item ${name}`);
  return found;
}

function requestOf(item: PostmanItem): PostmanRequest {
  if (item.request === undefined || typeof item.request === 'string') {
    throw new Error(`expected object request on ${item.name}`);
  }
  return item.request;
}

function urlOf(item: PostmanItem): PostmanUrl {
  const url = requestOf(item).url;
  if (url === undefined || typeof url === 'string') throw new Error(`expected object url on ${item.name}`);
  return url;
}

function scriptText(item: PostmanItem): string {
  const tests = (item.event ?? []).filter((event) => event.listen === 'test');
  return tests
    .flatMap((event) => event.script?.exec ?? [])
    .join('\n');
}

describe('assertPinnedSha256', () => {
  it('returns the digest when it matches a provided expected value', () => {
    const bytes = Buffer.from('synthetic-collection');
    const digest = sha256Hex(bytes);
    expect(assertPinnedSha256(bytes, digest)).toBe(digest);
  });

  it('throws a sha mismatch error against the pinned digest', () => {
    expect(() => assertPinnedSha256(Buffer.from('nope'))).toThrow(/sha256 mismatch/);
    expect(() => assertPinnedSha256(Buffer.from('nope'))).toThrow(PINNED_SHA256);
    expect(() => assertPinnedSha256(Buffer.from('nope'))).toThrow(/update PINNED_SHA256/);
  });
});

describe('findMissingInScope', () => {
  it('lists official in-scope names that the collection does not contain', () => {
    const missing = findMissingInScope(fullCollection('Submit Documents'));
    expect(missing).toEqual(['Submit Documents']);
  });

  it('returns an empty list when every in-scope name is present', () => {
    expect(findMissingInScope(fullCollection())).toEqual([]);
    expect(listRequestNames(fullCollection())).toEqual(
      expect.arrayContaining(IN_SCOPE.map((request) => request.name)),
    );
  });
});

describe('transformCollection', () => {
  it('rewrites idSrv and api hosts to the emulator http base URL', () => {
    const { collection } = transform();
    const items = flatten(collection.item);
    const login = urlOf(byName(items, 'Login as Taxpayer System'));
    const submit = urlOf(byName(items, 'Submit Documents'));
    expect(login.raw).toBe(`${BASE}/connect/token`);
    expect(login.protocol).toBe('http');
    expect(login.host).toEqual(['127.0.0.1']);
    expect(login.port).toBe('8787');
    expect(submit.raw).toBe(`${BASE}/api/v1.0/documentsubmissions`);
    expect(submit.raw).not.toContain('{{apiBaseUrl}}');
    expect(submit.raw).not.toContain('https://');
  });

  it('fills path, query, and login placeholders with synthetic tenant values', () => {
    const { collection } = transform();
    const items = flatten(collection.item);
    const tin = urlOf(byName(items, 'Validate taxpayer TIN'));
    expect(tin.path).toEqual(['api', 'v1.0', 'taxpayer', 'validate', SYNTHETIC.tin]);
    expect(tin.query).toEqual([
      { key: 'idType', value: SYNTHETIC.idType },
      { key: 'idValue', value: SYNTHETIC.idValue },
    ]);
    expect(tin.raw).toBe(
      `${BASE}/api/v1.0/taxpayer/validate/${SYNTHETIC.tin}?idType=${SYNTHETIC.idType}&idValue=${SYNTHETIC.idValue}`,
    );

    const getDoc = urlOf(byName(items, 'Get Document'));
    expect(getDoc.path?.includes('{{documentUUID}}')).toBe(true);
    expect(getDoc.variable?.[0]?.value).toBe('{{documentUUID}}');

    const getSub = urlOf(byName(items, 'Get Submission'));
    expect(getSub.path?.includes('{{submissionUid}}')).toBe(true);

    const taxpayer = requestOf(byName(items, 'Login as Taxpayer System')).body?.urlencoded ?? [];
    expect(taxpayer.find((entry) => entry.key === 'client_id')?.value).toBe(SYNTHETIC.taxpayerClientId);
    expect(taxpayer.find((entry) => entry.key === 'client_secret')?.value).toBe(SYNTHETIC.taxpayerClientSecret);

    const intermediary = requestOf(byName(items, 'Login as Intermediary System')).body?.urlencoded ?? [];
    expect(intermediary.find((entry) => entry.key === 'client_id')?.value).toBe(SYNTHETIC.intermediaryClientId);
    expect(intermediary.find((entry) => entry.key === 'client_secret')?.value).toBe(
      SYNTHETIC.intermediaryClientSecret,
    );

    const submitBody = JSON.parse(requestOf(byName(items, 'Submit Documents')).body?.raw ?? '{}') as {
      documents: Array<{ format: string; document: string; documentHash: string; codeNumber: string }>;
    };
    expect(submitBody.documents).toEqual([
      {
        format: 'JSON',
        document: DOCUMENT,
        documentHash: HASH,
        codeNumber: SYNTHETIC.codeNumber,
      },
    ]);
  });

  it('injects Postman assertions and capture scripts', () => {
    const { collection } = transform();
    const items = flatten(collection.item);
    expect(scriptText(byName(items, 'Login as Taxpayer System'))).toContain('pm.response.to.have.status(200)');
    expect(scriptText(byName(items, 'Login as Taxpayer System'))).toContain('generatedAccessToken');
    expect(scriptText(byName(items, 'Submit Documents'))).toContain('pm.response.to.have.status(202)');
    expect(scriptText(byName(items, 'Submit Documents'))).toContain('submissionUID');
    expect(scriptText(byName(items, 'Reject Document'))).toContain('pm.response.to.have.status(400)');
    expect(scriptText(byName(items, CLOCK_ADVANCE_NAME))).toContain('pm.response.to.have.status(200)');
  });

  it('detects missing in-scope requests before transforming', () => {
    expect(() => transform(fullCollection('Get Document'))).toThrow(
      /missing in-scope requests: Get Document/,
    );
  });

  it('omits skipped platform and search requests from the runnable collection and inserts the clock helper after Submit', () => {
    const { collection, skipped, helper } = transform();
    const items = flatten(collection.item);
    const names = items.map((item) => item.name);
    expect(names.indexOf('Submit Documents')).toBeLessThan(names.indexOf(CLOCK_ADVANCE_NAME));
    expect(names.indexOf(CLOCK_ADVANCE_NAME)).toBeLessThan(names.indexOf('Get Submission'));
    expect(helper).toEqual({ name: CLOCK_ADVANCE_NAME, expectedStatus: 200 });
    expect(CLOCK_ADVANCE_MS).toBe(2000);

    for (const entry of SKIPPED) {
      expect(names).not.toContain(entry.name);
    }
    expect(skipped.every((entry) => entry.present)).toBe(true);
    expect(skipped.map((entry) => entry.reason)).toEqual(SKIPPED.map((entry) => entry.reason));
  });

  it('refuses a non-loopback emulator base URL', () => {
    expect(() =>
      transformCollection(fullCollection(), {
        baseUrl: 'https://preprod-api.myinvois.hasil.gov.my',
        documentBase64: DOCUMENT,
        documentHash: HASH,
      }),
    ).toThrow(/non-loopback/);
  });

  it('does not mutate the input collection', () => {
    const input = fullCollection();
    const before = JSON.stringify(input);
    transform(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

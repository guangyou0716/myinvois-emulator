import { createHash } from 'node:crypto';

/** Official collection URL. The space in the filename is percent-encoded. */
export const COLLECTION_URL =
  'https://sdk.myinvois.hasil.gov.my/files/EInvoicing%20SDK.postman_collection.json';

/** sha256 of the official collection as of 2026-11-11. */
export const PINNED_SHA256 = '0d06b70e63648bf68a267b7fb1e88a7c4c0d7193946f5973d09271823ca3ee79';

export const CLOCK_ADVANCE_NAME = '[emulator] advance validation clock';
export const CLOCK_ADVANCE_MS = 2000;

/** Built-in fake tenants / ids used to fill the official placeholders. */
export const SYNTHETIC = {
  taxpayerClientId: 'sample-supplier',
  taxpayerClientSecret: 'sample-supplier-secret',
  intermediaryClientId: 'intermediary-a',
  intermediaryClientSecret: 'intermediary-a-secret',
  /** A taxpayer the built-in intermediary is authorized to represent. */
  intermediaryOnBehalfOf: 'C00000000000',
  tin: 'C00000000000',
  idType: 'BRN',
  idValue: '201901000001',
  codeNumber: 'INV-CONTRACT-1',
  format: 'JSON',
  /** Covers the fake-clock origin used by `npm run contract` (2026-01-01). */
  submissionDateFrom: '2026-01-01T00:00:00Z',
  submissionDateTo: '2026-01-31T23:59:59Z',
};

/**
 * Official collection request names that must run, in dependency order.
 * Login as Intermediary System returns 200: the runner replaces the
 * collection's onbehalfof value with a taxpayer that the built-in
 * intermediary is authorized to represent.
 * Reject Document is 400 because this sequence cancels the same uuid first
 * (supplier token, already Cancelled → IncorrectState).
 */
export const IN_SCOPE = [
  { name: 'Login as Taxpayer System', expectedStatus: 200, capture: 'token' },
  {
    name: 'Login as Intermediary System',
    expectedStatus: 200,
    note: 'onbehalfof is set to a taxpayer the built-in intermediary is authorized to represent',
  },
  { name: 'Validate taxpayer TIN', expectedStatus: 200 },
  { name: 'Submit Documents', expectedStatus: 202, capture: 'submission' },
  { name: 'Get Submission', expectedStatus: 200 },
  { name: 'Get Document', expectedStatus: 200 },
  { name: 'Get Document Details', expectedStatus: 200 },
  { name: 'Get Recent Documents', expectedStatus: 200 },
  { name: 'Search Documents', expectedStatus: 200 },
  { name: 'Cancel Document', expectedStatus: 200 },
  {
    name: 'Reject Document',
    expectedStatus: 400,
    note: 'same uuid after Cancel, supplier token; document is already Cancelled so the emulator returns 400 IncorrectState',
  },
];

export const SKIPPED = [
  {
    name: 'Get All Document Types',
    reason: 'Platform document types are not implemented by the emulator',
  },
  {
    name: 'Get Document Type',
    reason: 'Platform document types are not implemented by the emulator',
  },
  {
    name: 'Get Document Type Version',
    reason: 'Platform document types are not implemented by the emulator',
  },
  {
    name: 'Get Notifications',
    reason: 'Platform notifications are not implemented by the emulator',
  },
];

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function assertPinnedSha256(bytes, expected = PINNED_SHA256) {
  const actual = sha256Hex(bytes);
  if (actual !== expected) {
    throw new Error(
      `Official MyInvois Postman collection sha256 mismatch.\nexpected: ${expected}\nactual:   ${actual}\nLHDN has published a new collection. Review the request list, then update PINNED_SHA256 in scripts/contract-transform.mjs and the pin in README.md.`,
    );
  }
  return actual;
}

export function listRequestNames(collection) {
  const names = [];
  walkItems(collection?.item, (item) => {
    if (item.request && typeof item.name === 'string') names.push(item.name);
  });
  return names;
}

export function findMissingInScope(collection) {
  const names = new Set(listRequestNames(collection));
  return IN_SCOPE.filter((request) => !names.has(request.name)).map((request) => request.name);
}

/**
 * Rewrite LHDN hosts to the emulator, fill placeholders, inject status
 * assertions, reorder in-scope requests, drop skipped ones from the runnable
 * collection, and insert a fake-clock advance after Submit Documents.
 *
 * @param {object} collection
 * @param {{
 *   baseUrl: string,
 *   documentBase64: string,
 *   documentHash: string,
 *   format?: string,
 *   codeNumber?: string,
 *   taxpayerClientId?: string,
 *   taxpayerClientSecret?: string,
 *   intermediaryClientId?: string,
 *   intermediaryClientSecret?: string,
 *   intermediaryOnBehalfOf?: string,
 *   tin?: string,
 *   idType?: string,
 *   idValue?: string,
 * }} options
 */
export function transformCollection(collection, options) {
  if (options === undefined || options === null || typeof options !== 'object') {
    throw new Error('transform options are required');
  }
  const baseUrl = options.baseUrl;
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw new Error('baseUrl is required');
  }
  if (!baseUrl.startsWith('http://127.0.0.1')) {
    throw new Error(`refusing non-loopback base URL ${baseUrl}`);
  }
  if (typeof options.documentBase64 !== 'string' || options.documentBase64.length === 0) {
    throw new Error('documentBase64 is required');
  }
  if (typeof options.documentHash !== 'string' || options.documentHash.length === 0) {
    throw new Error('documentHash is required');
  }

  const missing = findMissingInScope(collection);
  if (missing.length > 0) {
    throw new Error(
      `Official MyInvois Postman collection is missing in-scope requests: ${missing.join(', ')}`,
    );
  }

  const fills = {
    tin: options.tin ?? SYNTHETIC.tin,
    idType: options.idType ?? SYNTHETIC.idType,
    idValue: options.idValue ?? SYNTHETIC.idValue,
    documentVar: '{{documentUUID}}',
    submissionVar: '{{submissionUid}}',
    brace: {
      tin: options.tin ?? SYNTHETIC.tin,
      idType: options.idType ?? SYNTHETIC.idType,
      idValue: options.idValue ?? SYNTHETIC.idValue,
      submissionDateFrom: SYNTHETIC.submissionDateFrom,
      submissionDateTo: SYNTHETIC.submissionDateTo,
    },
  };

  const byName = indexByName(collection);
  const inScopeItems = [];
  for (const spec of IN_SCOPE) {
    const item = structuredClone(byName.get(spec.name));
    transformRequestItem(item, spec, options, fills);
    inScopeItems.push(item);
    if (spec.name === 'Submit Documents') {
      inScopeItems.push(clockAdvanceItem(baseUrl));
    }
  }

  const skipped = SKIPPED.map((entry) => ({
    name: entry.name,
    reason: entry.reason,
    present: byName.has(entry.name),
  }));

  const info = collection.info && typeof collection.info === 'object' ? { ...collection.info } : {};
  const originalName = typeof info.name === 'string' ? info.name : 'MyInvois';
  info.name = `${originalName} (emulator contract)`;
  if (typeof info.schema !== 'string') {
    info.schema = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
  }

  return {
    collection: {
      info,
      variable: [
        { key: 'generatedAccessToken', value: '' },
        { key: 'submissionUid', value: '' },
        { key: 'documentUUID', value: '' },
      ],
      item: [{ name: 'In scope', item: inScopeItems }],
    },
    inScope: IN_SCOPE.map((request) => ({
      name: request.name,
      expectedStatus: request.expectedStatus,
      note: request.note,
    })),
    skipped,
    helper: { name: CLOCK_ADVANCE_NAME, expectedStatus: 200 },
  };
}

function walkItems(items, visit) {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue;
    visit(item);
    if (Array.isArray(item.item)) walkItems(item.item, visit);
  }
}

function indexByName(collection) {
  const map = new Map();
  walkItems(collection?.item, (item) => {
    if (item.request && typeof item.name === 'string') map.set(item.name, item);
  });
  return map;
}

function transformRequestItem(item, spec, options, fills) {
  const request =
    typeof item.request === 'string'
      ? { url: item.request }
      : item.request && typeof item.request === 'object'
        ? item.request
        : {};
  item.request = request;
  request.url = transformUrl(request.url, options.baseUrl, fills);
  if (spec.name === 'Get Recent Documents' || spec.name === 'Search Documents') {
    request.url = sanitizeListQuery(request.url, spec.name, fills);
  }

  if (spec.name === 'Login as Taxpayer System') {
    fillLoginBody(
      request,
      options.taxpayerClientId ?? SYNTHETIC.taxpayerClientId,
      options.taxpayerClientSecret ?? SYNTHETIC.taxpayerClientSecret,
    );
  } else if (spec.name === 'Login as Intermediary System') {
    fillLoginBody(
      request,
      options.intermediaryClientId ?? SYNTHETIC.intermediaryClientId,
      options.intermediaryClientSecret ?? SYNTHETIC.intermediaryClientSecret,
    );
    request.header = setHeader(
      request.header,
      'onbehalfof',
      options.intermediaryOnBehalfOf ?? SYNTHETIC.intermediaryOnBehalfOf,
    );
  } else if (spec.name === 'Submit Documents') {
    request.body = {
      mode: 'raw',
      raw: JSON.stringify({
        documents: [
          {
            format: options.format ?? SYNTHETIC.format,
            document: options.documentBase64,
            documentHash: options.documentHash,
            codeNumber: options.codeNumber ?? SYNTHETIC.codeNumber,
          },
        ],
      }),
    };
    request.header = ensureHeader(request.header, 'Content-Type', 'application/json');
  } else if (spec.name === 'Cancel Document' || spec.name === 'Reject Document') {
    request.header = ensureHeader(request.header, 'Content-Type', 'application/json');
  }

  const extra = [];
  if (spec.capture === 'token') {
    extra.push(
      'try {',
      '    var json = pm.response.json();',
      '    if (json && json.access_token) {',
      '        pm.collectionVariables.set("generatedAccessToken", json.access_token);',
      '    }',
      '} catch (e) {}',
    );
  } else if (spec.capture === 'submission') {
    extra.push(
      'try {',
      '    var json = pm.response.json();',
      '    if (json && json.submissionUID) {',
      '        pm.collectionVariables.set("submissionUid", json.submissionUID);',
      '    }',
      '    if (json && Array.isArray(json.acceptedDocuments) && json.acceptedDocuments[0] && json.acceptedDocuments[0].uuid) {',
      '        pm.collectionVariables.set("documentUUID", json.acceptedDocuments[0].uuid);',
      '    }',
      '} catch (e) {}',
    );
  }

  const events = Array.isArray(item.event) ? item.event.slice() : [];
  events.push(statusTestEvent(spec.expectedStatus, extra));
  item.event = events;
}

function fillLoginBody(request, clientId, clientSecret) {
  if (request.body === undefined || request.body === null || request.body.mode !== 'urlencoded') return;
  if (!Array.isArray(request.body.urlencoded)) return;
  request.body.urlencoded = request.body.urlencoded.map((entry) => {
    const next = { ...entry };
    if (next.key === 'client_id') next.value = clientId;
    else if (next.key === 'client_secret') next.value = clientSecret;
    return next;
  });
}

function setHeader(headers, key, value) {
  const list = Array.isArray(headers)
    ? headers.filter((header) => String(header.key).toLowerCase() !== key.toLowerCase()).map((header) => ({ ...header }))
    : [];
  list.push({ key, value, type: 'text' });
  return list;
}

function ensureHeader(headers, key, value) {
  const list = Array.isArray(headers) ? headers.map((header) => ({ ...header })) : [];
  const exists = list.some((header) => String(header.key).toLowerCase() === key.toLowerCase());
  if (!exists) list.push({ key, value, type: 'text' });
  return list;
}

function statusTestEvent(status, extra = []) {
  return {
    listen: 'test',
    script: {
      type: 'text/javascript',
      exec: [
        `pm.test("expected status ${status}", function () {`,
        `    pm.response.to.have.status(${status});`,
        '});',
        ...extra,
      ],
    },
  };
}

function clockAdvanceItem(baseUrl) {
  return {
    name: CLOCK_ADVANCE_NAME,
    request: {
      method: 'POST',
      header: [{ key: 'Content-Type', value: 'application/json', type: 'text' }],
      body: { mode: 'raw', raw: JSON.stringify({ ms: CLOCK_ADVANCE_MS }) },
      url: transformUrl(`${baseUrl}/_emulator/clock/advance`, baseUrl, {
        tin: SYNTHETIC.tin,
        idType: SYNTHETIC.idType,
        idValue: SYNTHETIC.idValue,
        documentVar: '{{documentUUID}}',
        submissionVar: '{{submissionUid}}',
        brace: {},
      }),
    },
    event: [statusTestEvent(200)],
  };
}

function isUnfilledPlaceholder(value) {
  return typeof value === 'string' && /^\{[^{}]+\}$/.test(value);
}

function queryHas(query, key) {
  return query.some((entry) => entry.key === key && entry.disabled !== true);
}

/**
 * Official recent/search requests ship every filter as `{placeholder}`.
 * Keep params we can fill with synthetic values; drop the rest so the
 * emulator does not 400 on invalid direction/status/uuid placeholders.
 */
function sanitizeListQuery(url, name, fills) {
  const parsed = url && typeof url === 'object' ? { ...url } : { raw: '' };
  const query = Array.isArray(parsed.query) ? parsed.query.map((entry) => ({ ...entry })) : [];
  const kept = [];
  for (const entry of query) {
    let value = entry.value;
    if (name === 'Search Documents' && entry.key === 'uuid' && isUnfilledPlaceholder(value)) {
      value = fills.documentVar;
    }
    if (
      name === 'Search Documents' &&
      (entry.key === 'submissionDateFrom' || entry.key === 'submissionDateTo') &&
      isUnfilledPlaceholder(value)
    ) {
      value = fills.brace[entry.key];
    }
    if (isUnfilledPlaceholder(value)) continue;
    kept.push({ ...entry, value });
  }
  if (name === 'Search Documents') {
    if (!queryHas(kept, 'submissionDateFrom')) {
      kept.push({ key: 'submissionDateFrom', value: SYNTHETIC.submissionDateFrom });
    }
    if (!queryHas(kept, 'submissionDateTo')) {
      kept.push({ key: 'submissionDateTo', value: SYNTHETIC.submissionDateTo });
    }
  }
  parsed.query = kept;
  const path = Array.isArray(parsed.path) ? parsed.path : [];
  const pathPart = path.length > 0 ? `/${path.join('/')}` : '/';
  const enabled = kept.filter((entry) => entry.disabled !== true);
  const qs =
    enabled.length > 0 ? `?${enabled.map((entry) => `${entry.key}=${entry.value ?? ''}`).join('&')}` : '';
  const raw = typeof parsed.raw === 'string' ? parsed.raw : '';
  const originMatch = /^(https?:\/\/[^/]+)/.exec(raw);
  const origin = originMatch?.[1] ?? '';
  parsed.raw = `${origin}${pathPart}${qs}`;
  return parsed;
}

function fillExactBrace(value, brace) {
  if (typeof value !== 'string') return value;
  const match = /^\{([^{}]+)\}$/.exec(value);
  if (match && Object.hasOwn(brace, match[1])) return brace[match[1]];
  return value;
}

function fillPathSegment(segment, fills) {
  if (segment === ':uuid' || segment === ':documentUUID') return fills.documentVar;
  if (segment === ':submissionUid') return fills.submissionVar;
  return fillExactBrace(segment, fills.brace);
}

function fillUrlVariable(key, value, fills) {
  if (key === 'uuid' || key === 'documentUUID') return fills.documentVar;
  if (key === 'submissionUid') return fills.submissionVar;
  return fillExactBrace(value, fills.brace);
}

function rewriteHostString(raw, baseUrl) {
  if (typeof raw !== 'string') return '';
  return raw
    .replaceAll('https://{{idSrvBaseUrl}}', baseUrl)
    .replaceAll('http://{{idSrvBaseUrl}}', baseUrl)
    .replaceAll('https://{{apiBaseUrl}}', baseUrl)
    .replaceAll('http://{{apiBaseUrl}}', baseUrl);
}

function transformUrl(url, baseUrl, fills) {
  const parsed = typeof url === 'string' ? { raw: url } : url && typeof url === 'object' ? { ...url } : { raw: '' };
  if (Array.isArray(parsed.path)) parsed.path = parsed.path.map((segment) => String(segment));
  if (Array.isArray(parsed.query)) parsed.query = parsed.query.map((entry) => ({ ...entry }));
  if (Array.isArray(parsed.variable)) parsed.variable = parsed.variable.map((entry) => ({ ...entry }));
  if (Array.isArray(parsed.host)) parsed.host = parsed.host.slice();

  const rewritten = rewriteHostString(typeof parsed.raw === 'string' ? parsed.raw : '', baseUrl);
  const base = new URL(baseUrl);

  let path = Array.isArray(parsed.path) ? parsed.path.map((segment) => fillPathSegment(segment, fills)) : [];
  if (path.length === 0 && rewritten.length > 0) {
    try {
      path = new URL(rewritten).pathname.split('/').filter((part) => part.length > 0).map((segment) =>
        fillPathSegment(decodeURIComponent(segment), fills),
      );
    } catch {
      path = [];
    }
  } else {
    path = path.map((segment) => fillPathSegment(segment, fills));
  }

  let query = Array.isArray(parsed.query)
    ? parsed.query.map((entry) => ({ ...entry, value: fillExactBrace(entry.value, fills.brace) }))
    : undefined;

  if (query === undefined && rewritten.includes('?')) {
    try {
      query = [...new URL(rewritten).searchParams.entries()].map(([key, value]) => ({
        key,
        value: fillExactBrace(value, fills.brace),
      }));
    } catch {
      query = undefined;
    }
  }

  const variable = Array.isArray(parsed.variable)
    ? parsed.variable.map((entry) => ({
        ...entry,
        value: fillUrlVariable(entry.key, entry.value, fills),
      }))
    : undefined;

  const pathPart = path.length > 0 ? `/${path.join('/')}` : '/';
  let qs = '';
  if (Array.isArray(query) && query.length > 0) {
    const enabled = query.filter((entry) => entry.disabled !== true);
    if (enabled.length > 0) {
      qs = `?${enabled.map((entry) => `${entry.key}=${entry.value ?? ''}`).join('&')}`;
    }
  }

  parsed.raw = `${baseUrl}${pathPart}${qs}`;
  parsed.protocol = 'http';
  parsed.host = [base.hostname];
  if (base.port) parsed.port = base.port;
  parsed.path = path;
  if (query !== undefined) parsed.query = query;
  if (variable !== undefined) parsed.variable = variable;
  return parsed;
}

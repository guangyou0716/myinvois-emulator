import {
  MAX_PAGE_SIZE,
  MAX_QUERY_RESULTS,
  QUERY_PAGE_SIZE_DEFAULT,
  QUERY_WINDOW_MS,
} from './constants.js';
import { PARTY_ID_SCHEMES, type DocumentInspection, type PartyIdScheme } from './document.js';
import type { DocumentStatus } from './state-machine.js';

export type InvoiceDirection = 'Sent' | 'Received';

export type QueryStatus = 'Submitted' | 'Valid' | 'Invalid' | 'Cancelled';

export interface ListQuery {
  pageNo: number;
  pageSize: number;
  uuid: string | null;
  submissionFrom: number | null;
  submissionTo: number | null;
  issueFrom: number | null;
  issueTo: number | null;
  direction: InvoiceDirection | null;
  status: QueryStatus | null;
  documentType: string | null;
  receiverIdType: PartyIdScheme | null;
  receiverId: string | null;
  receiverTin: string | null;
  issuerTin: string | null;
  issuerIdType: PartyIdScheme | null;
  issuerId: string | null;
  searchQuery: string | null;
  classificationCodes: string[] | null;
}

export type QueryParseFailure = { ok: false; message: string; messageMS: string; property: string };
export type QueryParseResult = { ok: true; query: ListQuery } | QueryParseFailure;

export interface QueryDocument {
  uuid: string;
  submissionUID: string;
  longId: string | null;
  internalId: string;
  status: DocumentStatus;
  supplierTin: string | null;
  buyerTin: string | null;
  submitterTin: string;
  receivedAt: number;
  dateTimeValidated: number | null;
  cancelAt: number | null;
  rejectAt: number | null;
  statusReason: string | null;
  createdByUserId: string;
  intermediaryTin: string | null;
  intermediaryName: string | null;
  intermediaryRob: string | null;
  inspection: DocumentInspection;
}

export interface QuerySummary {
  uuid: string;
  submissionUID: string;
  longId: string | null;
  internalId: string;
  typeName: string | null;
  typeVersionName: string | null;
  issuerTin: string | null;
  issuerName: string | null;
  receiverId: string | null;
  receiverName: string | null;
  dateTimeIssued: string | null;
  dateTimeReceived: string;
  dateTimeValidated: string | null;
  totalSales: number | null;
  totalDiscount: number | null;
  netAmount: number | null;
  total: number | null;
  totalExcludingTax: number | null;
  totalNetAmount: number | null;
  totalPayableAmount: number | null;
  status: DocumentStatus;
  cancelDateTime: string | null;
  rejectRequestDateTime: string | null;
  documentStatusReason: string | null;
  createdByUserId: string;
  supplierTIN: string | null;
  supplierTin: string | null;
  supplierName: string | null;
  submissionChannel: string | null;
  intermediaryName: string | null;
  intermediaryTin: string | null;
  intermediaryRob: string | null;
  buyerName: string | null;
  buyerTIN: string | null;
  buyerTin: string | null;
  classificationCodeValues: string[] | null;
}

const STATUS_VALUES = new Set<string>(['Submitted', 'Valid', 'Invalid', 'Cancelled']);
const SEARCH_QUERY_PATTERN = /^[A-Za-z0-9 .'_-]+$/;
const SUBMISSION_CHANNEL = 'ERP';

function optionalParam(params: URLSearchParams, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = params.get(key);
    if (value !== null && value.trim() !== '') return value.trim();
  }
  return null;
}

function fail(property: string, message: string, messageMS: string): QueryParseFailure {
  return { ok: false, message, messageMS, property };
}

function parsePositive(
  raw: string | null,
  fallback: number,
  max: number,
  name: string,
): { ok: true; value: number } | { ok: false; message: string; messageMS: string; property: string } {
  if (raw === null) return { ok: true, value: fallback };
  if (!/^[1-9]\d*$/.test(raw)) {
    return {
      ok: false,
      message: `${name} must be a positive integer`,
      messageMS: `${name} mestilah integer positif`,
      property: name,
    };
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > max) {
    return {
      ok: false,
      message: `${name} must be from 1 to ${max}`,
      messageMS: `${name} mestilah dari 1 hingga ${max}`,
      property: name,
    };
  }
  return { ok: true, value };
}

/** Full ISO-8601 datetime with `Z` or an explicit ±HH:MM offset. Date-only and offset-less values are rejected. */
const ISO_DATETIME =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

function parseIsoDate(
  raw: string,
  name: string,
): { ok: true; value: number } | { ok: false; message: string; messageMS: string; property: string } {
  const ms = ISO_DATETIME.test(raw) ? Date.parse(raw) : Number.NaN;
  if (Number.isNaN(ms)) {
    return fail(
      name,
      `${name} must be an ISO-8601 datetime with Z or an explicit offset`,
      `${name} mestilah tarikh masa ISO-8601 dengan Z atau ofset`,
    );
  }
  return { ok: true, value: ms };
}

function parseDatePair(
  fromRaw: string | null,
  toRaw: string | null,
  fromName: string,
  toName: string,
):
  | { ok: true; from: number | null; to: number | null }
  | { ok: false; message: string; messageMS: string; property: string } {
  const fromPresent = fromRaw !== null;
  const toPresent = toRaw !== null;
  if (fromPresent !== toPresent) {
    const missing = fromPresent ? toName : fromName;
    const present = fromPresent ? fromName : toName;
    return {
      ok: false,
      message: `${missing} is required when ${present} is provided`,
      messageMS: `${missing} diperlukan apabila ${present} diberikan`,
      property: missing,
    };
  }
  if (!fromPresent || fromRaw === null || toRaw === null) return { ok: true, from: null, to: null };
  const from = parseIsoDate(fromRaw, fromName);
  if (!from.ok) return from;
  const to = parseIsoDate(toRaw, toName);
  if (!to.ok) return to;
  if (from.value > to.value) {
    return {
      ok: false,
      message: `${fromName} must be less than or equal to ${toName}`,
      messageMS: `${fromName} mestilah kurang atau sama dengan ${toName}`,
      property: fromName,
    };
  }
  if (to.value - from.value > QUERY_WINDOW_MS) {
    return {
      ok: false,
      message: `Date range between ${fromName} and ${toName} cannot exceed 31 days`,
      messageMS: `Julat tarikh antara ${fromName} dan ${toName} tidak boleh melebihi 31 hari`,
      property: fromName,
    };
  }
  return { ok: true, from: from.value, to: to.value };
}

function parseDirection(
  raw: string | null,
): QueryParseFailure | { ok: true; value: InvoiceDirection | null } {
  if (raw === null) return { ok: true, value: null };
  const normalised = raw.trim().toLowerCase();
  if (normalised === 'sent') return { ok: true, value: 'Sent' };
  if (normalised === 'received') return { ok: true, value: 'Received' };
  return fail(
    'direction',
    'direction must be Sent or Received',
    'direction mestilah Sent atau Received',
  );
}

function parseStatus(raw: string | null): QueryParseFailure | { ok: true; value: QueryStatus | null } {
  if (raw === null) return { ok: true, value: null };
  if (!STATUS_VALUES.has(raw)) {
    return fail(
      'status',
      'status must be Valid, Invalid, Cancelled, or Submitted',
      'status mestilah Valid, Invalid, Cancelled, atau Submitted',
    );
  }
  return { ok: true, value: raw as QueryStatus };
}

function parseIdType(
  raw: string | null,
  name: string,
): QueryParseFailure | { ok: true; value: PartyIdScheme | null } {
  if (raw === null) return { ok: true, value: null };
  const upper = raw.trim().toUpperCase();
  if ((PARTY_ID_SCHEMES as readonly string[]).includes(upper)) {
    return { ok: true, value: upper as PartyIdScheme };
  }
  return fail(
    name,
    `${name} must be BRN, PASSPORT, NRIC, or ARMY`,
    `${name} mestilah BRN, PASSPORT, NRIC, atau ARMY`,
  );
}

function parseSearchQuery(raw: string | null): QueryParseFailure | { ok: true; value: string | null } {
  if (raw === null) return { ok: true, value: null };
  if (!SEARCH_QUERY_PATTERN.test(raw)) {
    return fail(
      'searchQuery',
      'searchQuery must not contain special characters',
      'searchQuery tidak boleh mengandungi aksara khas',
    );
  }
  return { ok: true, value: raw };
}

function parseClassification(raw: string | null): string[] | null {
  if (raw === null) return null;
  const codes = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return codes.length === 0 ? null : codes;
}

export function parseListQuery(params: URLSearchParams, mode: 'recent' | 'search'): QueryParseResult {
  const pageNo = parsePositive(optionalParam(params, 'pageNo'), 1, Number.MAX_SAFE_INTEGER, 'pageNo');
  if (!pageNo.ok) return pageNo;
  const pageSize = parsePositive(
    optionalParam(params, 'pageSize'),
    QUERY_PAGE_SIZE_DEFAULT,
    MAX_PAGE_SIZE,
    'pageSize',
  );
  if (!pageSize.ok) return pageSize;

  const submission = parseDatePair(
    optionalParam(params, 'submissionDateFrom'),
    optionalParam(params, 'submissionDateTo'),
    'submissionDateFrom',
    'submissionDateTo',
  );
  if (!submission.ok) return submission;
  const issue = parseDatePair(
    optionalParam(params, 'issueDateFrom'),
    optionalParam(params, 'issueDateTo'),
    'issueDateFrom',
    'issueDateTo',
  );
  if (!issue.ok) return issue;

  if (mode === 'search' && submission.from === null && issue.from === null) {
    return fail(
      'submissionDateFrom',
      'Either submissionDateFrom and submissionDateTo, or issueDateFrom and issueDateTo, are required',
      'Sama ada submissionDateFrom dan submissionDateTo, atau issueDateFrom dan issueDateTo, diperlukan',
    );
  }

  const direction = parseDirection(optionalParam(params, 'invoiceDirection', 'InvoiceDirection', 'direction'));
  if (!direction.ok) return direction;
  const status = parseStatus(optionalParam(params, 'status'));
  if (!status.ok) return status;
  const searchQuery = parseSearchQuery(optionalParam(params, 'searchQuery'));
  if (!searchQuery.ok) return searchQuery;

  const receiverIdType = parseIdType(optionalParam(params, 'receiverIdType'), 'receiverIdType');
  if (!receiverIdType.ok) return receiverIdType;
  const issuerIdType = parseIdType(optionalParam(params, 'issuerIdType'), 'issuerIdType');
  if (!issuerIdType.ok) return issuerIdType;

  const receiverId = optionalParam(params, 'receiverId');
  const receiverTin = optionalParam(params, 'receiverTin');
  const issuerId = optionalParam(params, 'issuerId');
  const issuerTin = optionalParam(params, 'issuerTin');

  if (receiverId !== null && receiverIdType.value === null) {
    return fail(
      'receiverIdType',
      'receiverIdType is required when receiverId is provided',
      'receiverIdType diperlukan apabila receiverId diberikan',
    );
  }
  if (issuerId !== null && issuerIdType.value === null) {
    return fail(
      'issuerIdType',
      'issuerIdType is required when issuerId is provided',
      'issuerIdType diperlukan apabila issuerId diberikan',
    );
  }

  const hasReceiverFilter = receiverId !== null || receiverTin !== null || receiverIdType.value !== null;
  const hasIssuerFilter = issuerId !== null || issuerTin !== null || issuerIdType.value !== null;
  if (hasReceiverFilter && direction.value !== 'Sent') {
    return fail(
      'direction',
      'receiverId, receiverIdType, and receiverTin can only be used when direction is Sent',
      'receiverId, receiverIdType, dan receiverTin hanya boleh digunakan apabila direction ialah Sent',
    );
  }
  if (hasIssuerFilter && direction.value !== 'Received') {
    return fail(
      'direction',
      'issuerId, issuerIdType, and issuerTin can only be used when direction is Received',
      'issuerId, issuerIdType, dan issuerTin hanya boleh digunakan apabila direction ialah Received',
    );
  }

  return {
    ok: true,
    query: {
      pageNo: pageNo.value,
      pageSize: pageSize.value,
      uuid: optionalParam(params, 'uuid'),
      submissionFrom: submission.from,
      submissionTo: submission.to,
      issueFrom: issue.from,
      issueTo: issue.to,
      direction: direction.value,
      status: status.value,
      documentType: optionalParam(params, 'documentType'),
      receiverIdType: receiverIdType.value,
      receiverId,
      receiverTin,
      issuerTin,
      issuerIdType: issuerIdType.value,
      issuerId,
      searchQuery: searchQuery.value,
      classificationCodes: parseClassification(optionalParam(params, 'classificationCode')),
    },
  };
}

function issuedAt(doc: QueryDocument): number {
  return doc.inspection.issuedAt ?? doc.receivedAt;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function isIssuer(doc: QueryDocument, tenantTin: string): boolean {
  if (doc.supplierTin !== null && doc.supplierTin === tenantTin) return true;
  return doc.submitterTin === tenantTin;
}

function isBuyer(doc: QueryDocument, tenantTin: string): boolean {
  return doc.buyerTin !== null && doc.buyerTin === tenantTin;
}

function receiverVisible(status: DocumentStatus): boolean {
  return status === 'Valid' || status === 'Cancelled';
}

function inInclusiveRange(value: number, from: number | null, to: number | null): boolean {
  if (from !== null && value < from) return false;
  if (to !== null && value > to) return false;
  return true;
}

function matchesSearchQuery(doc: QueryDocument, needle: string): boolean {
  const lower = needle.toLowerCase();
  const fields: Array<string | number | null> = [
    doc.uuid,
    doc.buyerTin,
    doc.supplierTin,
    doc.inspection.buyerName,
    doc.inspection.supplierName,
    doc.internalId,
    doc.inspection.total,
  ];
  return fields.some((field) => field !== null && String(field).toLowerCase().includes(lower));
}

export function visibleToTenant(
  doc: QueryDocument,
  tenantTin: string,
  direction: InvoiceDirection | null,
): boolean {
  const sent = isIssuer(doc, tenantTin);
  const received = isBuyer(doc, tenantTin) && receiverVisible(doc.status);
  if (direction === 'Sent') return sent;
  if (direction === 'Received') return received;
  return sent || received;
}

export function documentMatchesQuery(
  doc: QueryDocument,
  query: ListQuery,
  tenantTin: string,
  mode: 'recent' | 'search',
  now: number,
): boolean {
  if (!visibleToTenant(doc, tenantTin, query.direction)) return false;
  if (mode === 'recent') {
    const windowStart = now - QUERY_WINDOW_MS;
    if (issuedAt(doc) < windowStart) return false;
  }
  if (query.uuid !== null && doc.uuid !== query.uuid) return false;
  if (query.status !== null && doc.status !== query.status) return false;
  if (query.documentType !== null && doc.inspection.typeCode !== query.documentType) return false;
  if (!inInclusiveRange(doc.receivedAt, query.submissionFrom, query.submissionTo)) return false;
  if (!inInclusiveRange(issuedAt(doc), query.issueFrom, query.issueTo)) return false;
  if (query.receiverTin !== null && doc.buyerTin !== query.receiverTin) return false;
  if (query.issuerTin !== null && doc.supplierTin !== query.issuerTin) return false;
  if (query.receiverId !== null) {
    const id = doc.inspection.buyerId;
    if (id === null || id.value !== query.receiverId) return false;
    if (query.receiverIdType !== null && id.scheme !== query.receiverIdType) return false;
  } else if (query.receiverIdType !== null) {
    if (doc.inspection.buyerId?.scheme !== query.receiverIdType) return false;
  }
  if (query.issuerId !== null) {
    const id = doc.inspection.supplierId;
    if (id === null || id.value !== query.issuerId) return false;
    if (query.issuerIdType !== null && id.scheme !== query.issuerIdType) return false;
  } else if (query.issuerIdType !== null) {
    if (doc.inspection.supplierId?.scheme !== query.issuerIdType) return false;
  }
  if (query.searchQuery !== null && !matchesSearchQuery(doc, query.searchQuery)) return false;
  if (query.classificationCodes !== null) {
    const have = new Set(doc.inspection.classificationCodes);
    if (!query.classificationCodes.some((code) => have.has(code))) return false;
  }
  return true;
}

export function sortNewestFirst(docs: QueryDocument[]): QueryDocument[] {
  return [...docs].sort((left, right) => {
    if (right.receivedAt !== left.receivedAt) return right.receivedAt - left.receivedAt;
    return right.uuid < left.uuid ? -1 : right.uuid > left.uuid ? 1 : 0;
  });
}

export function paginate<T>(items: T[], pageNo: number, pageSize: number): {
  result: T[];
  metadata: { totalPages: number; totalCount: number };
} {
  const capped = items.slice(0, MAX_QUERY_RESULTS);
  const totalCount = capped.length;
  const totalPages = totalCount === 0 ? 0 : Math.ceil(totalCount / pageSize);
  const start = (pageNo - 1) * pageSize;
  return {
    result: start >= totalCount ? [] : capped.slice(start, start + pageSize),
    metadata: { totalPages, totalCount },
  };
}

export function querySummary(doc: QueryDocument): QuerySummary {
  const inspection = doc.inspection;
  const issued = inspection.issuedAt;
  return {
    uuid: doc.uuid,
    submissionUID: doc.submissionUID,
    longId: doc.longId,
    internalId: doc.internalId,
    typeName: inspection.typeName,
    typeVersionName: inspection.typeVersionName,
    issuerTin: doc.supplierTin,
    issuerName: inspection.supplierName,
    receiverId: inspection.buyerId?.value ?? null,
    receiverName: inspection.buyerName,
    dateTimeIssued: issued === null ? null : iso(issued),
    dateTimeReceived: iso(doc.receivedAt),
    dateTimeValidated: doc.dateTimeValidated === null ? null : iso(doc.dateTimeValidated),
    totalSales: inspection.totalSales,
    totalDiscount: inspection.totalDiscount,
    netAmount: inspection.netAmount,
    total: inspection.total,
    totalExcludingTax: inspection.totalSales,
    totalNetAmount: inspection.netAmount,
    totalPayableAmount: inspection.total,
    status: doc.status,
    cancelDateTime: doc.cancelAt === null ? null : iso(doc.cancelAt),
    rejectRequestDateTime: doc.rejectAt === null ? null : iso(doc.rejectAt),
    documentStatusReason: doc.statusReason,
    createdByUserId: doc.createdByUserId,
    supplierTIN: doc.supplierTin,
    supplierTin: doc.supplierTin,
    supplierName: inspection.supplierName,
    submissionChannel: SUBMISSION_CHANNEL,
    intermediaryName: doc.intermediaryName,
    intermediaryTin: doc.intermediaryTin,
    intermediaryRob: doc.intermediaryRob,
    buyerName: inspection.buyerName,
    buyerTIN: doc.buyerTin,
    buyerTin: doc.buyerTin,
    classificationCodeValues: inspection.classificationCodes.length === 0 ? null : inspection.classificationCodes,
  };
}

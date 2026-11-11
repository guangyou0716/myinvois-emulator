import { timingSafeEqual } from 'node:crypto';
import type { Clock } from './clock.js';
import { isAdjustableClock } from './clock.js';
import { MAX_PAGE_SIZE, MAX_REASON_LENGTH } from './constants.js';
import type { ResolvedConfig, TenantConfig } from './config.js';
import { inspectDocument, validateNone, type DocumentFormat } from './document.js';
import { errorBody, standardError, type StandardError } from './errors.js';
import { decodeBase64, hashesEqual, sha256Hex } from './hash.js';
import { checkLimits, limitMessage } from './limits.js';
import { duplicateDecision } from './duplicate.js';
import type { RateLimiter } from './rate-limit.js';
import { decideTransition, overallStatus, type DocumentStatus } from './state-machine.js';

export interface EngineResult {
  status: number;
  body: unknown | null;
  headers?: Record<string, string>;
}

interface IssuedToken {
  token: string;
  tenantTin: string;
  clientId: string;
  scope: string;
  expiresAt: number;
}

interface StoredDocument {
  uuid: string;
  submissionUID: string;
  codeNumber: string;
  format: DocumentFormat;
  bytes: Buffer;
  hash: string;
  supplierTin: string | null;
  buyerTin: string | null;
  submitterTin: string;
  status: DocumentStatus;
  /** null while Submitted. True when validation passed, including after cancel/reject. */
  validationOk: boolean | null;
  validationError: StandardError | null;
  longId: string | null;
  receivedAt: number;
  validationDueAt: number;
  dateTimeValidated: number | null;
  cancelAt: number | null;
  rejectAt: number | null;
  statusReason: string | null;
}

interface StoredSubmission {
  submissionUID: string;
  receivedAt: number;
  documentUuids: string[];
  bodyHash: string;
}

interface DecodedItem {
  format: DocumentFormat;
  bytes: Buffer;
  declaredHash: string;
  codeNumber: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function isMissingOrPlaceholder(value: string | null): boolean {
  if (value === null) return true;
  const trimmed = value.trim();
  if (trimmed.length === 0) return true;
  const lower = trimmed.toLowerCase();
  if (lower === '0') return true;
  if (lower.startsWith('your_')) return true;
  return false;
}

function documentText(bytes: Buffer): string {
  return bytes.toString('utf8');
}

export class EmulatorEngine {
  private readonly tokens = new Map<string, IssuedToken>();
  private readonly submissions = new Map<string, StoredSubmission>();
  private readonly documents = new Map<string, StoredDocument>();
  /** Raw request-body hash → time the body was accepted. */
  private readonly acceptedBodies = new Map<string, number>();

  constructor(
    private readonly config: ResolvedConfig,
    private readonly clock: Clock,
    private readonly ids: () => string,
    private readonly seed: number,
    private readonly clockMode: 'fake' | 'real',
    private readonly rateLimiter: RateLimiter,
  ) {}

  health(): EngineResult {
    this.settle();
    return {
      status: 200,
      body: {
        status: 'ok',
        clock: this.clockMode,
        now: iso(this.clock.now()),
      },
    };
  }

  state(): EngineResult {
    this.settle();
    const submissions = [...this.submissions.values()].map((submission) => {
      const docs = this.docsFor(submission);
      return {
        submissionUID: submission.submissionUID,
        dateTimeReceived: iso(submission.receivedAt),
        documentCount: docs.length,
        overallStatus: overallStatus(docs.map((doc) => doc.validationOk)),
      };
    });
    const documents = [...this.documents.values()].map((doc) => ({
      ...this.summary(doc),
      format: doc.format,
      document: documentText(doc.bytes),
      documentHash: doc.hash,
      validationResults: this.validationResults(doc),
    }));
    return {
      status: 200,
      body: {
        now: iso(this.clock.now()),
        nowMs: this.clock.now(),
        clock: this.clockMode,
        seed: this.seed,
        submissionCount: submissions.length,
        documentCount: documents.length,
        submissions,
        documents,
      },
    };
  }

  reset(): EngineResult {
    this.tokens.clear();
    this.submissions.clear();
    this.documents.clear();
    this.acceptedBodies.clear();
    this.rateLimiter.reset();
    return { status: 200, body: { reset: true } };
  }

  advance(ms: unknown): EngineResult {
    if (!isAdjustableClock(this.clock)) {
      return this.structure(
        'The emulator clock is real. Start with --clock fake to advance time.',
        'Jam emulator adalah jam sebenar. Mulakan dengan --clock fake untuk menggerakkan masa.',
        'clock',
      );
    }
    if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < 0) {
      return this.structure('ms must be a non-negative integer', 'ms mestilah integer bukan negatif', 'ms');
    }
    this.clock.advance(ms);
    this.settle();
    return { status: 200, body: { now: iso(this.clock.now()), nowMs: this.clock.now() } };
  }

  issueToken(form: URLSearchParams): EngineResult {
    const grantType = form.get('grant_type');
    const clientId = form.get('client_id');
    const clientSecret = form.get('client_secret');
    const scope = form.get('scope');
    if (
      isMissingOrPlaceholder(grantType) ||
      isMissingOrPlaceholder(clientId) ||
      isMissingOrPlaceholder(clientSecret) ||
      isMissingOrPlaceholder(scope)
    ) {
      return {
        status: this.config.statusCodes.missingParameters,
        body: errorBody(
          standardError({
            propertyName: 'client_id',
            propertyPath: 'client_id',
            errorCode: this.config.errorCodes.invalidRequest,
            error: 'grant_type, client_id, client_secret, and scope are required and must not be placeholders',
            errorMS: 'grant_type, client_id, client_secret, dan scope diperlukan dan tidak boleh nilai pemegang tempat',
            target: 'client_id',
          }),
        ),
      };
    }
    if (grantType !== 'client_credentials') {
      return {
        status: this.config.statusCodes.missingParameters,
        body: errorBody(
          standardError({
            propertyName: 'grant_type',
            propertyPath: 'grant_type',
            errorCode: this.config.errorCodes.invalidRequest,
            error: 'grant_type must be client_credentials',
            errorMS: 'grant_type mestilah client_credentials',
            target: 'grant_type',
          }),
        ),
      };
    }
    const tenant = this.config.tenants.find((item) => item.clientId === clientId);
    if (!tenant || !safeEqual(tenant.clientSecret, clientSecret ?? '')) {
      return {
        status: this.config.statusCodes.invalidClient,
        body: errorBody(
          standardError({
            propertyName: 'client_id',
            propertyPath: 'client_id',
            errorCode: this.config.errorCodes.invalidClient,
            error: 'Client authentication failed',
            errorMS: 'Pengesahan klien gagal',
            target: 'client_id',
          }),
        ),
      };
    }
    const token = this.ids();
    const now = this.clock.now();
    this.tokens.set(token, {
      token,
      tenantTin: tenant.tin,
      clientId: tenant.clientId,
      scope: scope ?? '',
      expiresAt: now + this.config.tokenTtlSeconds * 1000,
    });
    return {
      status: 200,
      body: {
        access_token: token,
        token_type: 'Bearer',
        expires_in: this.config.tokenTtlSeconds,
        scope,
      },
    };
  }

  authenticate(token: string | null): { ok: true; tenant: TenantConfig } | { ok: false; result: EngineResult } {
    if (token === null) return { ok: false, result: this.unauthorized() };
    const issued = this.tokens.get(token);
    if (!issued || this.clock.now() >= issued.expiresAt) return { ok: false, result: this.unauthorized() };
    const tenant = this.config.tenants.find(
      (item) => item.tin === issued.tenantTin && item.clientId === issued.clientId,
    );
    if (!tenant) return { ok: false, result: this.unauthorized() };
    return { ok: true, tenant };
  }

  /** Client id for a currently valid bearer token; null when missing, unknown, or expired. */
  clientIdForBearer(token: string | null): string | null {
    if (token === null) return null;
    const issued = this.tokens.get(token);
    if (!issued || this.clock.now() >= issued.expiresAt) return null;
    return issued.clientId;
  }

  tooManyRequests(headers: Record<string, string>): EngineResult {
    return {
      status: this.config.statusCodes.rateLimitExceeded,
      headers,
      body: errorBody(
        standardError({
          errorCode: this.config.errorCodes.rateLimitExceeded,
          error: 'Rate limit exceeded. Wait until the window resets before retrying.',
          errorMS: 'Had kadar dilampaui. Tunggu sehingga tetingkap diset semula sebelum mencuba lagi.',
        }),
      ),
    };
  }

  submit(rawBody: Buffer, tenant: TenantConfig): EngineResult {
    this.settle();
    const now = this.clock.now();
    const bodyHash = sha256Hex(rawBody);
    const previous = this.acceptedBodies.get(bodyHash);
    if (previous !== undefined) {
      const decision = duplicateDecision(now, previous, this.config.duplicateWindowMs);
      if (decision.duplicate) {
        return {
          status: this.config.statusCodes.duplicateSubmission,
          headers: { 'retry-after': String(decision.retryAfterSeconds) },
          body: errorBody(
            standardError({
              errorCode: this.config.errorCodes.duplicateSubmission,
              error: 'An identical submission was accepted within the last 10 minutes',
              errorMS: 'Penyerahan yang sama telah diterima dalam tempoh 10 minit',
              target: 'documents',
            }),
          ),
        };
      }
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
    } catch {
      return this.structure('Submission body is not valid JSON', 'Badan penyerahan bukan JSON yang sah', 'documents');
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.documents)) {
      return this.structure(
        'documents must be a non-empty array',
        'documents mestilah tatasusunan yang tidak kosong',
        'documents',
      );
    }
    if (parsed.documents.length === 0) {
      return this.structure(
        'documents must be a non-empty array',
        'documents mestilah tatasusunan yang tidak kosong',
        'documents',
      );
    }

    const decoded: DecodedItem[] = [];
    for (let index = 0; index < parsed.documents.length; index += 1) {
      const item = readDocumentItem(parsed.documents[index], index, this.config.errorCodes.badStructure);
      if (!item.ok) {
        return { status: this.config.statusCodes.badStructure, body: errorBody(item.error) };
      }
      decoded.push(item.item);
    }

    const violation = checkLimits(decoded.map((item) => item.bytes.length));
    if (violation) {
      const message = limitMessage(violation);
      return {
        status: this.config.statusCodes.maximumSizeExceeded,
        body: errorBody(
          standardError({
            propertyName: 'documents',
            propertyPath: message.propertyPath,
            errorCode: this.config.errorCodes.maximumSizeExceeded,
            error: message.error,
            errorMS: message.errorMS,
            target: 'documents',
          }),
        ),
      };
    }

    for (let index = 0; index < decoded.length; index += 1) {
      const item = decoded[index];
      if (!item) continue;
      if (!hashesEqual(sha256Hex(item.bytes), item.declaredHash)) {
        const inner = standardError({
          propertyName: 'documentHash',
          propertyPath: `documents[${index}].documentHash`,
          errorCode: 'DocumentHashMismatch',
          error: 'documentHash does not match the SHA-256 of the decoded document',
          errorMS: 'documentHash tidak sepadan dengan SHA-256 dokumen yang dinyahkod',
          target: 'documentHash',
          innerError: null,
        });
        return {
          status: this.config.statusCodes.badStructure,
          body: errorBody(
            standardError({
              propertyName: 'documentHash',
              propertyPath: `documents[${index}].documentHash`,
              errorCode: this.config.errorCodes.badStructure,
              error: 'documentHash does not match the SHA-256 of the decoded document',
              errorMS: 'documentHash tidak sepadan dengan SHA-256 dokumen yang dinyahkod',
              target: 'documentHash',
              innerError: [inner],
            }),
          ),
        };
      }
    }

    const prepared = decoded.map((item) => {
      const inspection = inspectDocument(item.format, item.bytes);
      return { item, inspection };
    });
    for (let index = 0; index < prepared.length; index += 1) {
      const entry = prepared[index];
      if (!entry) continue;
      if (entry.inspection.invoiceRoot && entry.inspection.supplierTin !== tenant.tin) {
        return {
          status: this.config.statusCodes.incorrectSubmitter,
          body: errorBody(
            standardError({
              propertyName: 'supplierTIN',
              propertyPath: `documents[${index}]`,
              errorCode: this.config.errorCodes.incorrectSubmitter,
              error: 'Supplier TIN does not match the authenticated tenant TIN',
              errorMS: 'TIN pembekal tidak sepadan dengan TIN penyewa yang disahkan',
              target: 'AccountingSupplierParty',
            }),
          ),
        };
      }
    }

    const submissionUID = this.ids();
    const documentUuids: string[] = [];
    for (const entry of prepared) {
      const uuid = this.ids();
      documentUuids.push(uuid);
      this.documents.set(uuid, {
        uuid,
        submissionUID,
        codeNumber: entry.item.codeNumber,
        format: entry.item.format,
        bytes: entry.item.bytes,
        hash: sha256Hex(entry.item.bytes),
        supplierTin: entry.inspection.supplierTin,
        buyerTin: entry.inspection.buyerTin,
        submitterTin: tenant.tin,
        status: 'Submitted',
        validationOk: null,
        validationError: null,
        longId: null,
        receivedAt: now,
        validationDueAt: now + this.config.validationDelayMs,
        dateTimeValidated: null,
        cancelAt: null,
        rejectAt: null,
        statusReason: null,
      });
    }
    this.submissions.set(submissionUID, {
      submissionUID,
      receivedAt: now,
      documentUuids,
      bodyHash,
    });
    this.acceptedBodies.set(bodyHash, now);
    this.settle();
    return {
      status: 202,
      body: {
        submissionUID,
        acceptedDocuments: prepared.map((entry, index) => ({
          uuid: documentUuids[index],
          invoiceCodeNumber: entry.item.codeNumber,
        })),
        rejectedDocuments: [],
      },
    };
  }

  getSubmission(uid: string, pageNoRaw: string | null, pageSizeRaw: string | null): EngineResult {
    this.settle();
    const submission = this.submissions.get(uid);
    if (!submission) return this.notFound('Submission was not found');
    const pageNo = parsePositive(pageNoRaw, 1, null, 'pageNo');
    if (!pageNo.ok) return this.structure(pageNo.message, pageNo.messageMS, pageNo.property);
    const pageSize = parsePositive(pageSizeRaw, MAX_PAGE_SIZE, MAX_PAGE_SIZE, 'pageSize');
    if (!pageSize.ok) return this.structure(pageSize.message, pageSize.messageMS, pageSize.property);
    const docs = this.docsFor(submission);
    const start = (pageNo.value - 1) * pageSize.value;
    return {
      status: 200,
      body: {
        submissionUID: submission.submissionUID,
        documentCount: docs.length,
        dateTimeReceived: iso(submission.receivedAt),
        overallStatus: overallStatus(docs.map((doc) => doc.validationOk)),
        pageNo: pageNo.value,
        pageSize: pageSize.value,
        documentSummary: docs.slice(start, start + pageSize.value).map((doc) => this.summary(doc)),
      },
    };
  }

  getRaw(uuid: string): EngineResult {
    this.settle();
    const doc = this.documents.get(uuid);
    if (!doc) return this.notFound('Document was not found');
    return {
      status: 200,
      body: {
        uuid: doc.uuid,
        submissionUID: doc.submissionUID,
        format: doc.format,
        document: documentText(doc.bytes),
        documentHash: doc.hash,
      },
    };
  }

  getDetails(uuid: string): EngineResult {
    this.settle();
    const doc = this.documents.get(uuid);
    if (!doc) return this.notFound('Document was not found');
    return {
      status: 200,
      body: {
        ...this.summary(doc),
        validationResults: this.validationResults(doc),
      },
    };
  }

  changeState(uuid: string, tenant: TenantConfig, body: unknown): EngineResult {
    this.settle();
    const doc = this.documents.get(uuid);
    if (!doc) return this.notFound('Document was not found');
    if (!isRecord(body) || typeof body.status !== 'string' || typeof body.reason !== 'string') {
      return this.structure(
        'Body must be {"status":"cancelled"|"rejected","reason":"..."}',
        'Badan mestilah {"status":"cancelled"|"rejected","reason":"..."}',
        'status',
      );
    }
    if (body.status !== 'cancelled' && body.status !== 'rejected') {
      return this.structure(
        'status must be cancelled or rejected',
        'status mestilah cancelled atau rejected',
        'status',
      );
    }
    const reason = body.reason.trim();
    if (reason.length === 0 || reason.length > MAX_REASON_LENGTH) {
      return this.structure(
        `reason must be 1 to ${MAX_REASON_LENGTH} characters`,
        `reason mestilah 1 hingga ${MAX_REASON_LENGTH} aksara`,
        'reason',
      );
    }
    const action = body.status === 'cancelled' ? 'cancel' : 'reject';
    const decision = decideTransition({
      status: doc.status,
      validatedAt: doc.dateTimeValidated,
      now: this.clock.now(),
      action,
      actorIsSupplier: doc.supplierTin !== null && doc.supplierTin === tenant.tin,
      actorIsBuyer: doc.buyerTin !== null && doc.buyerTin === tenant.tin,
      windowMs: this.config.cancelWindowMs,
      codes: {
        operationPeriodOver: this.config.errorCodes.operationPeriodOver,
        incorrectState: this.config.errorCodes.incorrectState,
      },
    });
    if (!decision.ok) {
      const period = decision.errorCode === this.config.errorCodes.operationPeriodOver;
      return {
        status: period ? this.config.statusCodes.operationPeriodOver : this.config.statusCodes.incorrectState,
        body: errorBody(
          standardError({
            propertyName: 'status',
            propertyPath: 'status',
            errorCode: decision.errorCode,
            error: period
              ? 'The 72-hour cancellation and rejection window has ended'
              : 'The document status or the calling tenant does not allow this operation',
            errorMS: period
              ? 'Tempoh 72 jam untuk batal atau tolak telah tamat'
              : 'Status dokumen atau penyewa pemanggil tidak membenarkan operasi ini',
            target: 'status',
          }),
        ),
      };
    }
    const now = this.clock.now();
    doc.status = decision.status;
    doc.statusReason = reason;
    if (decision.status === 'Cancelled') doc.cancelAt = now;
    else doc.rejectAt = now;
    return { status: 200, body: { uuid: doc.uuid, status: doc.status } };
  }

  validateTaxpayer(tin: string, idType: string | null, idValue: string | null): EngineResult {
    const typeMissing = idType === null || idType.trim() === '';
    const valueMissing = idValue === null || idValue.trim() === '';
    if (typeMissing || valueMissing) {
      const property = typeMissing ? 'idType' : 'idValue';
      return {
        status: this.config.statusCodes.missingParameters,
        body: errorBody(
          standardError({
            propertyName: property,
            propertyPath: property,
            errorCode: this.config.errorCodes.badStructure,
            error: 'idType and idValue are required',
            errorMS: 'idType dan idValue diperlukan',
            target: property,
          }),
        ),
      };
    }
    const match = this.config.tenants.some(
      (tenant) =>
        tenant.tin === tin &&
        tenant.idType.toLowerCase() === idType.trim().toLowerCase() &&
        tenant.idValue === idValue.trim(),
    );
    if (!match) return this.notFound('Taxpayer TIN was not found');
    return { status: 200, body: null };
  }

  notFound(message: string): EngineResult {
    return {
      status: this.config.statusCodes.notFound,
      body: errorBody(
        standardError({
          errorCode: this.config.errorCodes.notFound,
          error: message,
          errorMS: 'Rekod tidak dijumpai',
          target: 'path',
        }),
      ),
    };
  }

  methodNotAllowed(allow: string): EngineResult {
    return {
      status: 405,
      headers: { allow },
      body: errorBody(
        standardError({
          errorCode: this.config.errorCodes.badStructure,
          error: 'HTTP method is not allowed for this path',
          errorMS: 'Kaedah HTTP tidak dibenarkan untuk laluan ini',
          target: 'method',
        }),
      ),
    };
  }

  private settle(): void {
    const now = this.clock.now();
    for (const doc of this.documents.values()) {
      if (doc.status !== 'Submitted' || now < doc.validationDueAt) continue;
      const outcome = validateNone(doc.format, doc.bytes);
      if (outcome.ok) {
        doc.status = 'Valid';
        doc.validationOk = true;
        doc.validationError = null;
        doc.longId = this.ids();
        doc.dateTimeValidated = doc.validationDueAt;
      } else {
        doc.status = 'Invalid';
        doc.validationOk = false;
        doc.validationError = outcome.error;
        doc.longId = null;
        doc.dateTimeValidated = null;
      }
    }
  }

  private unauthorized(): EngineResult {
    return {
      status: this.config.statusCodes.unauthorized,
      body: errorBody(
        standardError({
          propertyName: 'Authorization',
          propertyPath: 'Authorization',
          errorCode: this.config.errorCodes.unauthorized,
          error: 'Access token is missing or expired',
          errorMS: 'Token akses tiada atau telah tamat tempoh',
          target: 'Authorization',
        }),
      ),
    };
  }

  private structure(error: string, errorMS: string, property: string): EngineResult {
    return {
      status: this.config.statusCodes.badStructure,
      body: errorBody(
        standardError({
          propertyName: property,
          propertyPath: property,
          errorCode: this.config.errorCodes.badStructure,
          error,
          errorMS,
          target: property,
        }),
      ),
    };
  }

  private docsFor(submission: StoredSubmission): StoredDocument[] {
    const docs: StoredDocument[] = [];
    for (const uuid of submission.documentUuids) {
      const doc = this.documents.get(uuid);
      if (doc) docs.push(doc);
    }
    return docs;
  }

  private summary(doc: StoredDocument): Record<string, unknown> {
    return {
      uuid: doc.uuid,
      submissionUID: doc.submissionUID,
      longId: doc.longId,
      internalId: doc.codeNumber,
      status: doc.status,
      issuerTin: doc.supplierTin,
      receiverTin: doc.buyerTin,
      dateTimeReceived: iso(doc.receivedAt),
      dateTimeValidated: doc.dateTimeValidated === null ? null : iso(doc.dateTimeValidated),
      cancelDateTime: doc.cancelAt === null ? null : iso(doc.cancelAt),
      rejectRequestDateTime: doc.rejectAt === null ? null : iso(doc.rejectAt),
      documentStatusReason: doc.statusReason,
    };
  }

  private validationResults(doc: StoredDocument): Record<string, unknown> {
    if (doc.status === 'Submitted') {
      return { status: 'in progress', validationSteps: [] };
    }
    if (doc.validationOk) {
      return {
        status: 'Valid',
        validationSteps: [{ name: 'structure', status: 'Valid', error: null }],
      };
    }
    return {
      status: 'Invalid',
      validationSteps: [{ name: 'structure', status: 'Invalid', error: doc.validationError }],
    };
  }
}

function readDocumentItem(
  value: unknown,
  index: number,
  badStructure: string,
): { ok: true; item: DecodedItem } | { ok: false; error: StandardError } {
  const propertyPath = `documents[${index}]`;
  const fail = (propertyName: string, error: string, errorMS: string): { ok: false; error: StandardError } => ({
    ok: false,
    error: standardError({
      propertyName,
      propertyPath: `${propertyPath}.${propertyName}`,
      errorCode: badStructure,
      error,
      errorMS,
      target: propertyName,
    }),
  });
  if (!isRecord(value)) {
    return {
      ok: false,
      error: standardError({
        propertyName: 'documents',
        propertyPath,
        errorCode: badStructure,
        error: 'Each document must be an object',
        errorMS: 'Setiap dokumen mestilah objek',
        target: 'documents',
      }),
    };
  }
  const { format, document, documentHash, codeNumber } = value;
  if (typeof format !== 'string' || format.trim() === '') return fail('format', 'format is required', 'format diperlukan');
  if (typeof document !== 'string' || document.trim() === '') {
    return fail('document', 'document must be base64', 'document mestilah base64');
  }
  if (typeof documentHash !== 'string' || documentHash.trim() === '') {
    return fail('documentHash', 'documentHash is required', 'documentHash diperlukan');
  }
  if (typeof codeNumber !== 'string' || codeNumber.trim() === '') {
    return fail('codeNumber', 'codeNumber is required', 'codeNumber diperlukan');
  }
  const normalized = format.trim().toUpperCase();
  if (normalized !== 'JSON' && normalized !== 'XML') {
    return fail('format', 'format must be JSON or XML', 'format mestilah JSON atau XML');
  }
  const bytes = decodeBase64(document);
  if (!bytes) return fail('document', 'document must be standard base64', 'document mestilah base64 piawai');
  return {
    ok: true,
    item: {
      format: normalized,
      bytes,
      declaredHash: documentHash,
      codeNumber: codeNumber.trim(),
    },
  };
}

function parsePositive(
  raw: string | null,
  fallback: number,
  max: number | null,
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
  if (!Number.isSafeInteger(value) || (max !== null && value > max)) {
    const limit = max === null ? 'a safe integer' : String(max);
    return {
      ok: false,
      message: `${name} must be from 1 to ${limit}`,
      messageMS: `${name} mestilah dari 1 hingga ${limit}`,
      property: name,
    };
  }
  return { ok: true, value };
}

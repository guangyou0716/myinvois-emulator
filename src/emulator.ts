import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { FakeClock, RealClock, isAdjustableClock, type Clock } from './clock.js';
import { FAKE_CLOCK_START_MS, MAX_BODY_BYTES, RATE_LIMIT_WINDOW_MS } from './constants.js';
import { resolveConfig, type EmulatorConfig, type ResolvedConfig, type TenantConfig } from './config.js';
import { EmulatorEngine, type EngineResult } from './engine.js';
import { errorBody, standardError } from './errors.js';
import { FaultError, FaultInjector, parseFaults, type FaultAction, type FaultRule } from './faults.js';
import { createIdGenerator } from './ids.js';
import {
  RATE_LIMIT_UNAUTHENTICATED,
  RateLimiter,
  rateLimitHeaders,
  resolveRateLimit,
  type RateLimitEndpoint,
  type RateLimitOptions,
} from './rate-limit.js';

export interface EmulatorOptions {
  /** Integer seed for document, submission, and token ids. Default 1. */
  seed?: number;
  /** `real` moves with wall time. `fake` stays put until advanced. Default `real`. */
  clock?: 'fake' | 'real' | Clock;
  /** Default listen host. Default `127.0.0.1`. */
  host?: string;
  /** Default listen port. `0` asks the OS for a free port. Default 8787. */
  port?: number;
  config?: EmulatorConfig;
  /** Per-endpoint RPM. Enabled by default. `/_emulator/*` is never limited. */
  rateLimit?: RateLimitOptions;
  /** Deterministic fault rules. `/_emulator/*` is never faulted. */
  faults?: FaultRule[];
  /** Called when a request handler throws. */
  onError?(error: unknown): void;
}

class EmulatorClosedError extends Error {
  constructor() {
    super('emulator stopped');
    this.name = 'EmulatorClosedError';
  }
}

export interface ListenInfo {
  port: number;
  host: string;
  url: string;
}

export interface Emulator {
  start(listen?: { port?: number; host?: string }): Promise<ListenInfo>;
  stop(): Promise<void>;
  readonly clock: Clock;
  readonly port: number | null;
  readonly url: string | null;
}

class BodyTooLargeError extends Error {
  readonly code = 'BODY_TOO_LARGE';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname;
}

function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  return match?.[1] ?? null;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      fn();
    };

    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        finish(() => {
          // Drop what we already held and pause. The handler responds, then closes.
          chunks.length = 0;
          req.pause();
          req.on('error', () => undefined);
          reject(new BodyTooLargeError('request body exceeds the emulator limit'));
        });
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = () => {
      finish(() => {
        resolve(Buffer.concat(chunks));
      });
    };

    const onError = (error: Error) => {
      finish(() => {
        reject(error);
      });
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

function decodePathSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * `new URL` accepts a target such as `/%ZZ` and leaves the bad escape in the
 * path. `decodeURIComponent` throws on that, and `new URL` itself throws on
 * other malformed targets. Both are client errors.
 */
function parseRequestTarget(rawTarget: string | undefined, hostHeader: string): URL | null {
  const raw = rawTarget === undefined || rawTarget.length === 0 ? '/' : rawTarget;
  try {
    decodeURIComponent(raw);
    return new URL(raw, `http://${hostHeader}`);
  } catch {
    return null;
  }
}

export function createEmulator(options: EmulatorOptions = {}): Emulator {
  return new EmulatorServer(options);
}

class EmulatorServer implements Emulator {
  private readonly http: Server;
  private readonly engine: EmulatorEngine;
  private readonly config: ResolvedConfig;
  private readonly rateLimiter: RateLimiter;
  private readonly faults: FaultInjector;
  private readonly correlationIds: () => string;
  private readonly preferredHost: string;
  private readonly preferredPort: number;
  private readonly onError: (error: unknown) => void;
  private readonly pendingDelays = new Set<{
    timer: ReturnType<typeof setTimeout>;
    reject: (error: EmulatorClosedError) => void;
  }>();
  private listening = false;
  private closed = false;
  private boundPort: number | null = null;
  private boundHost: string | null = null;
  readonly clock: Clock;

  constructor(options: EmulatorOptions) {
    const seed = options.seed ?? 1;
    if (!Number.isInteger(seed)) throw new Error('seed must be an integer');
    this.clock = resolveClock(options.clock);
    const clockMode = isAdjustableClock(this.clock) && !(this.clock instanceof RealClock) ? 'fake' : 'real';
    this.config = resolveConfig(options.config);
    this.rateLimiter = new RateLimiter(this.clock, resolveRateLimit(options.rateLimit));
    this.faults = new FaultInjector(seed, parseFaults(options.faults ?? [], 'faults'));
    this.engine = new EmulatorEngine(
      this.config,
      this.clock,
      createIdGenerator(seed),
      seed,
      clockMode,
      this.rateLimiter,
    );
    this.correlationIds = createIdGenerator(seed ^ 0x9e3779b9);
    this.preferredHost = options.host ?? '127.0.0.1';
    this.preferredPort = options.port ?? 8787;
    this.onError = options.onError ?? (() => undefined);
    this.http = createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  get port(): number | null {
    return this.boundPort;
  }

  get url(): string | null {
    if (this.boundPort === null || this.boundHost === null) return null;
    return `http://${formatHost(this.boundHost)}:${this.boundPort}`;
  }

  start(listen?: { port?: number; host?: string }): Promise<ListenInfo> {
    if (this.listening) return Promise.reject(new Error('emulator is already listening'));
    const port = listen?.port ?? this.preferredPort;
    const host = listen?.host ?? this.preferredHost;
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      return Promise.reject(new Error('port must be an integer from 0 to 65535'));
    }
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        this.http.removeListener('error', onError);
        reject(error);
      };
      this.http.once('error', onError);
      this.http.listen(port, host, () => {
        this.http.removeListener('error', onError);
        const address = this.http.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('emulator did not bind a TCP port'));
          return;
        }
        this.closed = false;
        this.listening = true;
        this.boundHost = host;
        this.boundPort = address.port;
        resolve({ port: address.port, host, url: `http://${formatHost(host)}:${address.port}` });
      });
    });
  }

  async stop(): Promise<void> {
    this.closed = true;
    this.cancelDelays();
    if (!this.listening) return;
    this.listening = false;
    this.http.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      this.http.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    this.boundPort = null;
    this.boundHost = null;
  }

  private invalidTarget(): EngineResult {
    return {
      status: 400,
      body: errorBody(
        standardError({
          errorCode: this.config.errorCodes.invalidRequest,
          error: 'Request target is malformed',
          errorMS: 'Sasaran permintaan tidak sah',
          target: 'url',
        }),
      ),
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const correlationId = this.correlationIds();
    try {
      const hostHeader = req.headers.host ?? this.preferredHost;
      const url = parseRequestTarget(req.url, hostHeader);
      if (url === null) {
        send(res, this.invalidTarget(), correlationId);
        return;
      }
      const path = normalizePath(url.pathname);
      const method = req.method ?? 'GET';
      if (!path.startsWith('/_emulator')) {
        const endpoint = apiEndpoint(path);
        const action = this.faults.evaluate(endpoint);
        if (action.delayMs > 0) await this.delay(action.delayMs);
        if (this.closed) return;
        const injected = this.applyFault(req, action, endpoint);
        if (injected === 'reset') return;
        if (injected !== null) {
          send(res, injected, correlationId);
          return;
        }
      }
      const result = await this.dispatch(method, path, url, req);
      if (this.closed) return;
      send(res, result, correlationId);
    } catch (error) {
      if (error instanceof EmulatorClosedError) return;
      if (error instanceof BodyTooLargeError) {
        send(
          res,
          {
            status: this.config.statusCodes.maximumSizeExceeded,
            body: errorBody(
              standardError({
                propertyName: 'body',
                propertyPath: 'body',
                errorCode: this.config.errorCodes.maximumSizeExceeded,
                error: 'Request body exceeds the emulator limit',
                errorMS: 'Badan permintaan melebihi had emulator',
                target: 'body',
              }),
            ),
          },
          correlationId,
          () => {
            // Response bytes are flushed. Close so the unread remainder is not buffered.
            if (!req.destroyed) req.destroy();
          },
        );
        return;
      }
      this.onError(error);
      send(
        res,
        {
          status: 500,
          body: errorBody(
            standardError({
              errorCode: 'SystemError',
              error: 'Internal emulator error',
              errorMS: 'Ralat dalaman emulator',
              target: 'server',
            }),
          ),
        },
        correlationId,
      );
    }
  }

  private async dispatch(method: string, path: string, url: URL, req: IncomingMessage): Promise<EngineResult> {
    if (path === '/connect/token') {
      if (method !== 'POST') return this.engine.methodNotAllowed('POST');
      const raw = await readBody(req);
      const form = new URLSearchParams(raw.toString('utf8'));
      const clientId = form.get('client_id');
      const identity = clientId !== null && clientId.trim() !== '' ? clientId : RATE_LIMIT_UNAUTHENTICATED;
      return this.limited(identity, 'token', () => this.engine.issueToken(form));
    }
    if (path === '/_emulator/health') {
      if (method !== 'GET' && method !== 'HEAD') return this.engine.methodNotAllowed('GET');
      const health = this.engine.health();
      return method === 'HEAD' ? { status: health.status, body: null } : health;
    }
    if (path === '/_emulator/state') {
      if (method !== 'GET') return this.engine.methodNotAllowed('GET');
      return this.engine.state();
    }
    if (path === '/_emulator/reset') {
      if (method !== 'POST') return this.engine.methodNotAllowed('POST');
      this.faults.resetCounters();
      return this.engine.reset();
    }
    if (path === '/_emulator/faults') {
      if (method === 'GET') return { status: 200, body: { faults: this.faults.snapshot() } };
      if (method === 'DELETE') {
        return { status: 200, body: { faults: this.faults.replace([]) } };
      }
      if (method !== 'POST') return this.engine.methodNotAllowed('GET, POST, DELETE');
      const raw = await readBody(req);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8')) as unknown;
      } catch {
        return this.invalidFaults('Request body is not valid JSON', 'Badan permintaan bukan JSON yang sah');
      }
      try {
        const rules = parseFaults(parsed, 'faults');
        return { status: 200, body: { faults: this.faults.replace(rules) } };
      } catch (cause) {
        const detail = cause instanceof FaultError ? cause.message : String(cause);
        return this.invalidFaults(detail, 'Peraturan ralat yang disuntik tidak sah');
      }
    }
    if (path === '/_emulator/clock/advance') {
      if (method !== 'POST') return this.engine.methodNotAllowed('POST');
      const raw = await readBody(req);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8')) as unknown;
      } catch {
        return this.engine.advance(undefined);
      }
      if (!isRecord(parsed)) return this.engine.advance(undefined);
      return this.engine.advance(parsed.ms);
    }

    const submissionUid = /^\/api\/v1\.0\/documentsubmissions\/([^/]+)$/.exec(path);
    const rawDoc = /^\/api\/v1\.0\/documents\/([^/]+)\/raw$/.exec(path);
    const details = /^\/api\/v1\.0\/documents\/([^/]+)\/details$/.exec(path);
    const stateChange = /^\/api\/v1\.0\/documents\/state\/([^/]+)\/state$/.exec(path);
    const taxpayer = /^\/api\/v1\.0\/taxpayer\/validate\/([^/]+)$/.exec(path);

    if (path === '/api/v1.0/documentsubmissions') {
      if (method !== 'POST') return this.engine.methodNotAllowed('POST');
      return this.limitedApi(req, 'submit', async (tenant) => {
        const raw = await readBody(req);
        return this.engine.submit(raw, tenant);
      });
    }
    if (submissionUid) {
      if (method !== 'GET') return this.engine.methodNotAllowed('GET');
      return this.limitedApi(req, 'getSubmission', () => {
        const uid = decodePathSegment(submissionUid[1] ?? '');
        if (uid === null) return this.engine.notFound('Submission was not found');
        return this.engine.getSubmission(uid, url.searchParams.get('pageNo'), url.searchParams.get('pageSize'));
      });
    }
    if (rawDoc) {
      if (method !== 'GET') return this.engine.methodNotAllowed('GET');
      return this.limitedApi(req, 'getDocument', () => {
        const uuid = decodePathSegment(rawDoc[1] ?? '');
        if (uuid === null) return this.engine.notFound('Document was not found');
        return this.engine.getRaw(uuid);
      });
    }
    if (details) {
      if (method !== 'GET') return this.engine.methodNotAllowed('GET');
      return this.limitedApi(req, 'getDocumentDetails', () => {
        const uuid = decodePathSegment(details[1] ?? '');
        if (uuid === null) return this.engine.notFound('Document was not found');
        return this.engine.getDetails(uuid);
      });
    }
    if (stateChange) {
      if (method !== 'PUT') return this.engine.methodNotAllowed('PUT');
      return this.limitedApi(req, 'cancelReject', async (tenant) => {
        const uuid = decodePathSegment(stateChange[1] ?? '');
        if (uuid === null) return this.engine.notFound('Document was not found');
        const raw = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString('utf8')) as unknown;
        } catch {
          parsed = null;
        }
        return this.engine.changeState(uuid, tenant, parsed);
      });
    }
    if (taxpayer) {
      if (method !== 'GET') return this.engine.methodNotAllowed('GET');
      return this.limitedApi(req, 'validateTin', () => {
        const tin = decodePathSegment(taxpayer[1] ?? '');
        if (tin === null) return this.engine.notFound('Taxpayer TIN was not found');
        return this.engine.validateTaxpayer(tin, url.searchParams.get('idType'), url.searchParams.get('idValue'));
      });
    }
    return this.engine.notFound('Path was not found');
  }

  private authorize(req: IncomingMessage): { ok: true; tenant: TenantConfig } | { ok: false; result: EngineResult } {
    const header = req.headers.authorization;
    const value = Array.isArray(header) ? header[0] : header;
    return this.engine.authenticate(bearerToken(value));
  }

  private clientIdentity(req: IncomingMessage): string {
    const header = req.headers.authorization;
    const value = Array.isArray(header) ? header[0] : header;
    return this.engine.clientIdForBearer(bearerToken(value)) ?? RATE_LIMIT_UNAUTHENTICATED;
  }

  private consume(
    clientId: string,
    endpoint: RateLimitEndpoint,
  ): { blocked: true; result: EngineResult } | { blocked: false; headers: Record<string, string> } {
    if (!this.rateLimiter.enabled) return { blocked: false, headers: {} };
    const decision = this.rateLimiter.hit(clientId, endpoint);
    if (!decision.allowed) {
      return { blocked: true, result: this.engine.tooManyRequests(decision.headers) };
    }
    return { blocked: false, headers: decision.headers };
  }

  private limited(clientId: string, endpoint: RateLimitEndpoint, run: () => EngineResult): EngineResult {
    const gate = this.consume(clientId, endpoint);
    if (gate.blocked) return gate.result;
    return withHeaders(run(), gate.headers);
  }

  private async limitedApi(
    req: IncomingMessage,
    endpoint: RateLimitEndpoint,
    run: (tenant: TenantConfig) => EngineResult | Promise<EngineResult>,
  ): Promise<EngineResult> {
    const gate = this.consume(this.clientIdentity(req), endpoint);
    if (gate.blocked) return gate.result;
    const auth = this.authorize(req);
    if (!auth.ok) return withHeaders(auth.result, gate.headers);
    return withHeaders(await run(auth.tenant), gate.headers);
  }

  private applyFault(
    req: IncomingMessage,
    action: FaultAction,
    endpoint: RateLimitEndpoint | null,
  ): EngineResult | 'reset' | null {
    if (action.kind === 'none') return null;
    if (action.kind === 'reset') {
      req.destroy();
      return 'reset';
    }
    if (action.kind === 'error500') {
      return {
        status: 500,
        body: errorBody(
          standardError({
            errorCode: 'SystemError',
            error: 'Internal emulator error',
            errorMS: 'Ralat dalaman emulator',
            target: 'server',
          }),
        ),
      };
    }
    const now = this.clock.now();
    const windowStart = Math.floor(now / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS;
    const resetAt = windowStart + RATE_LIMIT_WINDOW_MS;
    const limit = endpoint === null ? 0 : this.rateLimiter.rpm[endpoint];
    return this.engine.tooManyRequests(rateLimitHeaders(limit, 0, resetAt, action.retryAfterSeconds));
  }

  private invalidFaults(error: string, errorMS: string): EngineResult {
    return {
      status: this.config.statusCodes.missingParameters,
      body: errorBody(
        standardError({
          propertyName: 'faults',
          propertyPath: 'faults',
          errorCode: this.config.errorCodes.invalidRequest,
          error,
          errorMS,
          target: 'faults',
        }),
      ),
    };
  }

  private delay(ms: number): Promise<void> {
    if (this.closed) return Promise.reject(new EmulatorClosedError());
    return new Promise((resolve, reject) => {
      const entry: {
        timer: ReturnType<typeof setTimeout>;
        reject: (error: EmulatorClosedError) => void;
      } = {
        timer: setTimeout(() => {
          this.pendingDelays.delete(entry);
          resolve();
        }, ms),
        reject,
      };
      this.pendingDelays.add(entry);
    });
  }

  private cancelDelays(): void {
    const error = new EmulatorClosedError();
    for (const entry of this.pendingDelays) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pendingDelays.clear();
  }
}

function apiEndpoint(path: string): RateLimitEndpoint | null {
  if (path === '/connect/token') return 'token';
  if (path === '/api/v1.0/documentsubmissions') return 'submit';
  if (/^\/api\/v1\.0\/documentsubmissions\/[^/]+$/.test(path)) return 'getSubmission';
  if (/^\/api\/v1\.0\/documents\/state\/[^/]+\/state$/.test(path)) return 'cancelReject';
  if (/^\/api\/v1\.0\/documents\/[^/]+\/raw$/.test(path)) return 'getDocument';
  if (/^\/api\/v1\.0\/documents\/[^/]+\/details$/.test(path)) return 'getDocumentDetails';
  if (/^\/api\/v1\.0\/taxpayer\/validate\/[^/]+$/.test(path)) return 'validateTin';
  return null;
}

function resolveClock(clock: EmulatorOptions['clock']): Clock {
  if (clock === 'fake') return new FakeClock(FAKE_CLOCK_START_MS);
  if (clock === 'real' || clock === undefined) return new RealClock();
  if (clock instanceof RealClock) return clock;
  return clock;
}

function withHeaders(result: EngineResult, extra: Record<string, string>): EngineResult {
  if (Object.keys(extra).length === 0) return result;
  return { ...result, headers: { ...extra, ...result.headers } };
}

function send(
  res: ServerResponse,
  result: EngineResult,
  correlationId: string,
  onFinish?: () => void,
): void {
  const headers: Record<string, string | number> = {
    correlationId,
    connection: 'close',
    ...result.headers,
  };
  if (result.body === null || result.body === undefined) {
    res.writeHead(result.status, headers);
    if (onFinish) res.end(onFinish);
    else res.end();
    return;
  }
  headers['content-type'] = 'application/json; charset=utf-8';
  res.writeHead(result.status, headers);
  const payload = JSON.stringify(result.body);
  if (onFinish) res.end(payload, onFinish);
  else res.end(payload);
}

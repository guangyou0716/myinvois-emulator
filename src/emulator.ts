import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { FakeClock, RealClock, isAdjustableClock, type Clock } from './clock.js';
import { FAKE_CLOCK_START_MS, MAX_BODY_BYTES } from './constants.js';
import { resolveConfig, type EmulatorConfig, type ResolvedConfig, type TenantConfig } from './config.js';
import { EmulatorEngine, type EngineResult } from './engine.js';
import { errorBody, standardError } from './errors.js';
import { createIdGenerator } from './ids.js';

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
  /** Called when a request handler throws. */
  onError?(error: unknown): void;
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
  private readonly correlationIds: () => string;
  private readonly preferredHost: string;
  private readonly preferredPort: number;
  private readonly onError: (error: unknown) => void;
  private listening = false;
  private boundPort: number | null = null;
  private boundHost: string | null = null;
  readonly clock: Clock;

  constructor(options: EmulatorOptions) {
    const seed = options.seed ?? 1;
    if (!Number.isInteger(seed)) throw new Error('seed must be an integer');
    this.clock = resolveClock(options.clock);
    const clockMode = isAdjustableClock(this.clock) && !(this.clock instanceof RealClock) ? 'fake' : 'real';
    this.config = resolveConfig(options.config);
    this.engine = new EmulatorEngine(
      this.config,
      this.clock,
      createIdGenerator(seed),
      seed,
      clockMode,
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
        this.listening = true;
        this.boundHost = host;
        this.boundPort = address.port;
        resolve({ port: address.port, host, url: `http://${formatHost(host)}:${address.port}` });
      });
    });
  }

  async stop(): Promise<void> {
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
      const result = await this.dispatch(req.method ?? 'GET', normalizePath(url.pathname), url, req);
      send(res, result, correlationId);
    } catch (error) {
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
      return this.engine.issueToken(new URLSearchParams(raw.toString('utf8')));
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
      return this.engine.reset();
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
      const auth = this.authorize(req);
      if (!auth.ok) return auth.result;
      const raw = await readBody(req);
      return this.engine.submit(raw, auth.tenant);
    }
    if (submissionUid) {
      if (method !== 'GET') return this.engine.methodNotAllowed('GET');
      const auth = this.authorize(req);
      if (!auth.ok) return auth.result;
      const uid = decodePathSegment(submissionUid[1] ?? '');
      if (uid === null) return this.engine.notFound('Submission was not found');
      return this.engine.getSubmission(uid, url.searchParams.get('pageNo'), url.searchParams.get('pageSize'));
    }
    if (rawDoc) {
      if (method !== 'GET') return this.engine.methodNotAllowed('GET');
      const auth = this.authorize(req);
      if (!auth.ok) return auth.result;
      const uuid = decodePathSegment(rawDoc[1] ?? '');
      if (uuid === null) return this.engine.notFound('Document was not found');
      return this.engine.getRaw(uuid);
    }
    if (details) {
      if (method !== 'GET') return this.engine.methodNotAllowed('GET');
      const auth = this.authorize(req);
      if (!auth.ok) return auth.result;
      const uuid = decodePathSegment(details[1] ?? '');
      if (uuid === null) return this.engine.notFound('Document was not found');
      return this.engine.getDetails(uuid);
    }
    if (stateChange) {
      if (method !== 'PUT') return this.engine.methodNotAllowed('PUT');
      const auth = this.authorize(req);
      if (!auth.ok) return auth.result;
      const uuid = decodePathSegment(stateChange[1] ?? '');
      if (uuid === null) return this.engine.notFound('Document was not found');
      const raw = await readBody(req);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8')) as unknown;
      } catch {
        parsed = null;
      }
      return this.engine.changeState(uuid, auth.tenant, parsed);
    }
    if (taxpayer) {
      if (method !== 'GET') return this.engine.methodNotAllowed('GET');
      const auth = this.authorize(req);
      if (!auth.ok) return auth.result;
      const tin = decodePathSegment(taxpayer[1] ?? '');
      if (tin === null) return this.engine.notFound('Taxpayer TIN was not found');
      return this.engine.validateTaxpayer(tin, url.searchParams.get('idType'), url.searchParams.get('idValue'));
    }
    return this.engine.notFound('Path was not found');
  }

  private authorize(req: IncomingMessage): { ok: true; tenant: TenantConfig } | { ok: false; result: EngineResult } {
    const header = req.headers.authorization;
    const value = Array.isArray(header) ? header[0] : header;
    return this.engine.authenticate(bearerToken(value));
  }
}

function resolveClock(clock: EmulatorOptions['clock']): Clock {
  if (clock === 'fake') return new FakeClock(FAKE_CLOCK_START_MS);
  if (clock === 'real' || clock === undefined) return new RealClock();
  if (clock instanceof RealClock) return clock;
  return clock;
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

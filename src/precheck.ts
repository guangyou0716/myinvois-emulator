import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRECHECK_CONCURRENCY, PRECHECK_MAX_STDOUT_BYTES } from './constants.js';
import type { DocumentFormat, NoneValidation } from './document.js';
import { precheckFailedError, precheckFindingsError } from './errors.js';
import type { ResolvedValidator } from './validator.js';

/** Temp-file IO used by the precheck runner. Tests inject failures here. */
export interface PrecheckIo {
  mkdtemp(prefix: string): Promise<string>;
  writeFile(file: string, data: Buffer): Promise<void>;
  rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>;
  tmpdir(): string;
}

const defaultIo: PrecheckIo = {
  mkdtemp: (prefix) => mkdtemp(prefix),
  writeFile: (file, data) => writeFile(file, data),
  rm: (path, options) => rm(path, options),
  tmpdir,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failed(reason: string): NoneValidation {
  return { ok: false, error: precheckFailedError(reason) };
}

function createGate(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiters: Array<() => void> = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) {
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    } else {
      active += 1;
    }
    try {
      return await fn();
    } finally {
      const next = waiters.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

export class PrecheckRunner {
  private readonly command: string[];
  private readonly timeoutMs: number;
  private readonly io: PrecheckIo;
  private readonly gate = createGate(PRECHECK_CONCURRENCY);
  private readonly children = new Set<ChildProcess>();
  private closed = false;

  constructor(validator: Extract<ResolvedValidator, { kind: 'precheck' }>, io: Partial<PrecheckIo> = {}) {
    this.command = validator.command;
    this.timeoutMs = validator.timeoutMs;
    this.io = { ...defaultIo, ...io };
  }

  async run(format: DocumentFormat, bytes: Buffer): Promise<NoneValidation> {
    try {
      return await this.gate(() => this.runExclusive(format, bytes));
    } catch {
      return failed('precheck failed to start');
    }
  }

  close(): void {
    this.closed = true;
    for (const child of this.children) {
      child.kill('SIGKILL');
    }
    this.children.clear();
  }

  private async runExclusive(format: DocumentFormat, bytes: Buffer): Promise<NoneValidation> {
    if (this.closed) return failed('precheck was cancelled');
    let dir: string | undefined;
    try {
      dir = await this.io.mkdtemp(join(this.io.tmpdir(), 'myinvois-precheck-'));
      const extension = format === 'XML' ? '.xml' : '.json';
      const file = join(dir, `document${extension}`);
      await this.io.writeFile(file, bytes);
      return await this.spawn(file);
    } catch {
      return failed('precheck failed to start');
    } finally {
      if (dir !== undefined) {
        try {
          await this.io.rm(dir, { recursive: true, force: true });
        } catch {
          // Cleanup must not reject or replace the precheck outcome.
        }
      }
    }
  }

  private spawn(file: string): Promise<NoneValidation> {
    if (this.closed) return Promise.resolve(failed('precheck was cancelled'));
    const [bin, ...prefix] = this.command;
    if (bin === undefined) return Promise.resolve(failed('precheck command is empty'));

    return new Promise((resolve) => {
      let settled = false;
      let timedOut = false;
      let oversized = false;
      const chunks: Buffer[] = [];
      let total = 0;

      const finish = (outcome: NoneValidation) => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };

      let child: ChildProcess;
      try {
        child = spawn(bin, [...prefix, file], {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        finish(failed('precheck failed to start'));
        return;
      }

      this.children.add(child);

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, this.timeoutMs);

      const done = (outcome: NoneValidation) => {
        clearTimeout(timer);
        finish(outcome);
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        if (settled || oversized) return;
        total += chunk.length;
        if (total > PRECHECK_MAX_STDOUT_BYTES) {
          oversized = true;
          chunks.length = 0;
          child.kill('SIGKILL');
          return;
        }
        chunks.push(chunk);
      });
      child.stderr?.resume();

      child.on('error', () => {
        this.children.delete(child);
        done(failed('precheck failed to start'));
      });

      child.on('close', (code) => {
        this.children.delete(child);
        if (timedOut) {
          done(failed('precheck timed out'));
          return;
        }
        if (oversized) {
          done(failed('precheck output exceeded the size limit'));
          return;
        }
        if (code === 2) {
          done(failed('precheck could not read the document'));
          return;
        }
        const stdout = Buffer.concat(chunks).toString('utf8');
        const report = parseReport(stdout);
        if (code !== 0 && code !== 1) {
          done(failed(code === null ? 'precheck exited unexpectedly' : `precheck exited with code ${code}`));
          return;
        }
        if (report === null) {
          done(failed('precheck output is not a JSON report'));
          return;
        }
        done(mapReport(report));
      });
    });
  }
}

interface ParsedReport {
  errorCount: number;
  findings: Array<{ rule: string; message: string; path: string; severity: string }>;
}

export function parseReport(text: string): ParsedReport | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim()) as unknown;
  } catch {
    return null;
  }
  if (Array.isArray(parsed) && parsed.length === 1) parsed = parsed[0];
  if (!isRecord(parsed)) return null;

  const rawFindings = parsed.findings;
  const findings: ParsedReport['findings'] = [];
  if (rawFindings !== undefined) {
    if (!Array.isArray(rawFindings)) return null;
    for (const entry of rawFindings) {
      if (!isRecord(entry)) continue;
      if (typeof entry.rule !== 'string' || typeof entry.message !== 'string' || typeof entry.path !== 'string') {
        continue;
      }
      const severity = typeof entry.severity === 'string' ? entry.severity : 'error';
      findings.push({ rule: entry.rule, message: entry.message, path: entry.path, severity });
    }
  }

  let errorCount: number;
  if (typeof parsed.errorCount === 'number' && Number.isInteger(parsed.errorCount) && parsed.errorCount >= 0) {
    errorCount = parsed.errorCount;
  } else if (rawFindings !== undefined) {
    errorCount = findings.filter((finding) => finding.severity === 'error').length;
  } else {
    return null;
  }
  return { errorCount, findings };
}

export function mapReport(report: ParsedReport): NoneValidation {
  if (report.errorCount === 0) return { ok: true, error: null };
  const errors = report.findings.filter((finding) => finding.severity === 'error');
  if (errors.length === 0) {
    return failed('precheck reported errors without error findings');
  }
  return { ok: false, error: precheckFindingsError(errors) };
}

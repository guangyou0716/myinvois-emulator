import { accessSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { rm as rmDir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createEmulator } from '../src/emulator.js';
import { mapReport, parseReport, PrecheckRunner, type PrecheckIo } from '../src/precheck.js';
import { resolveValidator, splitCommand, ValidatorError } from '../src/validator.js';
import {
  advance,
  authHeaders,
  encodeDocument,
  login,
  minimalInvoice,
  startServer,
  submitRaw,
} from './helpers.js';
import { defaultConfig } from '../src/defaults.js';

const fakePrecheck = fileURLToPath(new URL('./fixtures/fake-precheck.mjs', import.meta.url));
const tenants = defaultConfig().tenants ?? [];
const foundSupplier = tenants.find((tenant) => tenant.clientId === 'sample-supplier');
const foundBuyer = tenants.find((tenant) => tenant.clientId === 'sample-buyer');
if (!foundSupplier || !foundBuyer) throw new Error('built-in sample tenants are missing');
const supplier = foundSupplier;
const buyer = foundBuyer;

function precheckCommand(): string[] {
  return [process.execPath, fakePrecheck];
}

function invoiceWithMarker(marker: string): string {
  return minimalInvoice(supplier.tin, buyer.tin, marker);
}

async function submitAndSettle(
  base: string,
  token: string,
  content: string,
  format: 'JSON' | 'XML' = 'JSON',
): Promise<{ uuid: string; submissionUID: string }> {
  const res = await submitRaw(base, token, JSON.stringify({ documents: [encodeDocument(content, format, 'INV-1')] }));
  expect(res.status).toBe(202);
  const created = (await res.json()) as {
    submissionUID: string;
    acceptedDocuments: { uuid: string }[];
  };
  await advance(base, 2000);
  return { uuid: created.acceptedDocuments[0]?.uuid ?? '', submissionUID: created.submissionUID };
}

interface InnerFinding {
  errorCode: string;
  error: string;
  propertyPath: string | null;
  target: string | null;
}

async function detailsError(
  base: string,
  token: string,
  uuid: string,
): Promise<{ errorCode: string; inner: InnerFinding[] }> {
  const res = await fetch(`${base}/api/v1.0/documents/${uuid}/details`, { headers: authHeaders(token) });
  const body = (await res.json()) as {
    status: string;
    validationResults: {
      status: string;
      validationSteps: { error: { errorCode: string; innerError: InnerFinding[] } }[];
    };
  };
  expect(body.status).toBe('Invalid');
  const inner = body.validationResults.validationSteps[0]?.error.innerError ?? [];
  return { errorCode: body.validationResults.validationSteps[0]?.error.errorCode ?? '', inner };
}

describe('splitCommand', () => {
  it('splits on whitespace and keeps quoted tokens', () => {
    expect(splitCommand('node dist/cli.js --json')).toEqual(['node', 'dist/cli.js', '--json']);
    expect(splitCommand("node '/path with spaces/cli.js' --json")).toEqual([
      'node',
      '/path with spaces/cli.js',
      '--json',
    ]);
    expect(splitCommand('node "/path with spaces/cli.js" --json')).toEqual([
      'node',
      '/path with spaces/cli.js',
      '--json',
    ]);
    expect(splitCommand("  node   'a b'  \"c d\"  ")).toEqual(['node', 'a b', 'c d']);
  });

  it('does not expand shell syntax', () => {
    expect(splitCommand('node $HOME/cli.js --json')).toEqual(['node', '$HOME/cli.js', '--json']);
    expect(splitCommand('node ~/cli.js *.json')).toEqual(['node', '~/cli.js', '*.json']);
  });

  it('rejects unmatched quotes', () => {
    expect(() => splitCommand("node 'unterminated")).toThrow(ValidatorError);
    expect(() => splitCommand('node "unterminated')).toThrow(/unmatched quote/);
  });
});

describe('resolveValidator', () => {
  it('defaults to none', () => {
    expect(resolveValidator()).toEqual({ kind: 'none' });
    expect(resolveValidator('none')).toEqual({ kind: 'none' });
  });

  it('rejects an empty precheck command', () => {
    expect(() => resolveValidator({ kind: 'precheck', command: [] })).toThrow(/non-empty array/);
    expect(() => resolveValidator({ kind: 'precheck', command: ['node', ''] })).toThrow(/non-empty strings/);
    expect(() => createEmulator({ validator: { kind: 'precheck', command: [] } })).toThrow(ValidatorError);
  });

  it('rejects a non-positive timeout', () => {
    expect(() => resolveValidator({ kind: 'precheck', command: ['node'], timeoutMs: 0 })).toThrow(/timeoutMs/);
  });
});

describe('parseReport', () => {
  it('reads errorCount and findings', () => {
    const report = parseReport(
      JSON.stringify({
        file: 'x.json',
        ok: false,
        version: '1.1',
        errorCount: 1,
        warningCount: 0,
        findings: [{ rule: 'math.line-total-excl', severity: 'error', path: 'Invoice', message: 'bad math' }],
      }),
    );
    expect(report).toMatchObject({ errorCount: 1 });
    expect(report?.findings[0]?.rule).toBe('math.line-total-excl');
    expect(parseReport('not json')).toBeNull();
  });
});

describe('mapReport', () => {
  it('adds a PrecheckFailed innerError when errorCount is positive but findings have no errors', () => {
    const outcome = mapReport({
      errorCount: 2,
      findings: [{ rule: 'warn.example', message: 'a warning', path: 'Invoice', severity: 'warning' }],
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.innerError).toHaveLength(1);
    expect(outcome.error?.innerError).toEqual([expect.objectContaining({ errorCode: 'PrecheckFailed' })]);
  });
});

describe('PrecheckRunner.run', () => {
  it('resolves PrecheckFailed when mkdtemp throws and keeps success when cleanup throws', async () => {
    const mkdtempFail = new PrecheckRunner(
      { kind: 'precheck', command: precheckCommand(), timeoutMs: 1000 },
      {
        mkdtemp: async () => {
          throw new Error('ENOSPC');
        },
      },
    );
    await expect(mkdtempFail.run('JSON', Buffer.from(invoiceWithMarker('PRECHECK_OK')))).resolves.toMatchObject({
      ok: false,
      error: expect.objectContaining({
        innerError: [expect.objectContaining({ errorCode: 'PrecheckFailed' })],
      }),
    });
    mkdtempFail.close();

    const cleanupFail = new PrecheckRunner(
      { kind: 'precheck', command: precheckCommand(), timeoutMs: 1000 },
      {
        rm: async (path, options) => {
          await rmDir(path, options);
          throw new Error('EBUSY');
        },
      },
    );
    await expect(cleanupFail.run('JSON', Buffer.from(invoiceWithMarker('PRECHECK_OK')))).resolves.toEqual({
      ok: true,
      error: null,
    });
    cleanupFail.close();
  });
});

describe('precheck validator', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function startPrecheck(extra?: { timeoutMs?: number; precheckIo?: Partial<PrecheckIo> }) {
    const started = await startServer({
      validator: { kind: 'precheck', command: precheckCommand(), timeoutMs: extra?.timeoutMs },
      precheckIo: extra?.precheckIo,
    });
    const token = await login(started.base, supplier.clientId, supplier.clientSecret);
    return { ...started, token };
  }

  it('marks a document Valid when precheck reports ok', async () => {
    const { emulator, base, token } = await startPrecheck();
    try {
      const { uuid, submissionUID } = await submitAndSettle(base, token, invoiceWithMarker('PRECHECK_OK'));
      const details = await fetch(`${base}/api/v1.0/documents/${uuid}/details`, { headers: authHeaders(token) });
      const body = (await details.json()) as { status: string; longId: string };
      expect(body.status).toBe('Valid');
      expect(body.longId).toMatch(/^[A-Z0-9]{26}$/);
      const submission = await fetch(`${base}/api/v1.0/documentsubmissions/${submissionUID}`, {
        headers: authHeaders(token),
      });
      const sub = (await submission.json()) as { overallStatus: string };
      expect(sub.overallStatus).toBe('valid');
    } finally {
      await emulator.stop();
    }
  });

  it('maps error findings onto innerError rule ids', async () => {
    const { emulator, base, token } = await startPrecheck();
    try {
      const { uuid } = await submitAndSettle(base, token, invoiceWithMarker('PRECHECK_ERROR'));
      const { errorCode, inner } = await detailsError(base, token, uuid);
      expect(errorCode).toBe('ValidationError');
      expect(inner).toEqual([
        expect.objectContaining({
          errorCode: 'math.line-total-excl',
          error: 'line total does not match',
          propertyPath: 'Invoice[0].InvoiceLine[0].LineExtensionAmount',
          target: 'math.line-total-excl',
        }),
      ]);
    } finally {
      await emulator.stop();
    }
  });

  it('treats warnings-only reports as Valid', async () => {
    const { emulator, base, token } = await startPrecheck();
    try {
      const { uuid } = await submitAndSettle(base, token, invoiceWithMarker('PRECHECK_WARN'));
      const details = await fetch(`${base}/api/v1.0/documents/${uuid}/details`, { headers: authHeaders(token) });
      const body = (await details.json()) as { status: string; longId: string };
      expect(body.status).toBe('Valid');
      expect(body.longId).toMatch(/^[A-Z0-9]{26}$/);
    } finally {
      await emulator.stop();
    }
  });

  it('marks exit 2, garbage output, and timeout as PrecheckFailed', async () => {
    const { emulator, base, token } = await startPrecheck({ timeoutMs: 150 });
    try {
      const exit2 = await submitAndSettle(base, token, invoiceWithMarker('PRECHECK_EXIT_2'));
      const garbage = await submitAndSettle(base, token, invoiceWithMarker('PRECHECK_GARBAGE'));
      const timeout = await submitAndSettle(base, token, invoiceWithMarker('PRECHECK_SLEEP'));

      for (const item of [exit2, garbage, timeout]) {
        const { errorCode, inner } = await detailsError(base, token, item.uuid);
        expect(errorCode).toBe('ValidationError');
        expect(inner).toHaveLength(1);
        expect(inner[0]?.errorCode).toBe('PrecheckFailed');
        expect(inner[0]?.error.length).toBeGreaterThan(0);
        expect(inner[0]?.error).not.toMatch(/\/tmp\/|myinvois-precheck-/);
        expect(inner[0]?.error).not.toMatch(/at\s+\S+\s+\(/);
      }
    } finally {
      await emulator.stop();
    }
  });

  it('does not spawn precheck for a non-Invoice document', async () => {
    const { emulator, base, token } = await startPrecheck();
    try {
      const { uuid } = await submitAndSettle(base, token, JSON.stringify({ note: 'not an invoice PRECHECK_EXIT_2' }));
      const { inner } = await detailsError(base, token, uuid);
      expect(inner[0]?.errorCode).toBe('InvalidStructure');
    } finally {
      await emulator.stop();
    }
  });

  it('writes a temp file with the submission extension and removes it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'precheck-log-'));
    dirs.push(dir);
    const log = join(dir, 'paths.txt');
    process.env.PRECHECK_PATH_LOG = log;
    const { emulator, base, token } = await startPrecheck();
    try {
      await submitAndSettle(base, token, invoiceWithMarker('PRECHECK_OK'));
      const xml = `<?xml version="1.0"?><Invoice><ID>PRECHECK_OK</ID><AccountingSupplierParty><Party><PartyIdentification><ID schemeID="TIN">${supplier.tin}</ID></PartyIdentification></Party></AccountingSupplierParty><AccountingCustomerParty><Party><PartyIdentification><ID schemeID="TIN">${buyer.tin}</ID></PartyIdentification></Party></AccountingCustomerParty></Invoice>`;
      await submitAndSettle(base, token, xml, 'XML');
      const paths = readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter((line) => line.length > 0);
      expect(paths.some((path) => path.endsWith('.json'))).toBe(true);
      expect(paths.some((path) => path.endsWith('.xml'))).toBe(true);
      for (const path of paths) {
        expect(() => accessSync(path)).toThrow();
      }
    } finally {
      delete process.env.PRECHECK_PATH_LOG;
      await emulator.stop();
    }
  });

  it('maps a positive errorCount with no error findings to PrecheckFailed', async () => {
    const { emulator, base, token } = await startPrecheck();
    try {
      const { uuid } = await submitAndSettle(base, token, invoiceWithMarker('PRECHECK_ERROR_COUNT_ONLY'));
      const { errorCode, inner } = await detailsError(base, token, uuid);
      expect(errorCode).toBe('ValidationError');
      expect(inner).toHaveLength(1);
      expect(inner[0]?.errorCode).toBe('PrecheckFailed');
    } finally {
      await emulator.stop();
    }
  });

  it('returns 202 Invalid PrecheckFailed when mkdtemp fails and does not leave pending', async () => {
    const { emulator, base, token } = await startPrecheck({
      precheckIo: {
        mkdtemp: async () => {
          throw new Error('ENOSPC');
        },
      },
    });
    try {
      const { uuid } = await submitAndSettle(base, token, invoiceWithMarker('PRECHECK_OK'));
      const details = await fetch(`${base}/api/v1.0/documents/${uuid}/details`, { headers: authHeaders(token) });
      const body = (await details.json()) as { status: string };
      expect(body.status).toBe('Invalid');
      const { errorCode, inner } = await detailsError(base, token, uuid);
      expect(errorCode).toBe('ValidationError');
      expect(inner).toHaveLength(1);
      expect(inner[0]?.errorCode).toBe('PrecheckFailed');
      expect(inner[0]?.error).not.toMatch(/\/tmp\/|myinvois-precheck-|ENOSPC/);

      const retry = await submitRaw(
        base,
        token,
        JSON.stringify({ documents: [encodeDocument(invoiceWithMarker('PRECHECK_OK'), 'JSON', 'INV-1')] }),
      );
      expect(retry.status).toBe(422);
      const retryBody = (await retry.json()) as { error: { errorCode: string } };
      expect(retryBody.error.errorCode).toBe('DuplicateSubmission');
    } finally {
      await emulator.stop();
    }
  });

  it('returns 202 Invalid PrecheckFailed when tmpdir is invalid and does not leave pending', async () => {
    const { emulator, base, token } = await startPrecheck({
      precheckIo: {
        tmpdir: () => join(tmpdir(), 'missing-precheck-parent', 'no-such-dir'),
      },
    });
    try {
      const { uuid } = await submitAndSettle(base, token, invoiceWithMarker('PRECHECK_OK'));
      const { inner } = await detailsError(base, token, uuid);
      expect(inner).toHaveLength(1);
      expect(inner[0]?.errorCode).toBe('PrecheckFailed');
    } finally {
      await emulator.stop();
    }
  });

  it('swallows cleanup failure and keeps a successful precheck result', async () => {
    const { emulator, base, token } = await startPrecheck({
      precheckIo: {
        rm: async (path, options) => {
          await rmDir(path, options);
          throw new Error('EBUSY');
        },
      },
    });
    try {
      const { uuid } = await submitAndSettle(base, token, invoiceWithMarker('PRECHECK_OK'));
      const details = await fetch(`${base}/api/v1.0/documents/${uuid}/details`, { headers: authHeaders(token) });
      const body = (await details.json()) as { status: string; longId: string };
      expect(body.status).toBe('Valid');
      expect(body.longId).toMatch(/^[A-Z0-9]{26}$/);
    } finally {
      await emulator.stop();
    }
  });

  it('swallows cleanup failure after a precheck error and still stores PrecheckFailed', async () => {
    const { emulator, base, token } = await startPrecheck({
      precheckIo: {
        writeFile: async () => {
          throw new Error('EIO');
        },
        rm: async (path, options) => {
          await rmDir(path, options);
          throw new Error('EBUSY');
        },
      },
    });
    try {
      const { uuid } = await submitAndSettle(base, token, invoiceWithMarker('PRECHECK_OK'));
      const { inner } = await detailsError(base, token, uuid);
      expect(inner).toHaveLength(1);
      expect(inner[0]?.errorCode).toBe('PrecheckFailed');
    } finally {
      await emulator.stop();
    }
  });

  it('caps concurrent precheck children', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'precheck-conc-'));
    dirs.push(dir);
    process.env.PRECHECK_CONCURRENCY_DIR = dir;
    const { emulator, base, token } = await startPrecheck();
    try {
      const documents = Array.from({ length: 8 }, (_, index) =>
        encodeDocument(invoiceWithMarker(`PRECHECK_OK-${index}`), 'JSON', `N-${index}`),
      );
      const res = await submitRaw(base, token, JSON.stringify({ documents }));
      expect(res.status).toBe(202);
      const max = Number(readFileSync(join(dir, 'max'), 'utf8'));
      expect(max).toBeGreaterThan(0);
      expect(max).toBeLessThanOrEqual(4);
    } finally {
      delete process.env.PRECHECK_CONCURRENCY_DIR;
      await emulator.stop();
    }
  });
});

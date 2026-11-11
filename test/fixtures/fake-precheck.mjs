#!/usr/bin/env node
import { appendFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const file = process.argv.slice(2).find((arg) => !arg.startsWith('-'));
if (file === undefined) {
  process.stderr.write('missing file\n');
  process.exit(2);
}

let text;
try {
  text = readFileSync(file, 'utf8');
} catch {
  process.stderr.write('unreadable file\n');
  process.exit(2);
}

if (process.env.PRECHECK_PATH_LOG) {
  appendFileSync(process.env.PRECHECK_PATH_LOG, `${file}\n`);
}

const concurrencyDir = process.env.PRECHECK_CONCURRENCY_DIR;
let releaseSlot = () => undefined;
if (concurrencyDir) {
  const slots = join(concurrencyDir, 'slots');
  mkdirSync(slots, { recursive: true });
  const id = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const slot = join(slots, id);
  writeFileSync(slot, '1');
  const active = readdirSync(slots).length;
  const maxPath = join(concurrencyDir, 'max');
  let max = 0;
  try {
    max = Number(readFileSync(maxPath, 'utf8'));
  } catch {
    max = 0;
  }
  if (active > max) writeFileSync(maxPath, String(active));
  releaseSlot = () => {
    try {
      unlinkSync(slot);
    } catch {
      // already removed
    }
  };
}

function report({ ok, errorCount, warningCount, findings }) {
  process.stdout.write(
    JSON.stringify({
      file,
      ok,
      version: '1.1',
      errorCount,
      warningCount,
      findings,
    }),
  );
}

function finding(rule, severity, path, message) {
  return { rule, severity, path, message, docUrl: `https://example.test/${rule}` };
}

function done(code) {
  releaseSlot();
  process.exit(code);
}

if (concurrencyDir) {
  await new Promise((resolve) => {
    setTimeout(resolve, 80);
  });
}

if (text.includes('PRECHECK_EXIT_2')) {
  done(2);
}
if (text.includes('PRECHECK_GARBAGE')) {
  process.stdout.write('this is not a JSON report');
  done(0);
}
if (text.includes('PRECHECK_SLEEP')) {
  await new Promise((resolve) => {
    setTimeout(resolve, 60_000);
  });
}
if (text.includes('PRECHECK_WARN')) {
  report({
    ok: true,
    errorCount: 0,
    warningCount: 1,
    findings: [finding('warn.example', 'warning', 'Invoice', 'a warning')],
  });
  done(0);
}
if (text.includes('PRECHECK_ERROR_COUNT_ONLY')) {
  report({
    ok: false,
    errorCount: 2,
    warningCount: 1,
    findings: [finding('warn.example', 'warning', 'Invoice', 'a warning')],
  });
  done(1);
}
if (text.includes('PRECHECK_ERROR')) {
  report({
    ok: false,
    errorCount: 1,
    warningCount: 0,
    findings: [
      finding(
        'math.line-total-excl',
        'error',
        'Invoice[0].InvoiceLine[0].LineExtensionAmount',
        'line total does not match',
      ),
    ],
  });
  done(1);
}
report({ ok: true, errorCount: 0, warningCount: 0, findings: [] });
done(0);

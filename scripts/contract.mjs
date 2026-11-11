#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COLLECTION_URL,
  CLOCK_ADVANCE_NAME,
  IN_SCOPE,
  PINNED_SHA256,
  SKIPPED,
  assertPinnedSha256,
  sha256Hex,
  transformCollection,
} from './contract-transform.mjs';

const require = createRequire(import.meta.url);
const newman = require('newman');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'dist', 'cli.js');
const cacheDir = path.join(root, '.cache');
const cacheFile = path.join(cacheDir, 'EInvoicing-SDK.postman_collection.json');
const reportsDir = path.join(root, 'reports');
const reportJson = path.join(reportsDir, 'contract.json');
const reportTxt = path.join(reportsDir, 'contract.txt');

const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_TIMEOUT_MS = 20000;

function assertLoopback(url) {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1') {
    throw new Error(`refusing non-loopback URL ${url}`);
  }
}

async function downloadWithRetries(url) {
  let lastError;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!response.ok) {
        throw new Error(`GET ${url} → HTTP ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < DOWNLOAD_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function loadCollectionBytes() {
  const override = process.env.CONTRACT_COLLECTION;
  if (typeof override === 'string' && override.length > 0) {
    const bytes = await readFile(override);
    assertPinnedSha256(bytes);
    return bytes;
  }

  try {
    const cached = await readFile(cacheFile);
    try {
      assertPinnedSha256(cached);
      return cached;
    } catch {
      // Stale cache from a previous pin; download again.
    }
  } catch {
    // Cache miss.
  }

  const bytes = await downloadWithRetries(COLLECTION_URL);
  assertPinnedSha256(bytes);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(cacheFile, bytes);
  return bytes;
}

function runNewman(collection) {
  return new Promise((resolve, reject) => {
    newman.run(
      {
        collection,
        timeout: 120000,
        timeoutRequest: 15000,
        reporters: ['cli'],
      },
      (error, summary) => {
        if (error) reject(error);
        else resolve(summary);
      },
    );
  });
}

function executionStatus(execution) {
  const code = execution?.response?.code;
  return typeof code === 'number' ? code : null;
}

function executionFailed(execution) {
  const assertions = Array.isArray(execution?.assertions) ? execution.assertions : [];
  return assertions.some((assertion) => assertion.error);
}

function formatLine(name, expected, actual, extra) {
  const actualText = actual === null ? 'no response' : String(actual);
  const suffix = extra ? `  (${extra})` : '';
  return `  ${name}  expected ${expected}  actual ${actualText}${suffix}`;
}

async function writeReports(report) {
  await mkdir(reportsDir, { recursive: true });
  await writeFile(reportJson, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(reportTxt, `${report.text}\n`);
}

try {
  await readFile(cli);
} catch {
  console.error('dist/cli.js is missing. Run npm run build first.');
  process.exit(1);
}

/** @type {import('node:child_process').ChildProcess | null} */
let child = null;
let stderr = '';

async function stopChild() {
  if (child === null) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child?.kill('SIGKILL');
      resolve(undefined);
    }, 2000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
}

try {
  const bytes = await loadCollectionBytes();
  const digest = sha256Hex(bytes);
  const official = JSON.parse(bytes.toString('utf8'));

  child = spawn(
    process.execPath,
    [cli, 'start', '--port', '0', '--host', '127.0.0.1', '--seed', '42', '--clock', 'fake'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const started = child;
  const base = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for the emulator to listen\n${buffer}\n${stderr}`));
    }, 10000);
    started.stdout.setEncoding('utf8');
    started.stdout.on('data', (chunk) => {
      buffer += chunk;
      const match = buffer.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    started.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code} before listen\n${buffer}\n${stderr}`));
    });
  });
  assertLoopback(base);

  const sample = await readFile(path.join(root, 'fixtures/samples/1.1-Invoice-Sample.json'));
  const transformed = transformCollection(official, {
    baseUrl: base,
    documentBase64: sample.toString('base64'),
    documentHash: sha256Hex(sample),
  });

  const summary = await runNewman(transformed.collection);
  const executions = Array.isArray(summary?.run?.executions) ? summary.run.executions : [];
  const byItem = new Map();
  for (const execution of executions) {
    const name = execution?.item?.name;
    if (typeof name === 'string') byItem.set(name, execution);
  }

  const passed = [];
  const failed = [];
  for (const spec of IN_SCOPE) {
    const execution = byItem.get(spec.name);
    const actual = execution ? executionStatus(execution) : null;
    const row = {
      name: spec.name,
      expectedStatus: spec.expectedStatus,
      actualStatus: actual,
      note: spec.note,
    };
    if (!execution || executionFailed(execution) || actual !== spec.expectedStatus) {
      const reason = !execution
        ? 'in-scope request was not executed'
        : actual !== spec.expectedStatus
          ? `status ${actual} !== ${spec.expectedStatus}`
          : 'assertion failed';
      failed.push({ ...row, reason });
    } else {
      passed.push(row);
    }
  }

  const helperExec = byItem.get(CLOCK_ADVANCE_NAME);
  const helperActual = helperExec ? executionStatus(helperExec) : null;
  const helper = {
    name: CLOCK_ADVANCE_NAME,
    expectedStatus: 200,
    actualStatus: helperActual,
  };
  if (!helperExec || executionFailed(helperExec) || helperActual !== 200) {
    failed.push({
      ...helper,
      reason: !helperExec ? 'clock-advance helper was not executed' : `status ${helperActual} !== 200`,
    });
  }

  const skipped = SKIPPED.map((entry) => ({
    name: entry.name,
    reason: entry.reason,
    present: transformed.skipped.find((item) => item.name === entry.name)?.present ?? false,
  }));

  const newmanFailures = Array.isArray(summary?.run?.failures) ? summary.run.failures.length : 0;
  const ok = failed.length === 0 && newmanFailures === 0;

  const lines = [
    'Contract check against the official MyInvois Postman collection',
    `sha256: ${digest} (pinned ${PINNED_SHA256})`,
    `emulator: ${base}`,
    '',
    `Passed (${passed.length})`,
    ...passed.map((row) => formatLine(row.name, row.expectedStatus, row.actualStatus, row.note)),
    '',
    `Helper (${helperExec && helperActual === 200 ? 'ok' : 'failed'})`,
    formatLine(helper.name, helper.expectedStatus, helper.actualStatus, 'fake-clock validation delay'),
    '',
    `Skipped (${skipped.length})`,
    ...skipped.map((row) => `  ${row.name}  ${row.reason}`),
    '',
    `Failed (${failed.length})`,
    ...(failed.length === 0
      ? ['  (none)']
      : failed.map((row) => formatLine(row.name, row.expectedStatus, row.actualStatus, row.reason))),
    '',
    `Result: ${passed.length} passed, ${skipped.length} skipped, ${failed.length} failed`,
  ];
  const text = lines.join('\n');

  const report = {
    ok,
    collectionUrl: COLLECTION_URL,
    collectionSha256: digest,
    pinnedSha256: PINNED_SHA256,
    baseUrl: base,
    passed,
    failed,
    skipped,
    helpers: [helper],
    stats: {
      passed: passed.length,
      skipped: skipped.length,
      failed: failed.length,
      newmanFailures,
    },
    text,
  };
  await writeReports(report);
  console.log(text);

  if (!ok) {
    process.exitCode = 1;
  } else {
    console.log('contract ok');
  }
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  if (stderr.trim() !== '') console.error(stderr);
  process.exitCode = 1;
} finally {
  await stopChild();
}

#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'dist', 'cli.js');
const precheck = process.env.MYINVOIS_PRECHECK;

if (!precheck) {
  console.log('skip: MYINVOIS_PRECHECK is unset');
  process.exit(0);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertLoopback(url) {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1') {
    throw new Error(`refusing non-loopback URL ${url}`);
  }
}

function quoteForSplitter(value) {
  if (!/[\s"']/.test(value)) return value;
  if (value.includes("'") && !value.includes('"')) return `"${value}"`;
  return `'${value}'`;
}

try {
  await access(cli);
} catch {
  console.error('dist/cli.js is missing. Run npm run build first.');
  process.exit(1);
}

try {
  await access(precheck);
} catch {
  console.error(`MYINVOIS_PRECHECK is not readable: ${precheck}`);
  process.exit(1);
}

const dir = await mkdtemp(path.join(tmpdir(), 'myinvois-precheck-smoke-'));
const configPath = path.join(dir, 'emulator.json');
await writeFile(
  configPath,
  JSON.stringify({
    validationDelayMs: 0,
    tenants: [
      {
        tin: 'C1234567890',
        name: 'Precheck smoke supplier',
        role: 'supplier',
        clientId: 'precheck-supplier',
        clientSecret: 'precheck-supplier-secret',
        idType: 'BRN',
        idValue: '202001234567',
      },
    ],
  }),
);

const child = spawn(
  process.execPath,
  [
    cli,
    'start',
    '--port',
    '0',
    '--host',
    '127.0.0.1',
    '--seed',
    '1',
    '--clock',
    'fake',
    '--no-rate-limit',
    '--config',
    configPath,
    '--validator',
    'precheck',
    '--precheck-cmd',
    `node ${quoteForSplitter(precheck)} --json`,
  ],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
);

let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});

async function stopChild() {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(undefined);
    }, 2000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function submit(base, token, fixtureName) {
  const bytes = await readFile(path.join(path.dirname(precheck), '..', 'fixtures', fixtureName));
  const res = await fetch(`${base}/api/v1.0/documentsubmissions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      documents: [
        {
          format: 'JSON',
          document: bytes.toString('base64'),
          documentHash: sha256(bytes),
          codeNumber: fixtureName,
        },
      ],
    }),
  });
  const text = await res.text();
  assert(res.status === 202, `submit ${fixtureName} status ${res.status}: ${text}`);
  return JSON.parse(text);
}

try {
  const base = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for the emulator to listen\n${buffer}\n${stderr}`));
    }, 10000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const match = buffer.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code} before listen\n${buffer}\n${stderr}`));
    });
  });
  assertLoopback(base);

  const tokenRes = await fetch(`${base}/connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'precheck-supplier',
      client_secret: 'precheck-supplier-secret',
      scope: 'InvoicingAPI',
    }),
  });
  const tokenText = await tokenRes.text();
  assert(tokenRes.status === 200, `token status ${tokenRes.status}: ${tokenText}`);
  const token = JSON.parse(tokenText).access_token;

  const invalid = await submit(base, token, 'invalid-math.json');
  const invalidId = invalid.acceptedDocuments[0].uuid;
  const invalidDetailsRes = await fetch(`${base}/api/v1.0/documents/${invalidId}/details`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const invalidDetails = await invalidDetailsRes.json();
  assert(invalidDetails.status === 'Invalid', `expected Invalid, got ${invalidDetails.status}`);
  const inner = invalidDetails.validationResults?.validationSteps?.[0]?.error?.innerError ?? [];
  const rules = inner.map((entry) => entry.errorCode);
  assert(
    rules.includes('math.line-total-excl'),
    `expected math.line-total-excl in ${JSON.stringify(rules)}`,
  );

  const valid = await submit(base, token, 'valid-invoice-1.1.json');
  const validId = valid.acceptedDocuments[0].uuid;
  const validDetailsRes = await fetch(`${base}/api/v1.0/documents/${validId}/details`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const validDetails = await validDetailsRes.json();
  assert(validDetails.status === 'Valid', `expected Valid, got ${validDetails.status}`);
  assert(typeof validDetails.longId === 'string' && validDetails.longId.length === 26, 'valid longId');

  console.log('precheck smoke ok');
} finally {
  await stopChild();
  await rm(dir, { recursive: true, force: true });
}

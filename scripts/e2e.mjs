#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'dist', 'cli.js');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertLoopback(url) {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1') {
    throw new Error(`refusing non-loopback URL ${url}`);
  }
}

try {
  await access(cli);
} catch {
  console.error('dist/cli.js is missing. Run npm run build first.');
  process.exit(1);
}

const child = spawn(
  process.execPath,
  [cli, 'start', '--port', '0', '--host', '127.0.0.1', '--seed', '42', '--clock', 'fake'],
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

  const healthRes = await fetch(`${base}/_emulator/health`);
  assert(healthRes.status === 200, `health status ${healthRes.status}`);
  const health = await healthRes.json();
  assert(health.clock === 'fake', `expected fake clock, got ${health.clock}`);

  const tokenRes = await fetch(`${base}/connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'sample-supplier',
      client_secret: 'sample-supplier-secret',
      scope: 'InvoicingAPI',
    }),
  });
  const tokenText = await tokenRes.text();
  assert(tokenRes.status === 200, `token status ${tokenRes.status}: ${tokenText}`);
  const tokenBody = JSON.parse(tokenText);
  assert(tokenBody.token_type === 'Bearer', 'token_type');
  assert(tokenBody.expires_in === 3600, 'expires_in');
  const token = tokenBody.access_token;

  const sample = await readFile(path.join(root, 'fixtures/samples/1.1-Invoice-Sample.json'));
  const document = sample.toString('base64');
  const documentHash = createHash('sha256').update(sample).digest('hex');
  const submitRes = await fetch(`${base}/api/v1.0/documentsubmissions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      documents: [
        { format: 'JSON', document, documentHash, codeNumber: 'E2E-1' },
        { format: 'JSON', document, documentHash, codeNumber: 'E2E-2' },
      ],
    }),
  });
  const submitText = await submitRes.text();
  assert(submitRes.status === 202, `submit status ${submitRes.status}: ${submitText}`);
  const submitBody = JSON.parse(submitText);
  assert(/^[A-Z0-9]{26}$/.test(submitBody.submissionUID), `submissionUID ${submitBody.submissionUID}`);
  assert(submitBody.acceptedDocuments.length === 2, 'expected two accepted documents');
  const first = submitBody.acceptedDocuments[0];
  const second = submitBody.acceptedDocuments[1];
  assert(/^[A-Z0-9]{26}$/.test(first.uuid), 'first uuid');
  assert(/^[A-Z0-9]{26}$/.test(second.uuid), 'second uuid');

  const advance = async (ms) => {
    const res = await fetch(`${base}/_emulator/clock/advance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ms }),
    });
    assert(res.status === 200, `advance status ${res.status}`);
  };

  await advance(2000);
  const subRes = await fetch(
    `${base}/api/v1.0/documentsubmissions/${submitBody.submissionUID}?pageNo=1&pageSize=10`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const subText = await subRes.text();
  assert(subRes.status === 200, `get submission ${subRes.status}: ${subText}`);
  const submission = JSON.parse(subText);
  assert(submission.overallStatus === 'valid', `overallStatus ${submission.overallStatus}`);
  assert(submission.documentSummary.length === 2, 'document summary length');
  for (const doc of submission.documentSummary) {
    assert(doc.status === 'Valid', `document status ${doc.status}`);
    assert(/^[A-Z0-9]{26}$/.test(doc.longId), `longId ${doc.longId}`);
  }

  const cancel = (uuid) =>
    fetch(`${base}/api/v1.0/documents/state/${uuid}/state`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ status: 'cancelled', reason: 'e2e cancel' }),
    });

  const within = await cancel(first.uuid);
  const withinText = await within.text();
  assert(within.status === 200, `cancel within 72h ${within.status}: ${withinText}`);
  assert(JSON.parse(withinText).status === 'Cancelled', withinText);

  await advance(72 * 60 * 60 * 1000 + 1000);
  const lateTokenRes = await fetch(`${base}/connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'sample-supplier',
      client_secret: 'sample-supplier-secret',
      scope: 'InvoicingAPI',
    }),
  });
  const lateTokenText = await lateTokenRes.text();
  assert(lateTokenRes.status === 200, `second token ${lateTokenRes.status}: ${lateTokenText}`);
  const lateToken = JSON.parse(lateTokenText).access_token;
  const late = await fetch(`${base}/api/v1.0/documents/state/${second.uuid}/state`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${lateToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ status: 'cancelled', reason: 'e2e cancel after window' }),
  });
  const lateText = await late.text();
  assert(late.status === 400, `cancel after 72h ${late.status}: ${lateText}`);
  const lateBody = JSON.parse(lateText);
  assert(lateBody.error.errorCode === 'OperationPeriodOver', lateText);
  assert(typeof lateBody.error.error === 'string' && lateBody.error.error.length > 0, 'error');
  assert(typeof lateBody.error.errorMS === 'string' && lateBody.error.errorMS.length > 0, 'errorMS');
  assert('propertyName' in lateBody.error && 'propertyPath' in lateBody.error, 'error fields');
  assert('target' in lateBody.error && 'innerError' in lateBody.error, 'error fields');
  assert(/^[A-Z0-9]{26}$/.test(late.headers.get('correlationid') ?? ''), 'correlationId');

  console.log('e2e ok');
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  if (stderr.trim() !== '') console.error(stderr);
  process.exitCode = 1;
} finally {
  await stopChild();
}

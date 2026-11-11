# myinvois-emulator

Offline, stateful stand-in for the LHDN MyInvois identity and e-invoicing HTTP API. Point an ERP or SDK at `http://127.0.0.1:8787` and exercise submit, poll, cancel, and reject without preprod credentials, a signing certificate, or a call to LHDN.

This increment is the P0 core. The code was written by Grok CLI.

The process never opens a connection to LHDN or to any other host. It only accepts connections on the address you bind (by default `127.0.0.1`).

## Quick start

```bash
npm install
npm run build
node dist/cli.js start --port 8787 --host 127.0.0.1 --seed 42 --clock fake
```

Rate limits are on by default. Pass `--no-rate-limit` to disable them, or `--rpm-scale 0.5` to halve every per-endpoint RPM. Pass `--faults fixtures/faults/500-storm.json` to inject reproducible 500s, latency, 429s, or dropped connections. Pass `--validator precheck --precheck-cmd "node /path/to/myinvois-precheck/dist/cli.js --json"` to validate with the separate myinvois-precheck CLI (not an npm dependency; you must build it yourself).

The process prints `myinvois-emulator listening on http://127.0.0.1:8787`.

Default client for the public samples (the supplier TIN in those files is the placeholder `Supplier's TIN`):

| | |
|---|---|
| client_id | `sample-supplier` |
| client_secret | `sample-supplier-secret` |
| scope | `InvoicingAPI` (optional; granted when omitted) |

```bash
curl -s -X POST http://127.0.0.1:8787/connect/token \
  -H 'content-type: application/x-www-form-urlencoded' \
  -d 'grant_type=client_credentials&client_id=sample-supplier&client_secret=sample-supplier-secret&scope=InvoicingAPI'
```

Docker (local build only; no image is published):

```bash
docker build -t myinvois-emulator .
docker run --rm -p 127.0.0.1:8787:8787 myinvois-emulator
# pass your own flags after the image name, keeping --host 0.0.0.0 and --port 8787:
docker run --rm -p 127.0.0.1:8787:8787 myinvois-emulator start --host 0.0.0.0 --port 8787 --clock fake --seed 42
```

The image is `node:20-alpine` (pinned by digest), runs as the `node` user, contains only `dist/`, `package.json` and `fixtures/` (so `--config fixtures/tenants.json` works), and has a `HEALTHCHECK` on `/_emulator/health` at port 8787. Mount your own config with `-v "$PWD/emulator.json:/app/emulator.json:ro"` and add `--config emulator.json`. `scripts/docker-smoke.sh` builds the image, checks health, a token, a submit, that Docker reports the `HEALTHCHECK` as `healthy`, and a clean `docker stop`; CI runs it on every pull request and on pushes to main.

With `--clock fake` (or `clock: 'fake'` in `createEmulator`), time does not move until you post to `/_emulator/clock/advance`. Validation therefore stays `in progress` until you advance at least `validationDelayMs` (default 2000). The default CLI clock is `real`: validation completes after two seconds of wall time, and the advance endpoint returns 400.

Library:

```js
import { createEmulator } from 'myinvois-emulator';

const emulator = createEmulator({
  seed: 42,
  clock: 'fake',
  rateLimit: { enabled: true, scale: 1 },
  faults: [{ endpoint: 'submit', kind: 'error500', nth: [2] }],
  validator: 'none',
});
const { url } = await emulator.start({ port: 0, host: '127.0.0.1' });
await emulator.stop();
```

`port: 0` asks the operating system for a free port.

## Commands

```text
npm run build       tsc -p tsconfig.build.json → dist/cli.js
npm run typecheck
npm run lint
npm test            vitest
npm run check       lint, typecheck, and test
npm run e2e         build output: token, sample submit, validate, cancel, late cancel
npm run contract    official Postman collection against a local emulator (newman)
```

Node.js 20 or newer. Runtime dependencies: none (`node:http` only). Newman is a devDependency used only by `npm run contract`.

## Contract check

`npm run contract` starts the emulator (`port 0`, fake clock, seed 42, rate limits on) and runs the official LHDN MyInvois Postman collection against it. It proves the in-scope official requests reach the **expected HTTP status** on this emulator. It does not prove sandbox compatibility.

The collection is **not** vendored. The script downloads

`https://sdk.myinvois.hasil.gov.my/files/EInvoicing%20SDK.postman_collection.json`

(with retries and a timeout), verifies sha256 `0d06b70e63648bf68a267b7fb1e88a7c4c0d7193946f5973d09271823ca3ee79` (pinned 2026-11-11), and caches the file under `.cache/`. Set `CONTRACT_COLLECTION=/path/to/collection.json` to use a local copy; the pin is still checked. A sha mismatch fails with the expected and actual digests — LHDN published a new collection.

The runner rewrites `https://{{idSrvBaseUrl}}` and `https://{{apiBaseUrl}}` to the emulator's loopback URL, fills placeholders with the built-in fake tenants, injects a valid sample Invoice submit body, and adds Postman tests for the expected status. Dependent ids (`generatedAccessToken`, `submissionUid`, `documentUUID`) come from earlier responses. After Submit Documents it posts `/_emulator/clock/advance` so fake-clock validation can finish before Get / Cancel.

In-scope requests and expected status:

| Request | Expected | Notes |
|---|---|---|
| Login as Taxpayer System | 200 | `sample-supplier` / `sample-supplier-secret` |
| Login as Intermediary System | 200 | `intermediary-a`. The collection's sample `onbehalfof` value is replaced with `C00000000000`, which that intermediary is authorized to represent. The taxpayer token is kept for later calls. |
| Validate taxpayer TIN | 200 | Known fake TIN `C00000000000` + `BRN` / `201901000001` |
| Submit Documents | 202 | Public `1.1-Invoice-Sample.json` |
| Get Submission | 200 | `submissionUID` from submit |
| Get Document | 200 | raw body for the submitted uuid |
| Get Document Details | 200 | |
| Get Recent Documents | 200 | Invalid placeholder filters (`direction`, `status`, paging, …) dropped. A submission date pair, when present, is filled with 2026-01-01 .. 2026-01-31. The public sample's issue date is older than 31 days from the fake clock, so `result` may be empty. |
| Search Documents | 200 | `submissionDateFrom`/`submissionDateTo` filled with 2026-01-01 .. 2026-01-31 (fake-clock origin). `uuid` is the submitted document. Other placeholder filters dropped. |
| Cancel Document | 200 | supplier, within the 72-hour window |
| Reject Document | 400 | Same uuid after Cancel, still the supplier token. Already `Cancelled` → `IncorrectState`. |

Skipped (listed in `reports/contract.txt`, not silent):

| Request | Reason |
|---|---|
| Get All Document Types | Platform document types are not implemented |
| Get Document Type | Platform document types are not implemented |
| Get Document Type Version | Platform document types are not implemented |
| Get Notifications | Platform notifications are not implemented |

The script writes `reports/contract.json` and `reports/contract.txt` (gitignored) and exits nonzero if an assertion fails or an in-scope request is missing from the collection.

To update the pin after LHDN publishes a new collection:

1. Download the new JSON and `sha256sum` it.
2. Diff request names against `IN_SCOPE` / `SKIPPED` in `scripts/contract-transform.mjs`.
3. Replace `PINNED_SHA256` there and the digest in this section.
4. Adjust expected statuses if a renamed or new in-scope request needs it.

## Endpoints

| Method | Path | Auth | What it does |
|---|---|---|---|
| POST | `/connect/token` | no | `application/x-www-form-urlencoded` client credentials. Returns `access_token`, `token_type: Bearer`, `expires_in` (3600). An intermediary adds the `onbehalfof` header (see Intermediary login). |
| POST | `/api/v1.0/documentsubmissions/` | bearer | Submit `documents[]`. Trailing slash optional. `202` with `submissionUID`, `acceptedDocuments`, `rejectedDocuments`. |
| GET | `/api/v1.0/documentsubmissions/{uid}?pageNo&pageSize` | bearer | `overallStatus`: `in progress`, `valid`, `partially valid`, or `invalid`. |
| GET | `/api/v1.0/documents/{uuid}/raw` | bearer | Original document text and hash. |
| GET | `/api/v1.0/documents/{uuid}/details` | bearer | Status plus `validationResults`. |
| GET | `/api/v1.0/documents/recent` | bearer | Documents visible to the caller from the last 31 days. `{ result, metadata }`. |
| GET | `/api/v1.0/documents/search` | bearer | Same summary shape. Requires a submission or issue date range. |
| PUT | `/api/v1.0/documents/state/{uuid}/state` | bearer | `{ "status": "cancelled" \| "rejected", "reason": "..." }`. |
| GET | `/api/v1.0/taxpayer/validate/{tin}?idType&idValue` | bearer | `200` empty body, `400` if a query param is missing, `404` otherwise. |

Every response, including errors and the empty `200`, carries a `correlationId` header (26 characters, `[A-Z0-9]`). Limited API responses also carry `X-Rate-Limit-*` headers (see Rate limiting).

Document and submission ids are 26 characters from `[A-Z0-9]`, produced by a seeded PRNG. The same seed and the same sequence of token and submit calls yield the same ids.

### Intermediary login

An `intermediary` tenant logs in with the extra header `onbehalfof: <TIN>` or `onbehalfof: <TIN>:<ROB>`, as on the [Login as Intermediary System](https://sdk.myinvois.hasil.gov.my/api/08-login-as-intermediary-system/) page. Its `representedTins` list is the authorization table: the header must equal one entry exactly (a `TIN:ROB` entry does not accept the bare TIN, and the reverse). The built-in `intermediary-a` may represent `Supplier's TIN` and `C00000000000`, but not `C00000000001`.

- An authorized token acts as the represented taxpayer for every API call: submit (the supplier TIN must be the represented TIN, else `403 IncorrectSubmitter`), get, recent, search, cancel and reject. Documents it submits record `createdByUserId` = the intermediary `client_id` and fill `intermediaryTin`, `intermediaryName` and `intermediaryRob` (the intermediary's BRN when its `idType` is `BRN`).
- An unauthorized or unknown `onbehalfof` value depends on `intermediaryDenial`. With `api` (default) the token is issued and every API call with it returns `403 IncorrectSubmitter`. With `token` the login itself returns that error.
- `onbehalfof` from a supplier or buyer client, or an empty value, returns `400 invalid_request`.
- An intermediary without the header logs in as itself (its own TIN), with the intermediary fields left `null`.

### Submit rules

- Each item needs `format` (`JSON` or `XML`), `document` (standard base64), `documentHash` (SHA-256 hex of the decoded bytes, case-insensitive), and `codeNumber`.
- At most 100 documents, 300 KiB each (`300 * 1024` bytes), 5 MiB total (`5 * 1024 * 1024`). Over the limit: `400` `MaximumSizeExceeded`. A size equal to the limit is accepted.
- Malformed JSON, missing fields, bad base64, or a hash mismatch: `400` `BadStructure`. A hash mismatch also includes `innerError[].errorCode = DocumentHashMismatch`.
- When the document has an Invoice root and its supplier TIN is not the token tenant's TIN: `403` `IncorrectSubmitter`. TIN is read from UBL JSON (`AccountingSupplierParty` / `PartyIdentification` / `ID` with `schemeID` `TIN`) and from the same element in XML.
- The same raw body bytes accepted again within 10 minutes, including the exact 10-minute mark: `422` `DuplicateSubmission` and `Retry-After` (delta-seconds). At 10 minutes + 1ms the body is accepted again.
- Otherwise `202`. Documents stay `Submitted` until the validation delay elapses, then become `Valid` (with `longId` and `dateTimeValidated`) or `Invalid`.

`dateTimeValidated` is the moment the delay elapses (`receivedAt + validationDelayMs`), not the time of a later poll. A fake-clock jump past that moment does not move the 72-hour window forward.

`overallStatus` is `in progress` while any document is still `Submitted`, `valid` when every document passed validation, `invalid` when none did, and `partially valid` otherwise. Cancel and reject do not change it.

### Get recent documents and search documents

`GET /api/v1.0/documents/recent` and `GET /api/v1.0/documents/search` are authenticated like the other document routes. Both return:

```json
{
  "result": [ { "uuid": "...", "submissionUID": "...", "status": "Valid" } ],
  "metadata": { "totalPages": 1, "totalCount": 1 }
}
```

Results are newest first (`dateTimeReceived` descending). `pageNo` is 1-based (default 1). `pageSize` defaults to 100 and cannot exceed 100; invalid paging returns `400` `BadStructure`. Matching documents are capped at 10,000 before paging.

Visibility is the caller's tenant:

- **Sent** (issuer): `supplierTIN` matches the token TIN, or the token tenant submitted the document. Any status.
- **Received** (buyer): `buyerTIN` matches the token TIN, and status is `Valid` or `Cancelled` only.
- No `direction` / `invoiceDirection`: union of the two. `Sent` and `Received` are the documented values; `direction`, `invoiceDirection`, and `InvoiceDirection` are all accepted.

Date rules follow the LHDN pages (31 days, emulator clock):

- Pair partners are mandatory: `submissionDateFrom` with `submissionDateTo`, `issueDateFrom` with `issueDateTo`. One side alone is `400`.
- Each pair must be a full ISO-8601 datetime with `Z` or an explicit offset (for example `2026-01-01T00:00:00Z` or `2026-01-01T08:00:00+08:00`). Date-only values (`2026-01-01`) and offset-less datetimes (`2026-01-01T00:00:00`) are `400`. `from <= to`, and at most 31 days apart (`31 * 24 * 60 * 60 * 1000` ms, inclusive).
- Issued time is UBL `IssueDate`+`IssueTime` (offset-less `IssueTime` is UTC). When `IssueDate` is absent, `dateTimeReceived` is used. That fallback applies to the recent 31-day window and to `issueDateFrom`/`issueDateTo` on both endpoints.
- **Recent** always restricts to documents issued in the last 31 days (with the fallback above).
- **Search** requires either the submission pair or the issue pair (or both). It does not apply the rolling 31-day recency window.

Receiver filters (`receiverId`, `receiverIdType`, `receiverTin`) require `direction=Sent`. Issuer filters (`issuerId`, `issuerIdType`, `issuerTin`) require `direction=Received`. `receiverIdType` / `issuerIdType` are required when the matching id is sent (`BRN`, `PASSPORT`, `NRIC`, `ARMY`). `status` is `Valid`, `Invalid`, `Cancelled`, or `Submitted`. `documentType` matches UBL `InvoiceTypeCode` (for example `01`). Search also accepts `uuid`, `searchQuery` (letters, digits, space, `.` `'` `_` `-`; matches uuid, buyer/supplier TIN and name, internal id, total), and `classificationCode` (comma-separated UBL classification codes).

Summary fields the emulator fills from the stored document and UBL when present: `uuid`, `submissionUID`, `longId`, `internalId`, `typeName`, `typeVersionName`, `issuerTin`, `issuerName`, `receiverId`, `receiverName`, `dateTimeIssued`, `dateTimeReceived`, `dateTimeValidated`, `totalSales`, `totalDiscount`, `netAmount`, `total`, `totalExcludingTax` (same as `totalSales`), `totalNetAmount` (same as `netAmount`), `totalPayableAmount` (same as `total`), `status`, `cancelDateTime`, `rejectRequestDateTime`, `documentStatusReason`, `createdByUserId` (submitter `client_id`; the intermediary's for an intermediary login), `supplierTIN` / `supplierTin`, `supplierName`, `buyerName`, `buyerTIN` / `buyerTin`, `classificationCodeValues`. `submissionChannel` is always `ERP`.

`intermediaryName`, `intermediaryTin` and `intermediaryRob` are filled only for documents submitted through an intermediary login; otherwise `null`. Amounts, names, ids, type, and issue time are also `null` when the document has no Invoice root or the UBL omits them.

### Cancel and reject

Only a `Valid` document can be cancelled or rejected, and only while `now <= dateTimeValidated + 72h` (71:59:59 and 72:00:00 succeed; 72:00:01 returns `OperationPeriodOver`).

The supplier TIN on the document may cancel. The buyer TIN may reject. The other direction, or any other state (`Submitted`, `Invalid`, `Cancelled`, `Rejected`), returns `IncorrectState`. Wrong state wins over the window, so cancelling an `Invalid` document is `IncorrectState` even after 72 hours.

### Validators

Every accepted document still has to pass the structural Invoice-root check. A credit note, unparseable payload, or XML that contains `<!DOCTYPE` or `<!ENTITY` becomes `Invalid` with `validationResults.validationSteps[].error.innerError[]` (`InvalidStructure`) and never shells out.

`none` (default). After the validation delay, a parseable JSON or XML document whose root is `Invoice` (a namespace prefix is ignored) becomes `Valid`. That is the whole rule set.

`precheck`. After the Invoice-root check, the emulator writes the decoded document to a fresh temp file (`.json` or `.xml` from the submission format) and runs a user-supplied command with `child_process.spawn` (no shell). The last argument is the temp path. The command must be the myinvois-precheck CLI in JSON mode, for example `node dist/cli.js --json`. myinvois-precheck is a **separate private tool**; this package does not depend on it, and you have to build it yourself.

Library:

```js
createEmulator({
  validator: {
    kind: 'precheck',
    command: ['node', '/path/to/myinvois-precheck/dist/cli.js', '--json'],
    timeoutMs: 10000, // optional, default 10000
  },
});
```

CLI:

```bash
node dist/cli.js start --validator precheck --precheck-cmd "node /path/to/myinvois-precheck/dist/cli.js --json"
```

`--precheck-cmd` is required when `--validator precheck`. The string is split with a small quote-aware argv splitter (single and double quotes; no `$VAR`, `~`, or glob expansion). An empty or missing command, or `--validator` other than `none`/`precheck`, is a startup error and the process exits nonzero.

Mapping of a parseable JSON report (exit 0 or 1):

| Precheck | Document |
|---|---|
| `errorCount === 0` (warnings allowed) | `Valid` |
| one or more error-severity findings | `Invalid`, `innerError[]` one entry per error: `errorCode` = `finding.rule`, `error` = `finding.message`, `propertyPath` = `finding.path`, `target` = `finding.rule` |

Exit 2, timeout (default 10s), spawn failure, stdout over 4 MiB, or output that is not a JSON report: `Invalid` with a single `innerError` `errorCode` `PrecheckFailed` and a short reason. Reasons never include stack traces or absolute temp paths. At most four precheck children run at once; further documents wait in a queue. Temp directories are always removed.

`scripts/precheck-smoke.mjs` submits the private tool's `invalid-math.json` and `valid-invoice-1.1.json` fixtures when `MYINVOIS_PRECHECK` is the path to that tool's `dist/cli.js`. It skips when the env var is unset (CI cannot see the private repo).

### TIN validate

`idType` and `idValue` are required. A match against a configured tenant (`idType` compared case-insensitively, TIN and `idValue` exact) returns `200` with an empty body. Otherwise `404`.

### Errors

Failures use this envelope:

```json
{
  "error": {
    "propertyName": null,
    "propertyPath": null,
    "errorCode": "BadStructure",
    "error": "Human readable English message",
    "errorMS": "Mesej Bahasa Melayu",
    "target": null,
    "innerError": null
  }
}
```

`errorMS` is always present. The Malay text is a local paraphrase, not an official LHDN string.

An HTTP request body larger than 16 MiB (`16 * 1024 * 1024`) returns `400` `MaximumSizeExceeded` in this envelope, including `correlationId`. The emulator sends that response and then stops reading the rest of the body. A malformed request target, such as `/%ZZ`, returns `400` in this envelope.

Exceeding a per-endpoint RPM returns `429` `RateLimitExceeded` in this envelope, with `Retry-After` and `X-Rate-Limit-*` headers.

## Rate limiting

Each pair of (client identity, endpoint) has a fixed 60-second window on the emulator clock. Fake-clock tests are deterministic: counts reset when you `POST /_emulator/clock/advance` past the window, with no real timers.

Client identity is the OAuth `client_id` on `POST /connect/token`, and the bearer token's client on API routes. Requests with no `client_id` and unauthenticated API calls share one bucket. `/_emulator/*` control routes are never limited.

Default RPM (from the MyInvois integration-practices table). Effective limit is `max(1, floor(rpm * scale))`.

| Endpoint | Path | RPM |
|---|---|---|
| Login / token | `POST /connect/token` | 12 |
| Submit documents | `POST /api/v1.0/documentsubmissions` | 100 |
| Get submission | `GET /api/v1.0/documentsubmissions/{uid}` | 300 |
| Cancel / reject document | `PUT /api/v1.0/documents/state/{uuid}/state` | 12 |
| Get document (raw) | `GET /api/v1.0/documents/{uuid}/raw` | 60 |
| Get document details | `GET /api/v1.0/documents/{uuid}/details` | 125 |
| Get recent documents | `GET /api/v1.0/documents/recent` | 12 |
| Search documents | `GET /api/v1.0/documents/search` | 12 |
| Validate TIN | `GET /api/v1.0/taxpayer/validate/{tin}` | 60 |

Over the limit: HTTP `429` with the standard error envelope (`errorCode` `RateLimitExceeded`, English `error` and Malay `errorMS`) plus:

| Header | When | Value |
|---|---|---|
| `Retry-After` | 429 | Whole seconds until the window resets, at least 1 |
| `X-Rate-Limit-Limit` | 200 and 429 | Effective RPM for that endpoint |
| `X-Rate-Limit-Remaining` | 200 and 429 | Requests left in this window (`0` on 429) |
| `X-Rate-Limit-Reset` | 200 and 429 | ISO-8601 UTC instant of the window reset |
| `correlationId` | every response | Unchanged |

Library option `rateLimit`:

```js
createEmulator({
  rateLimit: {
    enabled: true,          // default true
    scale: 1,               // default 1; multiply RPM, then floor, minimum 1
    rpm: { token: 12 },     // optional partial overrides of the base RPM, applied before scale
  },
});
```

`scale` must be a finite number greater than 0. CLI: `--rpm-scale <n>` and `--no-rate-limit`. `POST /_emulator/reset` also clears rate-limit counters.

## Fault injection

Integrators can replay 500s, extra latency, fake 429s, and dropped connections against the same seed and request sequence.

Each rule is:

| Field | Required | Meaning |
|---|---|---|
| `endpoint` | yes | One of the rate-limit keys (`token`, `submit`, `getSubmission`, `cancelReject`, `getDocument`, `getDocumentDetails`, `getRecent`, `search`, `validateTin`) or `*` |
| `kind` | yes | `error500`, `latency`, `rateLimit429`, or `reset` |
| `probability` | one of `probability` or `nth` | Inclusive `0..1`. A seeded PRNG decides each matching request |
| `nth` | one of `probability` or `nth` | Array of 1-based request counts for that endpoint since faults were set or reset |
| `latencyMs` | `latency` only | Integer `0..60000`. Delay uses a real `setTimeout`, including when the emulator clock is fake |
| `retryAfterSeconds` | `rateLimit429` optional | Positive integer for `Retry-After`. Default `60` |

Kinds:

- `error500` — HTTP `500` with the standard envelope, `errorCode` `SystemError`, English + Malay messages, and `correlationId`.
- `rateLimit429` — same envelope and `Retry-After` / `X-Rate-Limit-*` headers as a real RPM 429. It does **not** consume the real rate-limit counters.
- `latency` — wait `latencyMs` on the wall clock, then continue. Matching latency stacks with a later non-latency fault on the same request, or with a normal response if none matches.
- `reset` — destroy the socket without writing a response.

Rules are evaluated before normal handling. The first matching non-latency rule wins. A matching latency rule applies its delay and the scan continues. `/_emulator/*` is never faulted.

Probability draws come from a mulberry32 stream derived from `--seed` (the same mixer as document ids, a separate stream). The same seed and the same request sequence produce the same faults.

Library option `faults`:

```js
createEmulator({
  seed: 42,
  faults: [
    { endpoint: 'submit', kind: 'error500', nth: [2] },
    { endpoint: '*', kind: 'latency', latencyMs: 50, probability: 0.25 },
  ],
});
```

CLI: `--faults fixtures/faults/500-storm.json`. The file is a JSON array of rules or `{ "faults": [...] }`. Invalid rules throw at `createEmulator` and make the CLI exit nonzero.

Runtime control:

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/_emulator/faults` | JSON array or `{ "faults": [...] }` | Replace rules, reset per-endpoint fault counters, return `{ "faults": [...] }`. `400` envelope when a rule is invalid (existing rules stay). |
| GET | `/_emulator/faults` | | Current rules. |
| DELETE | `/_emulator/faults` | | Clear rules and their counters. |

`POST /_emulator/reset` clears per-endpoint fault counters and keeps the rules.

Example files, also loaded by tests:

- `fixtures/faults/500-storm.json` — `*` `error500` at probability `0.5`
- `fixtures/faults/latency.json` — `250ms` on every submit
- `fixtures/faults/429.json` — fake 429 on the first three submits, `Retry-After: 30`

Pending latency timers are cancelled when the server stops, so a delayed request cannot outlive `emulator.stop()`.

## Recording requests

`--record requests.jsonl` (library: `record` option, or `createJsonlRecorder(path)`) appends one JSON line per exchange when the response finishes or the connection drops:

```json
{"seq":1,"at":"2026-11-11T16:19:21.036Z","method":"POST","target":"/connect/token","requestHeaders":{"content-type":"application/x-www-form-urlencoded"},"requestBody":"grant_type=client_credentials&client_id=sample-supplier&client_secret=%5Bredacted%5D&scope=InvoicingAPI","status":200,"responseBody":"{\"access_token\":\"[redacted]\",\"token_type\":\"Bearer\",\"expires_in\":3600,\"scope\":\"InvoicingAPI\"}"}
```

- `client_secret` (form or JSON) and top-level `access_token` become `[redacted]`. The `Authorization` header is never stored; only `content-type` and `onbehalfof` are kept.
- Submission bodies are stored as sent, including base64 documents. Do not record real invoices you would not keep in a file.
- `status` and `responseBody` are `null` for a dropped connection (for example a `reset` fault). A missing directory or unwritable file is a startup error (exit 2). A recorder that throws is reported through `onError`; the response is unaffected.
- Replaying a recording against the emulator is not built in yet.

## Control endpoints

No bearer token. They are how tests move time without sleeping.

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/_emulator/clock/advance` | `{ "ms": 7200000 }` | Moves a fake clock forward by a non-negative integer number of milliseconds and settles due validations. `400` when the clock is real. |
| POST | `/_emulator/reset` | empty | Drops tokens, submissions, documents, the duplicate-body window, rate-limit counters, and per-endpoint fault counters (keeps fault rules). Does not rewind the clock. |
| GET | `/_emulator/state` | | Submissions, documents (including the original text), `now`, clock mode, and seed. No client secrets. |
| GET | `/_emulator/health` | | `{ "status": "ok", "clock": "fake" \| "real", "now": "..." }`. |
| POST | `/_emulator/faults` | JSON array or `{ "faults": [...] }` | Replace fault rules and reset per-endpoint fault counters. `200` `{ "faults": [...] }`. `400` when a rule is invalid. |
| GET | `/_emulator/faults` | | Current fault rules. |
| DELETE | `/_emulator/faults` | | Clear fault rules and reset their counters. |

## Config file

`--config emulator.json`. Unknown keys are ignored. A present `tenants` array **replaces** the built-in list. Omitted fields keep the defaults. See `fixtures/tenants.json`.

```json
{
  "validationDelayMs": 2000,
  "duplicateWindowMs": 600000,
  "cancelWindowMs": 259200000,
  "tokenTtlSeconds": 3600,
  "intermediaryDenial": "api",
  "errorCodes": {
    "operationPeriodOver": "OperationPeriodOver",
    "incorrectState": "IncorrectState",
    "invalidClient": "invalid_client",
    "badStructure": "BadStructure",
    "maximumSizeExceeded": "MaximumSizeExceeded",
    "incorrectSubmitter": "IncorrectSubmitter",
    "duplicateSubmission": "DuplicateSubmission",
    "unauthorized": "Unauthorized",
    "notFound": "NotFound",
    "invalidRequest": "invalid_request",
    "rateLimitExceeded": "RateLimitExceeded"
  },
  "statusCodes": {
    "invalidClient": 403,
    "missingParameters": 400,
    "badStructure": 400,
    "maximumSizeExceeded": 400,
    "incorrectSubmitter": 403,
    "duplicateSubmission": 422,
    "unauthorized": 401,
    "notFound": 404,
    "incorrectState": 400,
    "operationPeriodOver": 400,
    "rateLimitExceeded": 429
  },
  "tenants": [
    {
      "tin": "C00000000000",
      "name": "Fake Supplier A Sdn Bhd",
      "role": "supplier",
      "clientId": "supplier-a",
      "clientSecret": "supplier-a-secret",
      "idType": "BRN",
      "idValue": "201901000001"
    }
  ]
}
```

Built-in tenants (also listed in `fixtures/tenants.json`):

| TIN | Role | client_id | client_secret | idType | idValue |
|---|---|---|---|---|---|
| `Supplier's TIN` | supplier | `sample-supplier` | `sample-supplier-secret` | BRN | `Supplier's BRN` |
| `Buyer's TIN` | buyer | `sample-buyer` | `sample-buyer-secret` | BRN | `Buyer's BRN` |
| `C00000000000` | supplier | `supplier-a` | `supplier-a-secret` | BRN | `201901000001` |
| `C00000000001` | supplier | `supplier-b` | `supplier-b-secret` | BRN | `201901000002` |
| `IG00000000000` | buyer | `buyer-a` | `buyer-a-secret` | NRIC | `900101015555` |
| `EI00000000010` | buyer | `buyer-general` | `buyer-general-secret` | BRN | `NA` |
| `EI00000000020` | intermediary | `intermediary-a` | `intermediary-a-secret` | BRN | `202101000001` |

`intermediary-a` has `"representedTins": ["Supplier's TIN", "C00000000000"]`. `representedTins` is allowed only on `intermediary` tenants. Each entry is `TIN` or `TIN:ROB`, must name another configured tenant, and may not repeat.

`Supplier's TIN` and `Buyer's TIN` are the placeholder strings in the public LHDN samples, so those files can be submitted unchanged. `EI00000000010` is the buyer TIN in the public consolidated samples. None of these are real taxpayers. Placeholder token parameters (`""`, `0`, anything starting with `YOUR_`, such as `YOUR_CLIENT_ID`) are rejected with `400` before the tenant table is consulted, so do not use them as a configured client id or secret.

Token lifetime is `tokenTtlSeconds` (default 3600). A token is expired when `now >= issuedAt + ttl`. `expires_in` in the token response is that same value in seconds. Advancing the fake clock past that lifetime expires tokens already issued; take a new one before a 72-hour cancel.

## Behaviour compared with the official docs

Nothing in this table has been checked against the live sandbox or preprod. The column stays **No** until someone records a real call. Several rows are inferences from the public SDK pages plus this product spec; those are called out.

| Behaviour | Official doc | Verified against real sandbox? |
|---|---|---|
| `POST /connect/token`, form body, `grant_type=client_credentials`, response `access_token` / `token_type` / `expires_in` 3600 | [Login as Taxpayer System](https://sdk.myinvois.hasil.gov.my/api/07-login-as-taxpayer-system/) | No |
| `scope` is optional: omitted or empty grants `InvoicingAPI`; a supplied scope is trimmed and echoed. Missing or placeholder client parameters (and a placeholder `scope`) return 400. Only a Basic header, with no form body, returns 400. | [Login](https://sdk.myinvois.hasil.gov.my/api/07-login-as-taxpayer-system/), [Intermediary login](https://sdk.myinvois.hasil.gov.my/api/08-login-as-intermediary-system/), [FAQ](https://sdk.myinvois.hasil.gov.my/faq/) | No. Both login pages mark `scope` optional; granting `InvoicingAPI` when it is omitted is inferred. 400 for a body-less Basic call is taken from field reports, not re-checked here. The placeholder list (`0`, `YOUR_*`, empty) is local. |
| Wrong client id or secret returns 403 `invalid_client`, wrapped in the standard error envelope | [FAQ](https://sdk.myinvois.hasil.gov.my/faq/) (403 Forbidden for a bad client id/secret) | No. The FAQ states 403. Using the standard `error` object, and the code `invalid_client`, is inferred. OAuth token endpoints often return a flatter body. |
| Missing or expired bearer on API routes returns 401 | [Login](https://sdk.myinvois.hasil.gov.my/api/07-login-as-taxpayer-system/) | No. Error code `Unauthorized` is local. |
| Submit limits: 100 documents, 5MB total, 300KB each. `400 MaximumSizeExceeded`. Hash is SHA-256 of the raw document; `document` is base64 of the same bytes. | [Submit Documents](https://sdk.myinvois.hasil.gov.my/einvoicingapi/02-submit-documents/), [FAQ](https://sdk.myinvois.hasil.gov.my/faq/) | No. This build treats KB as 1024 bytes (`300 * 1024`, `5 * 1024 * 1024`). A value equal to the limit is allowed. |
| Structural problems and hash mismatch return `400 BadStructure` for the whole submission (hash mismatch adds `innerError` `DocumentHashMismatch`). `rejectedDocuments` is present and empty on success. | [Submit Documents](https://sdk.myinvois.hasil.gov.my/einvoicingapi/02-submit-documents/) | No. Inferred. The live API may accept the submission (`202`) and place the bad document in `rejectedDocuments` instead of failing the batch. |
| Intermediary login with `onbehalfof` (`TIN` or `TIN:ROB`); the token acts for that taxpayer | [Login as Intermediary System](https://sdk.myinvois.hasil.gov.my/api/08-login-as-intermediary-system/) | No. The page does not say how an unauthorized `onbehalfof` fails. `403 IncorrectSubmitter` on API calls (default) or at login (`intermediaryDenial: token`) follows this product spec. `400` for `onbehalfof` from a non-intermediary client, exact-string matching of `TIN:ROB`, and filling `intermediaryRob` from the intermediary's BRN are local choices. |
| Supplier TIN different from the token tenant returns `403 IncorrectSubmitter` | [Submit Documents](https://sdk.myinvois.hasil.gov.my/einvoicingapi/02-submit-documents/) | No. The code `IncorrectSubmitter` is the one this spec names; the sandbox code was not confirmed. A document with no Invoice root is accepted and later marked `Invalid` instead of `403`, so tests can cancel an invalid document. |
| Identical raw body within 10 minutes returns `422 DuplicateSubmission` and `Retry-After`. The window includes the exact 10-minute mark. | [Submit Documents](https://sdk.myinvois.hasil.gov.my/einvoicingapi/02-submit-documents/) | No. Inclusive endpoint and `Retry-After` as delta-seconds are inferred. The hash is of the raw HTTP body. |
| `202` then asynchronous validation. `overallStatus` is `in progress` / `valid` / `partially valid` / `invalid`. `Valid` documents gain `longId` and `dateTimeValidated`. | [Get Submission](https://sdk.myinvois.hasil.gov.my/einvoicingapi/06-get-submission/) | No. Casing of `overallStatus` follows this spec (lowercase, spaces). Live responses may differ. Field name is `submissionUID`, as in this spec; some SDK samples use `submissionUid`. |
| `GET` submission honours `pageNo` (default 1) and `pageSize` (default 100, max 100) | [Get Submission](https://sdk.myinvois.hasil.gov.my/einvoicingapi/06-get-submission/) | No. Out-of-range `pageSize` returns 400. That limit is inferred. |
| `GET .../raw` and `GET .../details` with `validationResults` | [Get Document](https://sdk.myinvois.hasil.gov.my/einvoicingapi/07-get-document/), [Get Document Details](https://sdk.myinvois.hasil.gov.my/einvoicingapi/08-get-document-details/) | No. The raw body is a JSON wrapper containing the original text, not the bare document. The `07` path is the conventional SDK slug and was not re-fetched for this build. |
| Cancel is supplier-only, reject is buyer-only, `Valid` only, 72 hours from `dateTimeValidated` inclusive. Default codes `OperationPeriodOver` and `IncorrectState` (both HTTP 400). | [Cancel Document](https://sdk.myinvois.hasil.gov.my/einvoicingapi/03-cancel-document/), [Reject Document](https://sdk.myinvois.hasil.gov.my/einvoicingapi/04-reject-document/) | No. The code names and the 400 status are explicit inferences. Both are configurable. `reason` must be 1–300 characters. |
| `GET /api/v1.0/taxpayer/validate/{tin}?idType&idValue` → 400 / 200 empty / 404 | [Validate Taxpayer TIN](https://sdk.myinvois.hasil.gov.my/einvoicingapi/01-validate-taxpayer-tin/) | No |
| Standard error object fields, including `errorMS` and `innerError` | [Standard error response](https://sdk.myinvois.hasil.gov.my/standard-error-response/) | No. `errorMS` text is not copied from LHDN. |
| `correlationId` response header on every response | [Standard header parameters](https://sdk.myinvois.hasil.gov.my/standard-header-parameters/) | No. The header name is the one this spec requires. |
| Per-endpoint RPM, `429` `RateLimitExceeded`, `Retry-After`, `X-Rate-Limit-*` | [Integration practices](https://sdk.myinvois.hasil.gov.my/integration-practices/) | No. Window is a fixed 60 seconds on the emulator clock. Default RPM numbers follow that page, including 12 RPM for Get Recent Documents and Search Documents. |
| `GET /api/v1.0/documents/recent` last 31 days, `{ result, metadata }`, paging | [Get Recent Documents](https://sdk.myinvois.hasil.gov.my/einvoicingapi/05-get-recent-documents/) | No. 31-day window is on issued date (UBL `IssueDate`+`IssueTime`), falling back to `dateTimeReceived` when issue date is absent. The same fallback applies to `issueDateFrom`/`issueDateTo` on recent and search. `pageSize` max 100 is taken from Search Documents. `direction` / `InvoiceDirection` / `invoiceDirection` are accepted. |
| `GET /api/v1.0/documents/search` requires a submission or issue date pair, max 31-day span | [Search Documents](https://sdk.myinvois.hasil.gov.my/einvoicingapi/09-search-documents/) | No. Span is 31 days as that page states (the product spec mentioned 30 as an example). `searchQuery` character class is local. Date query params require a full ISO-8601 datetime with `Z` or an explicit offset. |
| Ids are 26 characters of `[A-Z0-9]` | Submit / get-submission samples on the SDK site | No. The generator is a seeded PRNG, not an LHDN id format proof. |
| Default validator only checks an Invoice root | Local. The SDK's real rules are much larger. | No. By design this is not the LHDN rule set. `--validator precheck` shells out to myinvois-precheck when you supply it. |

## Fixtures

`fixtures/samples/` holds unmodified public LHDN Invoice 1.0 and 1.1 JSON and XML samples. Provenance is in `fixtures/samples/SOURCE.md` (`https://sdk.myinvois.hasil.gov.my/`). Oversize payloads are built in tests and are not committed.

`fixtures/faults/` holds example fault-rule files for `--faults` and `POST /_emulator/faults`.

## Roadmap

Not in this increment:

- `--replay` of a `--record` JSONL file
- Platform APIs (`/api/v1.0/documenttypes`, notifications) and a read-only status page
- Structural checks for the v1.1 signature block (presence only, no cryptography)

## License

MIT. See `LICENSE`.

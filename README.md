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

Rate limits are on by default. Pass `--no-rate-limit` to disable them, or `--rpm-scale 0.5` to halve every per-endpoint RPM.

The process prints `myinvois-emulator listening on http://127.0.0.1:8787`.

Default client for the public samples (the supplier TIN in those files is the placeholder `Supplier's TIN`):

| | |
|---|---|
| client_id | `sample-supplier` |
| client_secret | `sample-supplier-secret` |
| scope | `InvoicingAPI` |

```bash
curl -s -X POST http://127.0.0.1:8787/connect/token \
  -H 'content-type: application/x-www-form-urlencoded' \
  -d 'grant_type=client_credentials&client_id=sample-supplier&client_secret=sample-supplier-secret&scope=InvoicingAPI'
```

With `--clock fake` (or `clock: 'fake'` in `createEmulator`), time does not move until you post to `/_emulator/clock/advance`. Validation therefore stays `in progress` until you advance at least `validationDelayMs` (default 2000). The default CLI clock is `real`: validation completes after two seconds of wall time, and the advance endpoint returns 400.

Library:

```js
import { createEmulator } from 'myinvois-emulator';

const emulator = createEmulator({
  seed: 42,
  clock: 'fake',
  rateLimit: { enabled: true, scale: 1 },
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
```

Node.js 20 or newer. Runtime dependencies: none (`node:http` only).

## Endpoints

| Method | Path | Auth | What it does |
|---|---|---|---|
| POST | `/connect/token` | no | `application/x-www-form-urlencoded` client credentials. Returns `access_token`, `token_type: Bearer`, `expires_in` (3600). |
| POST | `/api/v1.0/documentsubmissions/` | bearer | Submit `documents[]`. Trailing slash optional. `202` with `submissionUID`, `acceptedDocuments`, `rejectedDocuments`. |
| GET | `/api/v1.0/documentsubmissions/{uid}?pageNo&pageSize` | bearer | `overallStatus`: `in progress`, `valid`, `partially valid`, or `invalid`. |
| GET | `/api/v1.0/documents/{uuid}/raw` | bearer | Original document text and hash. |
| GET | `/api/v1.0/documents/{uuid}/details` | bearer | Status plus `validationResults`. |
| PUT | `/api/v1.0/documents/state/{uuid}/state` | bearer | `{ "status": "cancelled" \| "rejected", "reason": "..." }`. |
| GET | `/api/v1.0/taxpayer/validate/{tin}?idType&idValue` | bearer | `200` empty body, `400` if a query param is missing, `404` otherwise. |

Every response, including errors and the empty `200`, carries a `correlationId` header (26 characters, `[A-Z0-9]`). Limited API responses also carry `X-Rate-Limit-*` headers (see Rate limiting).

Document and submission ids are 26 characters from `[A-Z0-9]`, produced by a seeded PRNG. The same seed and the same sequence of token and submit calls yield the same ids.

### Submit rules

- Each item needs `format` (`JSON` or `XML`), `document` (standard base64), `documentHash` (SHA-256 hex of the decoded bytes, case-insensitive), and `codeNumber`.
- At most 100 documents, 300 KiB each (`300 * 1024` bytes), 5 MiB total (`5 * 1024 * 1024`). Over the limit: `400` `MaximumSizeExceeded`. A size equal to the limit is accepted.
- Malformed JSON, missing fields, bad base64, or a hash mismatch: `400` `BadStructure`. A hash mismatch also includes `innerError[].errorCode = DocumentHashMismatch`.
- When the document has an Invoice root and its supplier TIN is not the token tenant's TIN: `403` `IncorrectSubmitter`. TIN is read from UBL JSON (`AccountingSupplierParty` / `PartyIdentification` / `ID` with `schemeID` `TIN`) and from the same element in XML.
- The same raw body bytes accepted again within 10 minutes, including the exact 10-minute mark: `422` `DuplicateSubmission` and `Retry-After` (delta-seconds). At 10 minutes + 1ms the body is accepted again.
- Otherwise `202`. Documents stay `Submitted` until the validation delay elapses, then become `Valid` (with `longId` and `dateTimeValidated`) or `Invalid`.

`dateTimeValidated` is the moment the delay elapses (`receivedAt + validationDelayMs`), not the time of a later poll. A fake-clock jump past that moment does not move the 72-hour window forward.

`overallStatus` is `in progress` while any document is still `Submitted`, `valid` when every document passed validation, `invalid` when none did, and `partially valid` otherwise. Cancel and reject do not change it.

### Cancel and reject

Only a `Valid` document can be cancelled or rejected, and only while `now <= dateTimeValidated + 72h` (71:59:59 and 72:00:00 succeed; 72:00:01 returns `OperationPeriodOver`).

The supplier TIN on the document may cancel. The buyer TIN may reject. The other direction, or any other state (`Submitted`, `Invalid`, `Cancelled`, `Rejected`), returns `IncorrectState`. Wrong state wins over the window, so cancelling an `Invalid` document is `IncorrectState` even after 72 hours.

### Validator `none`

The only validator in this increment. A document becomes `Valid` when it is parseable JSON or XML and the root is `Invoice` (a namespace prefix is ignored). Anything else, including a credit note, becomes `Invalid` with `validationResults.validationSteps[].error.innerError[]`. XML that contains `<!DOCTYPE` or `<!ENTITY` is treated as not parseable.

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
| Validate TIN | `GET /api/v1.0/taxpayer/validate/{tin}` | 60 |

Search documents and get recent documents are not implemented. A reserved default of **12 RPM** would apply if those routes were added.

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

## Control endpoints

No bearer token. They are how tests move time without sleeping.

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/_emulator/clock/advance` | `{ "ms": 7200000 }` | Moves a fake clock forward by a non-negative integer number of milliseconds and settles due validations. `400` when the clock is real. |
| POST | `/_emulator/reset` | empty | Drops tokens, submissions, documents, the duplicate-body window, and rate-limit counters. Does not rewind the clock. |
| GET | `/_emulator/state` | | Submissions, documents (including the original text), `now`, clock mode, and seed. No client secrets. |
| GET | `/_emulator/health` | | `{ "status": "ok", "clock": "fake" \| "real", "now": "..." }`. |

## Config file

`--config emulator.json`. Unknown keys are ignored. A present `tenants` array **replaces** the built-in list. Omitted fields keep the defaults. See `fixtures/tenants.json`.

```json
{
  "validationDelayMs": 2000,
  "duplicateWindowMs": 600000,
  "cancelWindowMs": 259200000,
  "tokenTtlSeconds": 3600,
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

`Supplier's TIN` and `Buyer's TIN` are the placeholder strings in the public LHDN samples, so those files can be submitted unchanged. `EI00000000010` is the buyer TIN in the public consolidated samples. None of these are real taxpayers. Placeholder token parameters (`""`, `0`, anything starting with `YOUR_`, such as `YOUR_CLIENT_ID`) are rejected with `400` before the tenant table is consulted, so do not use them as a configured client id or secret.

Token lifetime is `tokenTtlSeconds` (default 3600). A token is expired when `now >= issuedAt + ttl`. `expires_in` in the token response is that same value in seconds. Advancing the fake clock past that lifetime expires tokens already issued; take a new one before a 72-hour cancel.

## Behaviour compared with the official docs

Nothing in this table has been checked against the live sandbox or preprod. The column stays **No** until someone records a real call. Several rows are inferences from the public SDK pages plus this product spec; those are called out.

| Behaviour | Official doc | Verified against real sandbox? |
|---|---|---|
| `POST /connect/token`, form body, `grant_type=client_credentials`, response `access_token` / `token_type` / `expires_in` 3600 | [Login as Taxpayer System](https://sdk.myinvois.hasil.gov.my/api/07-login-as-taxpayer-system/) | No |
| Missing or placeholder client parameters return 400. Only a Basic header, with no form body, returns 400. | [Login](https://sdk.myinvois.hasil.gov.my/api/07-login-as-taxpayer-system/), [FAQ](https://sdk.myinvois.hasil.gov.my/faq/) | No. 400 for a body-less Basic call is taken from field reports, not re-checked here. The placeholder list (`0`, `YOUR_*`, empty) is local. |
| Wrong client id or secret returns 403 `invalid_client`, wrapped in the standard error envelope | [FAQ](https://sdk.myinvois.hasil.gov.my/faq/) (403 Forbidden for a bad client id/secret) | No. The FAQ states 403. Using the standard `error` object, and the code `invalid_client`, is inferred. OAuth token endpoints often return a flatter body. |
| Missing or expired bearer on API routes returns 401 | [Login](https://sdk.myinvois.hasil.gov.my/api/07-login-as-taxpayer-system/) | No. Error code `Unauthorized` is local. |
| Submit limits: 100 documents, 5MB total, 300KB each. `400 MaximumSizeExceeded`. Hash is SHA-256 of the raw document; `document` is base64 of the same bytes. | [Submit Documents](https://sdk.myinvois.hasil.gov.my/einvoicingapi/02-submit-documents/), [FAQ](https://sdk.myinvois.hasil.gov.my/faq/) | No. This build treats KB as 1024 bytes (`300 * 1024`, `5 * 1024 * 1024`). A value equal to the limit is allowed. |
| Structural problems and hash mismatch return `400 BadStructure` for the whole submission (hash mismatch adds `innerError` `DocumentHashMismatch`). `rejectedDocuments` is present and empty on success. | [Submit Documents](https://sdk.myinvois.hasil.gov.my/einvoicingapi/02-submit-documents/) | No. Inferred. The live API may accept the submission (`202`) and place the bad document in `rejectedDocuments` instead of failing the batch. |
| Supplier TIN different from the token tenant returns `403 IncorrectSubmitter` | [Submit Documents](https://sdk.myinvois.hasil.gov.my/einvoicingapi/02-submit-documents/) | No. The code `IncorrectSubmitter` is the one this spec names; the sandbox code was not confirmed. A document with no Invoice root is accepted and later marked `Invalid` instead of `403`, so tests can cancel an invalid document. |
| Identical raw body within 10 minutes returns `422 DuplicateSubmission` and `Retry-After`. The window includes the exact 10-minute mark. | [Submit Documents](https://sdk.myinvois.hasil.gov.my/einvoicingapi/02-submit-documents/) | No. Inclusive endpoint and `Retry-After` as delta-seconds are inferred. The hash is of the raw HTTP body. |
| `202` then asynchronous validation. `overallStatus` is `in progress` / `valid` / `partially valid` / `invalid`. `Valid` documents gain `longId` and `dateTimeValidated`. | [Get Submission](https://sdk.myinvois.hasil.gov.my/einvoicingapi/06-get-submission/) | No. Casing of `overallStatus` follows this spec (lowercase, spaces). Live responses may differ. Field name is `submissionUID`, as in this spec; some SDK samples use `submissionUid`. |
| `GET` submission honours `pageNo` (default 1) and `pageSize` (default 100, max 100) | [Get Submission](https://sdk.myinvois.hasil.gov.my/einvoicingapi/06-get-submission/) | No. Out-of-range `pageSize` returns 400. That limit is inferred. |
| `GET .../raw` and `GET .../details` with `validationResults` | [Get Document](https://sdk.myinvois.hasil.gov.my/einvoicingapi/07-get-document/), [Get Document Details](https://sdk.myinvois.hasil.gov.my/einvoicingapi/08-get-document-details/) | No. The raw body is a JSON wrapper containing the original text, not the bare document. The `07` path is the conventional SDK slug and was not re-fetched for this build. |
| Cancel is supplier-only, reject is buyer-only, `Valid` only, 72 hours from `dateTimeValidated` inclusive. Default codes `OperationPeriodOver` and `IncorrectState` (both HTTP 400). | [Cancel Document](https://sdk.myinvois.hasil.gov.my/einvoicingapi/03-cancel-document/), [Reject Document](https://sdk.myinvois.hasil.gov.my/einvoicingapi/04-reject-document/) | No. The code names and the 400 status are explicit inferences. Both are configurable. `reason` must be 1–300 characters. |
| `GET /api/v1.0/taxpayer/validate/{tin}?idType&idValue` → 400 / 200 empty / 404 | [Validate Taxpayer TIN](https://sdk.myinvois.hasil.gov.my/einvoicingapi/01-validate-taxpayer-tin/) | No |
| Standard error object fields, including `errorMS` and `innerError` | [Standard error response](https://sdk.myinvois.hasil.gov.my/standard-error-response/) | No. `errorMS` text is not copied from LHDN. |
| `correlationId` response header on every response | [Standard header parameters](https://sdk.myinvois.hasil.gov.my/standard-header-parameters/) | No. The header name is the one this spec requires. |
| Per-endpoint RPM, `429` `RateLimitExceeded`, `Retry-After`, `X-Rate-Limit-*` | [Integration practices](https://sdk.myinvois.hasil.gov.my/integration-practices/) | No. Window is a fixed 60 seconds on the emulator clock. Default RPM numbers follow that page. Search/recent are not implemented; a reserved 12 RPM would apply. |
| Ids are 26 characters of `[A-Z0-9]` | Submit / get-submission samples on the SDK site | No. The generator is a seeded PRNG, not an LHDN id format proof. |
| Default validator only checks an Invoice root | Local. The SDK's real rules are much larger. | No. By design this is not the LHDN rule set. |

## Fixtures

`fixtures/samples/` holds unmodified public LHDN Invoice 1.0 and 1.1 JSON and XML samples. Provenance is in `fixtures/samples/SOURCE.md` (`https://sdk.myinvois.hasil.gov.my/`). Oversize payloads are built in tests and are not committed.

## Roadmap

Not in this increment:

- Fault injection (`--faults`, `POST /_emulator/faults`, reproducible 500 / latency / 429)
- Official Postman collection and newman contract tests
- `--validator precheck` (shell out to the myinvois-precheck CLI; not an npm dependency)
- Intermediary login and the `onbehalfof` header
- `GET /api/v1.0/documents/recent` and `/documents/search`
- Dockerfile
- `--record` / `--replay` JSONL
- Platform APIs (`/api/v1.0/documenttypes`, notifications) and a read-only status page
- Structural checks for the v1.1 signature block (presence only, no cryptography)

## License

MIT. See `LICENSE`.

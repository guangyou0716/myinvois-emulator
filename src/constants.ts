/** Decoded document limits from the MyInvois submit-documents API. */
export const DOC_MAX_COUNT = 100;
/** 300 KiB. The integration "301KB" case is 301 * 1024 bytes. */
export const DOC_MAX_BYTES = 300 * 1024;
/** 5 MiB, summed across decoded documents in one submission. */
export const SUBMISSION_MAX_BYTES = 5 * 1024 * 1024;

/** Identical request bodies are duplicates while this window has not fully elapsed. */
export const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
/** Cancel and reject are allowed through this duration after dateTimeValidated. */
export const CANCEL_WINDOW_MS = 72 * 60 * 60 * 1000;
/** Per-endpoint RPM window. Counts reset when the emulator clock leaves this window. */
export const RATE_LIMIT_WINDOW_MS = 60 * 1000;

export const DEFAULT_VALIDATION_DELAY_MS = 2000;
export const DEFAULT_TOKEN_TTL_SECONDS = 3600;
/** Scope granted when a token request omits `scope` (optional on the SDK login pages). */
export const DEFAULT_TOKEN_SCOPE = 'InvoicingAPI';
export const ID_LENGTH = 26;
export const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** Fixed origin for FakeClock so a seed replay does not depend on the wall clock. */
export const FAKE_CLOCK_START_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

export const MAX_BODY_BYTES = 16 * 1024 * 1024;
export const MAX_REASON_LENGTH = 300;
export const MAX_PAGE_SIZE = 100;
/** Default and maximum page size for Get Recent Documents and Search Documents. */
export const QUERY_PAGE_SIZE_DEFAULT = 100;
/**
 * Recent documents cover the last 31 days on the emulator clock (issued date,
 * falling back to dateTimeReceived). Search date-range pairs may span at most
 * 31 days. From LHDN Get Recent Documents and Search Documents pages.
 */
export const QUERY_WINDOW_DAYS = 31;
export const QUERY_WINDOW_MS = QUERY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
/** Cap on matching documents returned by recent/search before paging. */
export const MAX_QUERY_RESULTS = 10_000;

/** Default wall-clock timeout for a precheck child process. */
export const DEFAULT_PRECHECK_TIMEOUT_MS = 10_000;
/** Kill a precheck child if stdout exceeds this many bytes. */
export const PRECHECK_MAX_STDOUT_BYTES = 4 * 1024 * 1024;
/** Cap concurrent precheck children; further runs wait in a queue. */
export const PRECHECK_CONCURRENCY = 4;

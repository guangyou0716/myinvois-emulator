import {
  CANCEL_WINDOW_MS,
  DEFAULT_TOKEN_TTL_SECONDS,
  DEFAULT_VALIDATION_DELAY_MS,
  DUPLICATE_WINDOW_MS,
} from './constants.js';
import type { EmulatorConfig, ErrorCodeMap, StatusCodeMap, TenantConfig } from './config.js';

export const DEFAULT_ERROR_CODES: ErrorCodeMap = {
  operationPeriodOver: 'OperationPeriodOver',
  incorrectState: 'IncorrectState',
  invalidClient: 'invalid_client',
  badStructure: 'BadStructure',
  maximumSizeExceeded: 'MaximumSizeExceeded',
  incorrectSubmitter: 'IncorrectSubmitter',
  duplicateSubmission: 'DuplicateSubmission',
  unauthorized: 'Unauthorized',
  notFound: 'NotFound',
  invalidRequest: 'invalid_request',
};

export const DEFAULT_STATUS_CODES: StatusCodeMap = {
  invalidClient: 403,
  missingParameters: 400,
  badStructure: 400,
  maximumSizeExceeded: 400,
  incorrectSubmitter: 403,
  duplicateSubmission: 422,
  unauthorized: 401,
  notFound: 404,
  incorrectState: 400,
  operationPeriodOver: 400,
};

/**
 * Built-in tenants. `Supplier's TIN` and `Buyer's TIN` are the placeholder
 * strings in the public LHDN samples, so those files submit without edits.
 * Every other TIN is synthetic.
 */
export const DEFAULT_TENANTS: readonly TenantConfig[] = [
  {
    tin: "Supplier's TIN",
    name: 'LHDN public sample supplier',
    role: 'supplier',
    clientId: 'sample-supplier',
    clientSecret: 'sample-supplier-secret',
    idType: 'BRN',
    idValue: "Supplier's BRN",
  },
  {
    tin: "Buyer's TIN",
    name: 'LHDN public sample buyer',
    role: 'buyer',
    clientId: 'sample-buyer',
    clientSecret: 'sample-buyer-secret',
    idType: 'BRN',
    idValue: "Buyer's BRN",
  },
  {
    tin: 'C00000000000',
    name: 'Fake Supplier A Sdn Bhd',
    role: 'supplier',
    clientId: 'supplier-a',
    clientSecret: 'supplier-a-secret',
    idType: 'BRN',
    idValue: '201901000001',
  },
  {
    tin: 'C00000000001',
    name: 'Fake Supplier B Sdn Bhd',
    role: 'supplier',
    clientId: 'supplier-b',
    clientSecret: 'supplier-b-secret',
    idType: 'BRN',
    idValue: '201901000002',
  },
  {
    tin: 'IG00000000000',
    name: 'Fake Buyer',
    role: 'buyer',
    clientId: 'buyer-a',
    clientSecret: 'buyer-a-secret',
    idType: 'NRIC',
    idValue: '900101015555',
  },
  {
    tin: 'EI00000000010',
    name: 'Fake consolidated buyer',
    role: 'buyer',
    clientId: 'buyer-general',
    clientSecret: 'buyer-general-secret',
    idType: 'BRN',
    idValue: 'NA',
  },
  {
    tin: 'EI00000000020',
    name: 'Fake Intermediary',
    role: 'intermediary',
    clientId: 'intermediary-a',
    clientSecret: 'intermediary-a-secret',
    idType: 'BRN',
    idValue: '202101000001',
  },
];

export function defaultConfig(): EmulatorConfig {
  return {
    validationDelayMs: DEFAULT_VALIDATION_DELAY_MS,
    duplicateWindowMs: DUPLICATE_WINDOW_MS,
    cancelWindowMs: CANCEL_WINDOW_MS,
    tokenTtlSeconds: DEFAULT_TOKEN_TTL_SECONDS,
    errorCodes: { ...DEFAULT_ERROR_CODES },
    statusCodes: { ...DEFAULT_STATUS_CODES },
    tenants: DEFAULT_TENANTS.map((tenant) => ({ ...tenant })),
  };
}

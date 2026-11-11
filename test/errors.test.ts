import { describe, expect, it } from 'vitest';
import {
  errorBody,
  invalidDocumentError,
  precheckFailedError,
  precheckFindingsError,
  standardError,
} from '../src/errors.js';

describe('standard error envelope', () => {
  it('always includes errorMS and the documented fields', () => {
    const body = errorBody(
      standardError({
        errorCode: 'BadStructure',
        error: 'broken',
        errorMS: 'rosak',
      }),
    );
    expect(Object.keys(body.error).sort()).toEqual([
      'error',
      'errorCode',
      'errorMS',
      'innerError',
      'propertyName',
      'propertyPath',
      'target',
    ]);
    expect(body.error.errorMS).toBe('rosak');
    expect(body.error.innerError).toBeNull();
  });

  it('gives invalid documents an innerError array', () => {
    const error = invalidDocumentError();
    expect(error.errorCode).toBe('ValidationError');
    expect(error.innerError).toHaveLength(1);
    expect(error.innerError?.[0]?.errorCode).toBe('InvalidStructure');
    expect(error.innerError?.[0]?.errorMS.length).toBeGreaterThan(0);
  });

  it('wraps precheck failures and findings in the invalid-document envelope', () => {
    const failed = precheckFailedError('precheck timed out');
    expect(failed.errorCode).toBe('ValidationError');
    expect(failed.innerError?.[0]).toMatchObject({ errorCode: 'PrecheckFailed', error: 'precheck timed out' });

    const findings = precheckFindingsError([
      { rule: 'math.line-total-excl', message: 'line total does not match', path: 'Invoice[0].InvoiceLine[0]' },
    ]);
    expect(findings.innerError?.[0]).toMatchObject({
      errorCode: 'math.line-total-excl',
      error: 'line total does not match',
      propertyPath: 'Invoice[0].InvoiceLine[0]',
      target: 'math.line-total-excl',
    });
  });
});

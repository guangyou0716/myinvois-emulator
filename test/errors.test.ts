import { describe, expect, it } from 'vitest';
import { errorBody, invalidDocumentError, standardError } from '../src/errors.js';

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
});

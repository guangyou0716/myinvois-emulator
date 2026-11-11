export interface StandardError {
  propertyName: string | null;
  propertyPath: string | null;
  errorCode: string;
  error: string;
  errorMS: string;
  target: string | null;
  innerError: StandardError[] | null;
}

export function standardError(fields: {
  propertyName?: string | null;
  propertyPath?: string | null;
  errorCode: string;
  error: string;
  errorMS: string;
  target?: string | null;
  innerError?: StandardError[] | null;
}): StandardError {
  return {
    propertyName: fields.propertyName ?? null,
    propertyPath: fields.propertyPath ?? null,
    errorCode: fields.errorCode,
    error: fields.error,
    errorMS: fields.errorMS,
    target: fields.target ?? null,
    innerError: fields.innerError === undefined ? null : fields.innerError,
  };
}

export function errorBody(error: StandardError): { error: StandardError } {
  return { error };
}

export function invalidDocumentError(): StandardError {
  const inner = standardError({
    propertyName: 'Invoice',
    propertyPath: 'Invoice',
    errorCode: 'InvalidStructure',
    error: 'Document is not parseable JSON or XML with an Invoice root',
    errorMS: 'Dokumen bukan JSON atau XML yang sah dengan akar Invoice',
    target: 'Invoice',
    innerError: null,
  });
  return standardError({
    propertyName: null,
    propertyPath: null,
    errorCode: 'ValidationError',
    error: 'Document failed structural validation',
    errorMS: 'Dokumen gagal pengesahan struktur',
    target: 'Document',
    innerError: [inner],
  });
}

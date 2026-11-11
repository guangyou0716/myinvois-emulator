import { DOC_MAX_BYTES, DOC_MAX_COUNT, SUBMISSION_MAX_BYTES } from './constants.js';

export type LimitViolation =
  | { kind: 'count'; count: number; limit: number }
  | { kind: 'document'; index: number; bytes: number; limit: number }
  | { kind: 'total'; bytes: number; limit: number };

export interface SubmissionLimits {
  maxCount: number;
  maxDocumentBytes: number;
  maxSubmissionBytes: number;
}

export const DEFAULT_LIMITS: SubmissionLimits = {
  maxCount: DOC_MAX_COUNT,
  maxDocumentBytes: DOC_MAX_BYTES,
  maxSubmissionBytes: SUBMISSION_MAX_BYTES,
};

/**
 * Count is checked first, then each document, then the submission total.
 * A size equal to the limit is allowed. One byte or one document over is not.
 */
export function checkLimits(
  byteLengths: readonly number[],
  limits: SubmissionLimits = DEFAULT_LIMITS,
): LimitViolation | null {
  if (byteLengths.length > limits.maxCount) {
    return { kind: 'count', count: byteLengths.length, limit: limits.maxCount };
  }
  let total = 0;
  for (let index = 0; index < byteLengths.length; index += 1) {
    const bytes = byteLengths[index] ?? 0;
    if (bytes > limits.maxDocumentBytes) {
      return { kind: 'document', index, bytes, limit: limits.maxDocumentBytes };
    }
    total += bytes;
  }
  if (total > limits.maxSubmissionBytes) {
    return { kind: 'total', bytes: total, limit: limits.maxSubmissionBytes };
  }
  return null;
}

export function limitMessage(violation: LimitViolation): { error: string; errorMS: string; propertyPath: string } {
  if (violation.kind === 'count') {
    return {
      error: `Submission contains ${violation.count} documents; the maximum is ${violation.limit}`,
      errorMS: `Penyerahan mengandungi ${violation.count} dokumen; had ialah ${violation.limit}`,
      propertyPath: 'documents',
    };
  }
  if (violation.kind === 'document') {
    return {
      error: `Document ${violation.index} is ${violation.bytes} bytes; the maximum is ${violation.limit}`,
      errorMS: `Dokumen ${violation.index} bersaiz ${violation.bytes} bait; had ialah ${violation.limit}`,
      propertyPath: `documents[${violation.index}]`,
    };
  }
  return {
    error: `Submission is ${violation.bytes} bytes; the maximum is ${violation.limit}`,
    errorMS: `Penyerahan bersaiz ${violation.bytes} bait; had ialah ${violation.limit}`,
    propertyPath: 'documents',
  };
}

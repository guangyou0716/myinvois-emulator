import { describe, expect, it } from 'vitest';
import { DOC_MAX_BYTES, DOC_MAX_COUNT, SUBMISSION_MAX_BYTES } from '../src/constants.js';
import { checkLimits } from '../src/limits.js';

function exactSubmissionBytes(): number[] {
  const lengths = Array.from({ length: 17 }, () => DOC_MAX_BYTES);
  lengths.push(SUBMISSION_MAX_BYTES - 17 * DOC_MAX_BYTES);
  return lengths;
}

describe('submission size and count limits', () => {
  it('allows 100 documents and rejects 101', () => {
    expect(checkLimits(Array.from({ length: DOC_MAX_COUNT }, () => 1))).toBeNull();
    expect(checkLimits(Array.from({ length: DOC_MAX_COUNT + 1 }, () => 1))).toEqual({
      kind: 'count',
      count: 101,
      limit: 100,
    });
  });

  it('allows 300KB and rejects 300KB + 1 byte', () => {
    expect(checkLimits([DOC_MAX_BYTES])).toBeNull();
    expect(checkLimits([DOC_MAX_BYTES - 1])).toBeNull();
    expect(checkLimits([DOC_MAX_BYTES + 1])).toEqual({
      kind: 'document',
      index: 0,
      bytes: DOC_MAX_BYTES + 1,
      limit: DOC_MAX_BYTES,
    });
  });

  it('allows exactly 5MB and rejects 5MB + 1 byte', () => {
    const exact = exactSubmissionBytes();
    expect(exact.reduce((sum, size) => sum + size, 0)).toBe(SUBMISSION_MAX_BYTES);
    expect(Math.max(...exact)).toBeLessThanOrEqual(DOC_MAX_BYTES);
    expect(checkLimits(exact)).toBeNull();
    const over = [...exact];
    over[over.length - 1] = (over[over.length - 1] ?? 0) + 1;
    expect(checkLimits(over)).toEqual({
      kind: 'total',
      bytes: SUBMISSION_MAX_BYTES + 1,
      limit: SUBMISSION_MAX_BYTES,
    });
  });
});

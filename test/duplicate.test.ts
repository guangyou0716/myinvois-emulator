import { describe, expect, it } from 'vitest';
import { DUPLICATE_WINDOW_MS } from '../src/constants.js';
import { duplicateDecision } from '../src/duplicate.js';

const MINUTE = 60 * 1000;
const SECOND = 1000;

describe('duplicate submission window', () => {
  const acceptedAt = 1_700_000_000_000;

  it('treats 9:59 as inside the 10 minute window', () => {
    const decision = duplicateDecision(acceptedAt + 9 * MINUTE + 59 * SECOND, acceptedAt);
    expect(decision.duplicate).toBe(true);
    expect(decision.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('treats the exact 10 minute mark as still inside', () => {
    const decision = duplicateDecision(acceptedAt + DUPLICATE_WINDOW_MS, acceptedAt);
    expect(decision.duplicate).toBe(true);
    expect(decision.retryAfterSeconds).toBe(1);
  });

  it('treats 10:01 as outside the window', () => {
    const decision = duplicateDecision(acceptedAt + 10 * MINUTE + SECOND, acceptedAt);
    expect(decision.duplicate).toBe(false);
    expect(decision.retryAfterSeconds).toBe(0);
  });
});

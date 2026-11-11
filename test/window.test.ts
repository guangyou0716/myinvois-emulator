import { describe, expect, it } from 'vitest';
import { CANCEL_WINDOW_MS } from '../src/constants.js';
import { isInsideCancelWindow } from '../src/window.js';

function offset(hours: number, minutes: number, seconds: number): number {
  return ((hours * 60 + minutes) * 60 + seconds) * 1000;
}

describe('72 hour cancel and reject window', () => {
  const validatedAt = 1_700_000_000_000;

  it('allows 71:59:59 and the exact 72:00:00 mark', () => {
    expect(isInsideCancelWindow(validatedAt + offset(71, 59, 59), validatedAt)).toBe(true);
    expect(isInsideCancelWindow(validatedAt + CANCEL_WINDOW_MS, validatedAt)).toBe(true);
    expect(offset(72, 0, 0)).toBe(CANCEL_WINDOW_MS);
  });

  it('rejects 72:00:01', () => {
    expect(isInsideCancelWindow(validatedAt + offset(72, 0, 1), validatedAt)).toBe(false);
  });
});

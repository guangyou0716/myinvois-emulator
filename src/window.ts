import { CANCEL_WINDOW_MS, DUPLICATE_WINDOW_MS } from './constants.js';

/**
 * Cancel/reject is allowed when `now` is within `windowMs` of `validatedAt`,
 * including the exact endpoint (72:00:00.000 is still allowed; 72:00:01 is not).
 */
export function isInsideCancelWindow(
  now: number,
  validatedAt: number,
  windowMs: number = CANCEL_WINDOW_MS,
): boolean {
  return now - validatedAt <= windowMs;
}

export { CANCEL_WINDOW_MS, DUPLICATE_WINDOW_MS };

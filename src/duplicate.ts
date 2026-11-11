import { DUPLICATE_WINDOW_MS } from './constants.js';

export interface DuplicateDecision {
  duplicate: boolean;
  /** Seconds for the Retry-After header. Zero when the body is not a duplicate. */
  retryAfterSeconds: number;
}

/**
 * A body is a duplicate when it arrives at or before `acceptedAt + windowMs`
 * ("within 10 minutes", inclusive of the exact 10-minute mark).
 * 9:59 is inside. 10:01 is outside.
 */
export function duplicateDecision(
  now: number,
  acceptedAt: number,
  windowMs: number = DUPLICATE_WINDOW_MS,
): DuplicateDecision {
  const expiresAt = acceptedAt + windowMs;
  if (now <= expiresAt) {
    const retryAfterSeconds = Math.max(1, Math.ceil((expiresAt + 1 - now) / 1000));
    return { duplicate: true, retryAfterSeconds };
  }
  return { duplicate: false, retryAfterSeconds: 0 };
}

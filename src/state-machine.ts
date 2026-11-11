import { isInsideCancelWindow } from './window.js';

export type DocumentStatus = 'Submitted' | 'Valid' | 'Invalid' | 'Cancelled' | 'Rejected';
export type OverallStatus = 'in progress' | 'valid' | 'partially valid' | 'invalid';
export type DocumentAction = 'cancel' | 'reject';

export interface TransitionCodes {
  operationPeriodOver: string;
  incorrectState: string;
}

export interface TransitionInput {
  status: DocumentStatus;
  validatedAt: number | null;
  now: number;
  action: DocumentAction;
  actorIsSupplier: boolean;
  actorIsBuyer: boolean;
  windowMs: number;
  codes: TransitionCodes;
}

export type TransitionResult =
  | { ok: true; status: 'Cancelled' | 'Rejected' }
  | { ok: false; errorCode: string };

/**
 * Cancel is supplier-only. Reject is buyer-only. Both require a Valid document
 * still inside the operation window. Wrong status or wrong party wins over the
 * window, so an Invalid document returns IncorrectState even after 72 hours.
 */
export function decideTransition(input: TransitionInput): TransitionResult {
  const actorAllowed = input.action === 'cancel' ? input.actorIsSupplier : input.actorIsBuyer;
  if (input.status !== 'Valid' || input.validatedAt === null || !actorAllowed) {
    return { ok: false, errorCode: input.codes.incorrectState };
  }
  if (!isInsideCancelWindow(input.now, input.validatedAt, input.windowMs)) {
    return { ok: false, errorCode: input.codes.operationPeriodOver };
  }
  return { ok: true, status: input.action === 'cancel' ? 'Cancelled' : 'Rejected' };
}

export function overallStatus(validation: readonly (boolean | null)[]): OverallStatus {
  if (validation.length === 0) return 'invalid';
  if (validation.some((entry) => entry === null)) return 'in progress';
  const validCount = validation.filter((entry) => entry === true).length;
  if (validCount === validation.length) return 'valid';
  if (validCount === 0) return 'invalid';
  return 'partially valid';
}

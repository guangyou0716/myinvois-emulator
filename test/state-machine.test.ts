import { describe, expect, it } from 'vitest';
import { CANCEL_WINDOW_MS } from '../src/constants.js';
import { decideTransition, overallStatus, type TransitionInput } from '../src/state-machine.js';

const codes = { operationPeriodOver: 'OperationPeriodOver', incorrectState: 'IncorrectState' };

function input(overrides: Partial<TransitionInput> = {}): TransitionInput {
  return {
    status: 'Valid',
    validatedAt: 1_000,
    now: 1_000,
    action: 'cancel',
    actorIsSupplier: true,
    actorIsBuyer: false,
    windowMs: CANCEL_WINDOW_MS,
    codes,
    ...overrides,
  };
}

describe('document state machine', () => {
  it('lets the supplier cancel and the buyer reject a Valid document inside the window', () => {
    expect(decideTransition(input()).ok).toBe(true);
    expect(decideTransition(input({ action: 'reject', actorIsSupplier: false, actorIsBuyer: true }))).toEqual({
      ok: true,
      status: 'Rejected',
    });
  });

  it('refuses a buyer cancel and a supplier reject', () => {
    expect(decideTransition(input({ actorIsSupplier: false, actorIsBuyer: true })).ok).toBe(false);
    expect(
      decideTransition(input({ action: 'reject', actorIsSupplier: true, actorIsBuyer: false })),
    ).toMatchObject({ ok: false, errorCode: 'IncorrectState' });
  });

  it('refuses cancel of Submitted, Invalid, Cancelled, and Rejected documents', () => {
    for (const status of ['Submitted', 'Invalid', 'Cancelled', 'Rejected'] as const) {
      const result = decideTransition(input({ status, validatedAt: status === 'Invalid' ? null : 1_000 }));
      expect(result).toMatchObject({ ok: false, errorCode: 'IncorrectState' });
    }
  });

  it('uses the 72 hour boundaries', () => {
    const validatedAt = 5_000;
    const at = (ms: number) => input({ validatedAt, now: validatedAt + ms });
    const inside = (71 * 60 * 60 + 59 * 60 + 59) * 1000;
    expect(decideTransition(at(inside))).toMatchObject({ ok: true, status: 'Cancelled' });
    expect(decideTransition(at(CANCEL_WINDOW_MS))).toMatchObject({ ok: true, status: 'Cancelled' });
    expect(decideTransition(at(CANCEL_WINDOW_MS + 1000))).toMatchObject({
      ok: false,
      errorCode: 'OperationPeriodOver',
    });
  });

  it('prefers IncorrectState over the window when the document is not Valid', () => {
    const result = decideTransition(
      input({ status: 'Invalid', validatedAt: null, now: 1_000 + CANCEL_WINDOW_MS + 1000 }),
    );
    expect(result).toMatchObject({ ok: false, errorCode: 'IncorrectState' });
  });

  it('reports overall status from validation outcomes', () => {
    expect(overallStatus([null, true])).toBe('in progress');
    expect(overallStatus([true, true])).toBe('valid');
    expect(overallStatus([true, false])).toBe('partially valid');
    expect(overallStatus([false, false])).toBe('invalid');
  });
});

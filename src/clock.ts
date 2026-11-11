export interface Clock {
  now(): number;
}

export interface AdjustableClock extends Clock {
  advance(ms: number): void;
}

export function isAdjustableClock(clock: Clock): clock is AdjustableClock {
  return typeof (clock as AdjustableClock).advance === 'function';
}

export class RealClock implements Clock {
  now(): number {
    return Date.now();
  }
}

export class FakeClock implements AdjustableClock {
  private current: number;

  constructor(startMs: number = Date.UTC(2026, 0, 1, 0, 0, 0)) {
    if (!Number.isInteger(startMs)) {
      throw new Error('FakeClock start must be an integer number of milliseconds');
    }
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    if (!Number.isInteger(ms) || ms < 0) {
      throw new Error('advance(ms) requires a non-negative integer');
    }
    this.current += ms;
  }
}

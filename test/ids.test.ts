import { describe, expect, it } from 'vitest';
import { ID_ALPHABET, ID_LENGTH } from '../src/constants.js';
import { createIdGenerator } from '../src/ids.js';

describe('id generator', () => {
  it('emits 26 characters from [A-Z0-9]', () => {
    const next = createIdGenerator(42);
    for (let i = 0; i < 20; i += 1) {
      const id = next();
      expect(id).toHaveLength(ID_LENGTH);
      expect(id).toMatch(/^[A-Z0-9]+$/);
      for (const char of id) expect(ID_ALPHABET.includes(char)).toBe(true);
    }
  });

  it('is deterministic for a seed and advances the sequence', () => {
    const first = createIdGenerator(42);
    const sequence = [first(), first(), first()];
    const second = createIdGenerator(42);
    expect([second(), second(), second()]).toEqual(sequence);
    expect(new Set(sequence).size).toBe(3);
  });

  it('changes the sequence when the seed changes', () => {
    expect(createIdGenerator(42)()).not.toBe(createIdGenerator(43)());
  });

  it('mixes both 32-bit halves so seeds 2^32 apart differ', () => {
    const low = createIdGenerator(1)();
    const high = createIdGenerator(1 + 2 ** 32)();
    expect(high).not.toBe(low);
    expect(createIdGenerator(1 + 2 ** 32)()).toBe(high);
  });

  it('accepts a zero seed', () => {
    expect(createIdGenerator(0)()).toMatch(/^[A-Z0-9]{26}$/);
  });
});

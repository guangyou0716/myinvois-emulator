import { ID_ALPHABET, ID_LENGTH } from './constants.js';

/**
 * Mix a safe-integer seed into a nonzero uint32. `seed >>> 0` keeps only the
 * low 32 bits, so seeds that differ by 2^32 would share a sequence. The high
 * half is folded in first. When that half is zero, seeds that already fit in
 * uint32 keep their previous sequence.
 */
function mixSeed(seed: number): number {
  const low = seed >>> 0;
  const high = Math.trunc(seed / 2 ** 32) >>> 0;
  let x = (low ^ Math.imul(high ^ (high >>> 16), 0x7feb352d)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  x = (x ^ (x >>> 16)) >>> 0;
  return x === 0 ? 0x6d2b79f5 : x;
}

export function createIdGenerator(seed: number): () => string {
  if (!Number.isInteger(seed)) {
    throw new Error('seed must be an integer');
  }
  let state = mixSeed(seed);
  return () => {
    let out = '';
    for (let i = 0; i < ID_LENGTH; i += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      out += ID_ALPHABET[state % ID_ALPHABET.length];
    }
    return out;
  };
}

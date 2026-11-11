import { ID_ALPHABET, ID_LENGTH } from './constants.js';

/**
 * mulberry32-style step. The same seed always yields the same sequence of
 * 26-character `[A-Z0-9]` ids.
 */
function mixSeed(seed: number): number {
  let x = seed >>> 0;
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

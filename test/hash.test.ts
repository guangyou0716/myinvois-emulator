import { describe, expect, it } from 'vitest';
import { decodeBase64, hashesEqual, sha256Hex } from '../src/hash.js';

describe('sha256 document hash', () => {
  it('matches the known SHA-256 of abc', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('accepts the same digest in either case and rejects a mismatch', () => {
    const digest = sha256Hex(Buffer.from('invoice', 'utf8'));
    expect(hashesEqual(digest, digest.toUpperCase())).toBe(true);
    expect(hashesEqual(digest, `${digest.slice(0, -1)}0`)).toBe(false);
    expect(hashesEqual(digest, '')).toBe(false);
  });

  it('decodes standard base64 and rejects a truncated payload', () => {
    const bytes = Buffer.from('{"Invoice":[{}]}', 'utf8');
    const encoded = bytes.toString('base64');
    expect(decodeBase64(encoded)?.equals(bytes)).toBe(true);
    expect(decodeBase64(encoded.slice(0, -1))).toBeNull();
    expect(decodeBase64('not base64')).toBeNull();
  });
});

import { createHash, timingSafeEqual } from 'node:crypto';

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Case-insensitive compare of two SHA-256 hex digests. */
export function hashesEqual(expectedHex: string, provided: string): boolean {
  const left = Buffer.from(expectedHex.trim().toLowerCase());
  const right = Buffer.from(provided.trim().toLowerCase());
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

export function decodeBase64(input: string): Buffer | null {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return null;
  const decoded = Buffer.from(trimmed, 'base64');
  if (decoded.toString('base64') !== trimmed) return null;
  return decoded;
}

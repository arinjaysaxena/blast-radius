// Subresource-integrity style verification of downloaded tarballs.
import { createHash, timingSafeEqual } from 'node:crypto';

const STRENGTH = ['sha512', 'sha384', 'sha256', 'sha1'] as const;
type Algorithm = (typeof STRENGTH)[number];

export class IntegrityError extends Error {
  constructor(
    message: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(message);
    this.name = 'IntegrityError';
  }
}

interface Hash {
  algorithm: Algorithm;
  digest: Buffer;
}

/** Parse an SRI string (`sha512-<base64> sha1-<base64>`) and return the strongest supported hash. */
export function parseIntegrity(sri: string): Hash | undefined {
  const found = new Map<Algorithm, Buffer>();
  for (const part of sri.trim().split(/\s+/)) {
    const dash = part.indexOf('-');
    if (dash <= 0) continue;
    const algorithm = part.slice(0, dash).toLowerCase();
    const encoded = part.slice(dash + 1).split('?')[0] ?? '';
    const known = STRENGTH.find((a) => a === algorithm);
    if (known && encoded) found.set(known, Buffer.from(encoded, 'base64'));
  }
  for (const algorithm of STRENGTH) {
    const digest = found.get(algorithm);
    if (digest) return { algorithm, digest };
  }
  return undefined;
}

/** Compute an SRI string (`sha512-...`) for the data. */
export function computeIntegrity(data: Uint8Array, algorithm: Algorithm = 'sha512'): string {
  return `${algorithm}-${createHash(algorithm).update(data).digest('base64')}`;
}

/**
 * Verify `data` against the registry's `integrity` field, falling back to the legacy sha1 `shasum`.
 * Throws `IntegrityError` on mismatch, and also when the registry supplied nothing to verify against.
 * Returns the SRI string that was verified.
 */
export function verifyIntegrity(data: Uint8Array, integrity: string | undefined, shasum?: string): string {
  const parsed = integrity ? parseIntegrity(integrity) : undefined;
  if (parsed) {
    const actual = createHash(parsed.algorithm).update(data).digest();
    if (actual.length !== parsed.digest.length || !timingSafeEqual(actual, parsed.digest)) {
      throw new IntegrityError(
        `integrity check failed (${parsed.algorithm}): the downloaded tarball does not match the registry metadata`,
        `${parsed.algorithm}-${parsed.digest.toString('base64')}`,
        `${parsed.algorithm}-${actual.toString('base64')}`,
      );
    }
    return `${parsed.algorithm}-${parsed.digest.toString('base64')}`;
  }
  if (shasum) {
    const actual = createHash('sha1').update(data).digest('hex');
    if (actual !== shasum.toLowerCase()) {
      throw new IntegrityError('integrity check failed (sha1 shasum mismatch)', shasum, actual);
    }
    return computeIntegrity(data, 'sha1');
  }
  throw new IntegrityError('the registry supplied no integrity or shasum for this tarball', '', '');
}

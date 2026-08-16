import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** Hash a UTF-8 string and return full hex digest. */
export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/**
 * Derive a deterministic UUID-shaped identifier from a digest string.
 * Non-hex characters (e.g. an injected `sha256:` prefix) are stripped before
 * slicing; short inputs are zero-padded. `version` selects the UUID version
 * nibble so different identifier families stay distinguishable.
 */
export function digestToId(digest: string, version: 4 | 5): string {
  const hex = digest
    .toLowerCase()
    .replaceAll(/[^a-f0-9]/g, '')
    .padEnd(32, '0')
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${version}${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

/**
 * Hash a UTF-8 string and return the first `length` hex characters.
 *
 * Byte-identical to `hashText(text).slice(0, length)` — the canonical form for
 * truncated digests (fingerprints, short evidence tokens). Use this instead of
 * inlining `createHash('sha256')...slice(0, n)`.
 */
export function hashTextShort(text: string, length: number): string {
  return hashText(text).slice(0, length);
}

/**
 * Hash raw bytes (binary-safe) and return full hex digest.
 *
 * Use for `Buffer` content (e.g. file bytes, archive payloads) where forcing a
 * UTF-8 encoding via {@link hashText} would be incorrect. Byte-identical to
 * `createHash('sha256').update(buffer).digest('hex')`.
 */
export function hashBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Hash a file (binary-safe) and return full hex digest. Streams for memory efficiency. */
export function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk: Buffer) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

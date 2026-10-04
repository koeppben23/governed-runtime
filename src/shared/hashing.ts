/**
 * @module shared/hashing
 * @description The single generic hash-primitive authority.
 *
 * Every SHA-2 digest in production code routes through this module: single-shot
 * text ({@link hashText}), single-shot bytes ({@link hashBuffer}), files
 * ({@link hashFile}), unambiguous multi-part input ({@link hashParts}), and raw
 * digest bytes for wire formats ({@link hashDigestBytes}). No other production
 * module may import `node:crypto`'s `createHash` (enforced by
 * `architecture/__tests__/digest-authority-ssot.test.ts`; the one sanctioned
 * SHA-1 exception is the RFC 4122 UUIDv5 claim-id derivation in
 * `state/proofgraph-approval.ts`, owned by `proofgraph-claim-id-ssot`).
 *
 * Canonical JSON serialization is a separate authority:
 * `shared/canonical-json.ts`. Structured digest inputs MUST be canonicalized
 * there before they reach a hash primitive here.
 *
 * @version v2
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** SHA-2 digest algorithms admissible as raw cryptographic digests. */
export type Sha2Algorithm = 'sha256' | 'sha384' | 'sha512';

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

/**
 * Hash an ordered list of byte parts with unambiguous length-prefix framing.
 *
 * Framing is `<utf8ByteLength>:<bytes>` per part, so the part boundary is
 * explicit: `['ab', 'c']` and `['a', 'bc']` hash differently. Domain digest
 * formulas that combine multiple inputs MUST use this primitive instead of
 * concatenating or joining parts locally.
 */
export function hashParts(parts: readonly (string | Buffer)[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    const bytes = typeof part === 'string' ? Buffer.from(part, 'utf-8') : part;
    hash.update(`${bytes.byteLength}:`);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

/**
 * Raw digest bytes (never hex-encoded) for the allowlisted SHA-2 family.
 *
 * Use where the digest bytes themselves are the wire contract (RFC 3161
 * message imprints). Callers that need a persisted hex digest use
 * {@link hashText} / {@link hashBuffer} instead.
 */
export function hashDigestBytes(algorithm: Sha2Algorithm, content: string | Buffer): Buffer {
  // Node hashes strings as UTF-8 by default and ignores the encoding argument
  // for buffers, so the union input needs no encoding branch.
  return createHash(algorithm).update(content).digest();
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

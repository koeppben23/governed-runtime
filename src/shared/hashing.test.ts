import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { hashText, hashTextShort, hashBuffer, hashFile, digestToId } from './hashing.js';

/**
 * @module shared/hashing.test
 * @description Canonical SHA-256 hashing authority. These tests pin the
 * byte-level behaviour AND prove the new helpers are byte-identical to the
 * inline `createHash('sha256')` forms they replace across the codebase. The
 * equivalence tests are the safety basis for consolidating ~30 inline call
 * sites onto this module without changing any persisted digest.
 */

describe('hashText', () => {
  it('is deterministic and returns a full 64-char hex digest', () => {
    expect(hashText('hello')).toBe(hashText('hello'));
    expect(hashText('hello')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('distinguishes different inputs', () => {
    expect(hashText('hello')).not.toBe(hashText('world'));
  });

  it('pins a known vector (SHA-256 of "")', () => {
    expect(hashText('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('equals the inline createHash(...).update(x, "utf-8").digest("hex") form', () => {
    for (const s of ['', 'a', 'governance', '日本語', '{"k":1}', 'line\n']) {
      const inline = createHash('sha256').update(s, 'utf-8').digest('hex');
      expect(hashText(s)).toBe(inline);
    }
  });

  it('equals the inline form WITHOUT an explicit encoding arg (Node defaults to utf-8)', () => {
    // Several call sites used `.update(str)` with no encoding; Node defaults to
    // utf-8 for strings, so hashText (which passes 'utf-8' explicitly) must match.
    for (const s of ['', 'discovery', '{"a":[1,2]}', 'ünïcöde']) {
      const inlineNoEncoding = createHash('sha256').update(s).digest('hex');
      expect(hashText(s)).toBe(inlineNoEncoding);
    }
  });
});

describe('hashTextShort', () => {
  it('returns the first N hex chars of the full digest', () => {
    expect(hashTextShort('hello', 8)).toBe(hashText('hello').slice(0, 8));
    expect(hashTextShort('hello', 16)).toHaveLength(16);
  });

  it('is byte-identical to the inline createHash(...).digest("hex").slice(0, n) form', () => {
    const cases: Array<[string, number]> = [
      ['repo:https://example.com/x.git', 16],
      ['reviewCard-content', 16],
      ['issuer-value', 8],
      ['redaction-value', 12],
      ['{"refs":["a","b"]}', 16],
    ];
    for (const [s, n] of cases) {
      const inline = createHash('sha256').update(s, 'utf-8').digest('hex').slice(0, n);
      expect(hashTextShort(s, n)).toBe(inline);
    }
  });
});

describe('hashBuffer', () => {
  it('is deterministic and returns a full 64-char hex digest', () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    expect(hashBuffer(buf)).toBe(hashBuffer(Buffer.from([0x00, 0x01, 0x02, 0xff])));
    expect(hashBuffer(buf)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is byte-identical to the inline createHash(...).update(buffer).digest("hex") form', () => {
    const buffers = [
      Buffer.from([]),
      Buffer.from('text-bytes', 'utf-8'),
      Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x7f]),
    ];
    for (const buf of buffers) {
      const inline = createHash('sha256').update(buf).digest('hex');
      expect(hashBuffer(buf)).toBe(inline);
    }
  });

  it('matches hashText for a UTF-8 buffer of the same string content', () => {
    // A Buffer built from a utf-8 string must hash identically to hashText(str).
    const s = 'governance-evidence';
    expect(hashBuffer(Buffer.from(s, 'utf-8'))).toBe(hashText(s));
  });
});

describe('digestToId', () => {
  // A digest whose first 32 hex chars are unambiguous under any case handling.
  const DIGEST = '0123456789abcdef0123456789abcdef' + 'f'.repeat(32);

  it('derives a deterministic UUID-shaped identifier from the digest prefix', () => {
    expect(digestToId(DIGEST, 4)).toBe('01234567-89ab-4def-8123-456789abcdef');
    expect(digestToId(DIGEST, 5)).toBe('01234567-89ab-5def-8123-456789abcdef');
  });

  it('normalizes case before slicing', () => {
    expect(digestToId(DIGEST.toUpperCase(), 4)).toBe(digestToId(DIGEST, 4));
  });

  it('strips every non-hex character, including an algorithm prefix', () => {
    // 'sha256:' contributes only its hex characters (a,2,5,6) after stripping.
    expect(digestToId(`sha256:${DIGEST}`, 4)).toBe('a2560123-4567-49ab-8def-0123456789ab');
  });

  it('zero-pads short digests instead of producing a truncated id', () => {
    const id = digestToId('abc', 4);
    expect(id).toHaveLength(36);
    expect(id.startsWith('abc00000-')).toBe(true);
    expect(id).toBe('abc00000-0000-4000-8000-000000000000');
  });
});

describe('hashFile', () => {
  it('hashes file bytes identically to hashBuffer', async () => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'fg-hash-file-'));
    try {
      const filePath = join(dir, 'payload.bin');
      const bytes = Buffer.from([0x00, 0xff, 0x10, 0x41, 0x42]);
      await writeFile(filePath, bytes);

      await expect(hashFile(filePath)).resolves.toBe(hashBuffer(bytes));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects for a missing file instead of hanging', async () => {
    await expect(hashFile('/nonexistent/flowguard-hash-file.bin')).rejects.toThrow();
  });
});

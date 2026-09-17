/**
 * @module architecture/proofgraph-claim-id-ssot
 * @description Enforce that ProofGraph claim identity has a single minting
 * authority.
 *
 * Scope is deliberately the ProofGraph claim-id namespace (UUIDv5 seeded by
 * identity domain + authority section + normalized statement) — NOT every
 * UUIDv5 or identifier helper in the repository. Other identifier families
 * remain free to exist.
 *
 * Guard invariants:
 *   A. The ProofGraph claim namespace constant appears only in
 *      `state/proofgraph-approval.ts`.
 *   B. No other module implements claim-id UUIDv5 minting (SHA-1 digest plus
 *      UUID version/variant shaping in a module that names claim ids).
 *   C. Known claim-id producers import the authority instead of deriving ids.
 *
 * The negative fixtures prove each detector fires on the removed duplicate
 * (`claimIdFor`, statement-only minting) and does not flag unrelated
 * identifier/UUIDv5 helpers.
 *
 * @version v1
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';

const SRC = resolve(join(import.meta.dirname, '..', '..'));

/** The single minting authority for ProofGraph claim identities. */
const CLAIM_ID_AUTHORITY = 'state/proofgraph-approval.ts';

/** Modules that mint claim ids and must therefore consume the authority. */
const CLAIM_ID_PRODUCERS = ['integration/tools/declare-contract.ts'];

/** RFC 4122 DNS namespace reserved for ProofGraph claim identities. */
const CLAIM_NAMESPACE_HEX = '6ba7b8109dad11d180b400c04fd430c8';

/** Import specifier every integration-layer claim producer uses. */
const AUTHORITY_IMPORT = "from '../../state/proofgraph-approval.js'";

// ─── File collection ─────────────────────────────────────────────────────────

function collectSourceFiles(): string[] {
  const files: string[] = [];
  const stack: string[] = [SRC];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const entries = readdirSafe(dir);
    for (const entry of entries) {
      const full = join(dir, entry);
      if (entry.includes('__') || entry.includes('node_modules')) continue;
      if (isDir(full)) {
        stack.push(full);
      } else if (entry.endsWith('.ts')) {
        files.push(full);
      }
    }
  }
  return files;
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ─── Detectors ───────────────────────────────────────────────────────────────

/** The reserved ProofGraph claim namespace must not be re-declared elsewhere. */
function containsClaimNamespace(content: string): boolean {
  return content.includes(CLAIM_NAMESPACE_HEX);
}

const SHA1_HASH = /createHash\(\s*['"]sha1['"]\s*\)/;
const UUID_VERSION_NIBBLE = /hash\[\s*6\s*\]\s*=/;
const UUID_VARIANT_BITS = /hash\[\s*8\s*\]\s*=/;

/**
 * Detect a local ProofGraph claim-id mint: a SHA-1 digest shaped into a UUIDv5
 * in a module that names claim ids. The authority itself matches by design and
 * is excluded by path at the call site — the detector must never be weakened
 * to accommodate it.
 */
function hasLocalClaimIdMint(content: string): boolean {
  if (containsClaimNamespace(content)) return true;
  return (
    SHA1_HASH.test(content) &&
    UUID_VERSION_NIBBLE.test(content) &&
    UUID_VARIANT_BITS.test(content) &&
    /claimId/i.test(content)
  );
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ProofGraph claim-id SSOT', () => {
  const files = collectSourceFiles().map((abs) => ({
    rel: relative(SRC, abs).split(sep).join('/'),
    content: readFileSync(abs, 'utf-8'),
  }));

  it('defines the claim namespace only in the identity authority', () => {
    const offenders = files
      .filter((f) => f.rel !== CLAIM_ID_AUTHORITY && containsClaimNamespace(f.content))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('implements claim-id minting only in the identity authority', () => {
    const offenders = files
      .filter((f) => f.rel !== CLAIM_ID_AUTHORITY && hasLocalClaimIdMint(f.content))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('known claim-id producers consume the authority', () => {
    for (const producer of CLAIM_ID_PRODUCERS) {
      const file = files.find((f) => f.rel === producer);
      expect(file, `${producer} must exist`).toBeTruthy();
      expect(file!.content, `${producer} must import the identity authority`).toContain(
        AUTHORITY_IMPORT,
      );
      expect(file!.content, `${producer} must call mintProofGraphClaimId`).toContain(
        'mintProofGraphClaimId',
      );
    }
  });

  it('exposes the canonical identity contract from the authority', () => {
    const authority = files.find((f) => f.rel === CLAIM_ID_AUTHORITY);
    expect(authority, `${CLAIM_ID_AUTHORITY} must exist`).toBeTruthy();
    for (const symbol of [
      'mintProofGraphClaimId',
      'ProofGraphClaimDomain',
      'MANUAL_CLAIM_SCOPE',
      'normalizeClaimStatement',
    ]) {
      expect(authority!.content, `authority must expose ${symbol}`).toContain(symbol);
    }
  });

  // ─── Negative fixtures ─────────────────────────────────────────────────────

  describe('negative fixtures — prove the detectors fire', () => {
    /** The removed duplicate: statement-only SHA-1/UUIDv5 minting. */
    const OLD_STATEMENT_ONLY_MINT = `
      function claimIdFor(statement) {
        const hash = crypto.createHash('sha1').update(NAMESPACE).update(statement, 'utf8').digest();
        hash[6] = (hash[6] & 0x0f) | 0x50;
        hash[8] = (hash[8] & 0x3f) | 0x80;
        return formatClaimId(hash);
      }
    `;

    /** An unrelated UUIDv5-shaped identifier helper without claim semantics. */
    const UNRELATED_UUIDV5 = `
      function idFor(seed) {
        const hash = crypto.createHash('sha1').update(seed).digest();
        hash[6] = (hash[6] & 0x0f) | 0x50;
        hash[8] = (hash[8] & 0x3f) | 0x80;
        return format(hash);
      }
    `;

    it('detects the removed statement-only duplicate mint', () => {
      expect(hasLocalClaimIdMint(OLD_STATEMENT_ONLY_MINT)).toBe(true);
    });

    it('detects a re-declared claim namespace', () => {
      expect(containsClaimNamespace(`Buffer.from('${CLAIM_NAMESPACE_HEX}', 'hex')`)).toBe(true);
    });

    it('detects the authority mint itself (path exclusion, not detector weakness)', () => {
      const authority = files.find((f) => f.rel === CLAIM_ID_AUTHORITY);
      expect(hasLocalClaimIdMint(authority!.content)).toBe(true);
    });

    it('does not flag unrelated identifier helpers', () => {
      expect(hasLocalClaimIdMint(UNRELATED_UUIDV5)).toBe(false);
      expect(hasLocalClaimIdMint('const id = crypto.randomUUID();')).toBe(false);
      expect(hasLocalClaimIdMint('const id = digestToId(digest, 5);')).toBe(false);
      expect(containsClaimNamespace("Buffer.from('deadbeef', 'hex')")).toBe(false);
    });
  });
});

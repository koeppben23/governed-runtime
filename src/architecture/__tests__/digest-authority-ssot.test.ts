/**
 * @module architecture/digest-authority-ssot
 * @description Default-deny guard for the hash-primitive authority.
 *
 * Exactly one generic hash authority exists: `shared/hashing.ts` (single-shot
 * text/bytes, files, length-framed multi-part input, raw SHA-2 digest bytes).
 * Domain digest formulas may choose which fields and framing they bind, but
 * they must route SHA-2 through that authority and must serialize structured
 * input with `shared/canonical-json.ts` first.
 *
 * Invariants:
 *   D1 `createHash` may be CALLED only in `shared/hashing.ts` or an explicitly
 *      sanctioned, reasoned exception.
 *   D2 A hash primitive must never consume a raw `JSON.stringify(...)`
 *      (structured digest inputs are canonicalized first). The detector targets
 *      direct hash-input nesting (including `.update(JSON.stringify(...))`);
 *      ordinary JSON output is not flagged. Indirect laundering through an
 *      intermediate variable is out of detector scope and remains a review
 *      obligation.
 *   D3 `canonicalJsonStringify` definitions are owned by
 *      `canonical-json-ssot.test.ts`; this guard refuses to run without it.
 *   D4 No production module outside the authority may even REFERENCE the
 *      `createHash` identifier, so a new local primitive cannot be introduced
 *      without this guard failing (the identifier is the escape hatch, not just
 *      the call).
 *   D5 The scan is default-wide over production `.ts` files under `src/`.
 *   D6 There is no directory allowlist: the only exclusions are test sources
 *      under the repository's semantic test classification.
 *   D7 Negative fixtures prove every detector, including the sanctioned
 *      exception path and the canonical-input non-flag.
 *
 * @version v1
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isTestSourcePath } from './module-classification.js';

const SRC_ROOT = join(process.cwd(), 'src');

/** The sole module permitted to reference `createHash`. */
const HASHING_AUTHORITY = 'shared/hashing.ts';

/** Safeguard owner for the canonical JSON definition SSOT (invariant D3). */
const CANONICAL_JSON_GUARD = 'architecture/__tests__/canonical-json-ssot.test.ts';

/** Every primitive exported by the hash authority. */
const HASH_PRIMITIVES = [
  'hashText',
  'hashTextShort',
  'hashBuffer',
  'hashFile',
  'hashParts',
  'hashDigestBytes',
] as const;

interface SanctionedException {
  readonly rel: string;
  /** Algorithm the exception is allowed to use; any other call is a violation. */
  readonly algorithm: 'sha1';
  readonly reason: string;
  /** Guard that owns the semantics of this exception. */
  readonly governingGuard: string;
}

/**
 * The only production exceptions to the SHA-2 authority. Each entry must be
 * real (the file must contain its declared primitive) or the guard fails.
 */
const SANCTIONED_CREATE_HASH: readonly SanctionedException[] = [
  {
    rel: 'state/proofgraph-approval.ts',
    algorithm: 'sha1',
    reason:
      'RFC 4122 UUIDv5 name-based ProofGraph claim-id derivation — SHA-1 is the RFC-defined primitive, not an integrity digest',
    governingGuard: 'architecture/__tests__/proofgraph-claim-id-ssot.test.ts',
  },
];

const SHA256_FAMILY_CALL = /createHash\s*\(\s*['"](?:sha256|sha384|sha512)['"]\s*\)/;

interface SourceFile {
  readonly rel: string;
  readonly content: string;
}

interface Violation {
  readonly rel: string;
  readonly line: number;
  readonly snippet: string;
  readonly rule: string;
}

function createHashReference(): RegExp {
  return /\bcreateHash\b/g;
}

function rawJsonHashInput(): RegExp {
  return new RegExp(
    `(?:\\b(?:${HASH_PRIMITIVES.join('|')})\\b|\\.update)\\s*\\(\\s*JSON\\.stringify\\s*\\(`,
    'g',
  );
}

/** Default-wide production scan (D5/D6): semantic test classification only. */
function collectProductionFiles(dir: string, acc: SourceFile[] = []): SourceFile[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectProductionFiles(full, acc);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const rel = relative(SRC_ROOT, full).split(sep).join('/');
    if (isTestSourcePath(rel)) continue;
    acc.push({ rel, content: readFileSync(full, 'utf8') });
  }
  return acc;
}

function lineAt(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

function findMatches(f: SourceFile, pattern: RegExp, rule: string): Violation[] {
  const out: Violation[] = [];
  for (const match of f.content.matchAll(pattern)) {
    out.push({
      rel: f.rel,
      line: lineAt(f.content, match.index ?? 0),
      snippet: match[0].replace(/\s+/g, ' ').trim(),
      rule,
    });
  }
  return out;
}

function sanctionedFor(rel: string): SanctionedException | undefined {
  return SANCTIONED_CREATE_HASH.find((entry) => entry.rel === rel);
}

function findCreateHashViolations(files: readonly SourceFile[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.rel === HASHING_AUTHORITY) continue;
    if (sanctionedFor(f.rel) !== undefined) continue;
    out.push(...findMatches(f, createHashReference(), 'createHash-outside-authority'));
  }
  return out;
}

function findRawJsonHashViolations(files: readonly SourceFile[]): Violation[] {
  return files.flatMap((f) =>
    findMatches(f, rawJsonHashInput(), 'hash-input-over-raw-json-stringify'),
  );
}

const productionFiles = collectProductionFiles(SRC_ROOT);

describe('digest authority SSOT (default-deny)', () => {
  it('D1/D4: createHash is referenced only in the hashing authority or a sanctioned exception', () => {
    const violations = findCreateHashViolations(productionFiles);
    if (violations.length > 0) {
      console.error('Digest authority violations:', violations);
    }
    expect(violations).toEqual([]);
  });

  it('D2: no hash primitive consumes a raw JSON.stringify', () => {
    const violations = findRawJsonHashViolations(productionFiles);
    if (violations.length > 0) {
      console.error('Raw-JSON hash-input violations:', violations);
    }
    expect(violations).toEqual([]);
  });

  it('D1: every sanctioned exception is real and stays on its declared algorithm', () => {
    for (const entry of SANCTIONED_CREATE_HASH) {
      const file = productionFiles.find((f) => f.rel === entry.rel);
      expect(file, `${entry.rel} must exist`).toBeTruthy();
      expect(file!.content, `${entry.rel} must contain createHash('${entry.algorithm}')`).toContain(
        `createHash('${entry.algorithm}')`,
      );
      expect(file!.content, `${entry.rel} must not use a SHA-2 family primitive`).not.toMatch(
        SHA256_FAMILY_CALL,
      );
      expect(existsSync(join(SRC_ROOT, entry.governingGuard)), entry.governingGuard).toBe(true);
      expect(entry.reason.trim().length).toBeGreaterThan(0);
    }
  });

  it('D3: the canonical-JSON definition SSOT guard is present and owns serialization definitions', () => {
    expect(existsSync(join(SRC_ROOT, CANONICAL_JSON_GUARD))).toBe(true);
  });

  it('D5/D6: the production scan is default-wide and finds the authority plus the sanctioned file', () => {
    const rels = productionFiles.map((f) => f.rel);
    expect(rels).toContain(HASHING_AUTHORITY);
    expect(rels).toContain('state/proofgraph-approval.ts');
    // A governed module far from shared/ is scanned — no directory allowlist.
    expect(rels.some((rel) => rel.startsWith('integration/'))).toBe(true);
    expect(rels.some((rel) => rel.startsWith('archive/'))).toBe(true);
    // Test sources are excluded by semantic classification, not path substring.
    expect(rels).not.toContain('architecture/__tests__/digest-authority-ssot.test.ts');
    expect(rels).not.toContain('shared/hashing.test.ts');
  });

  describe('negative fixtures — prove every detector', () => {
    it('fires on a new local createHash call', () => {
      const fixture: SourceFile[] = [
        {
          rel: 'archive/rogue.ts',
          content: "const h = createHash('sha256').update(value).digest('hex');",
        },
      ];
      const violations = findCreateHashViolations(fixture);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.rule).toBe('createHash-outside-authority');
    });

    it('fires on a createHash reference even without a call', () => {
      const fixture: SourceFile[] = [
        { rel: 'archive/rogue.ts', content: "import { createHash } from 'node:crypto';" },
      ];
      expect(findCreateHashViolations(fixture)).toHaveLength(1);
    });

    it('does NOT fire in the hashing authority', () => {
      const fixture: SourceFile[] = [
        {
          rel: HASHING_AUTHORITY,
          content: "const h = createHash('sha256').update(value).digest('hex');",
        },
      ];
      expect(findCreateHashViolations(fixture)).toEqual([]);
    });

    it('does NOT fire in the sanctioned UUIDv5 exception file', () => {
      const fixture: SourceFile[] = [
        {
          rel: 'state/proofgraph-approval.ts',
          content: "const h = crypto.createHash('sha1').update(seed).digest();",
        },
      ];
      expect(findCreateHashViolations(fixture)).toEqual([]);
    });

    it('fires on hashText(JSON.stringify(...))', () => {
      const fixture: SourceFile[] = [
        { rel: 'audit/rogue.ts', content: 'hashText(JSON.stringify(structuredValue));' },
      ];
      const violations = findRawJsonHashViolations(fixture);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.rule).toBe('hash-input-over-raw-json-stringify');
    });

    it('fires on a multi-line hashBuffer(JSON.stringify(...))', () => {
      const fixture: SourceFile[] = [
        {
          rel: 'state/rogue.ts',
          content: 'hashBuffer(\n  JSON.stringify(value),\n);',
        },
      ];
      expect(findRawJsonHashViolations(fixture)).toHaveLength(1);
    });

    it('fires on .update(JSON.stringify(...))', () => {
      const fixture: SourceFile[] = [
        {
          rel: 'audit/rogue.ts',
          content: "createHash('sha256').update(JSON.stringify(event));",
        },
      ];
      expect(findRawJsonHashViolations(fixture)).toHaveLength(1);
    });

    it('does NOT fire on hashText(canonicalJsonStringify(...))', () => {
      const fixture: SourceFile[] = [
        { rel: 'audit/good.ts', content: 'hashText(canonicalJsonStringify(structuredValue));' },
      ];
      expect(findRawJsonHashViolations(fixture)).toEqual([]);
    });

    it('does NOT fire on ordinary JSON output that is not a hash input', () => {
      const fixture: SourceFile[] = [
        {
          rel: 'adapters/persistence-audit.ts',
          content: 'await writeFile(path, JSON.stringify(event) + "\\n");',
        },
      ];
      expect(findRawJsonHashViolations(fixture)).toEqual([]);
    });
  });
});

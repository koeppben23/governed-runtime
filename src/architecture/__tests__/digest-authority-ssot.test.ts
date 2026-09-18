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
 *      sanctioned, reasoned exception. A sanctioned exception is NOT a
 *      file-level exemption: the `createHash` identifier must appear exactly
 *      `expectedCalls` times (so a function alias such as
 *      `const factory = crypto.createHash` is caught), only the declared
 *      literal algorithm is admissible, and every direct call is inspected.
 *      A dynamic algorithm argument never passes.
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
 *   D5 The scan is default-wide over production `.ts` files under `src/`,
 *      collected through the single production-source scanner
 *      (`production-source.ts`), which uses the semantic test classification
 *      authority.
 *   D6 There is no directory allowlist: the only exclusions are test sources
 *      under the repository's semantic test classification.
 *   D7 Negative fixtures prove every detector, including wrong-algorithm,
 *      dynamic-algorithm, count-mismatch, and the canonical-input non-flag.
 *
 * @version v2
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { collectProductionSources, type ProductionSourceFile } from './production-source.js';

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
  /** Exact number of `createHash` calls the exception may contain. */
  readonly expectedCalls: number;
  readonly reason: string;
  /** Guard that owns the semantics of this exception. */
  readonly governingGuard: string;
}

/**
 * The only production exceptions to the SHA-2 authority. Each entry must be
 * real: the file must exist and contain exactly `expectedCalls` calls, every
 * one of them with the declared literal algorithm.
 */
const SANCTIONED_CREATE_HASH: readonly SanctionedException[] = [
  {
    rel: 'state/proofgraph-approval.ts',
    algorithm: 'sha1',
    expectedCalls: 1,
    reason:
      'RFC 4122 UUIDv5 name-based ProofGraph claim-id derivation — SHA-1 is the RFC-defined primitive, not an integrity digest',
    governingGuard: 'architecture/__tests__/proofgraph-claim-id-ssot.test.ts',
  },
];

interface CreateHashCall {
  readonly raw: string;
  /** First argument expression, trimmed (the algorithm position). */
  readonly algorithmArgument: string;
  readonly line: number;
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

function createHashCall(): RegExp {
  return /\bcreateHash\s*\(([^)]*)\)/g;
}

function rawJsonHashInput(): RegExp {
  return new RegExp(
    `(?:\\b(?:${HASH_PRIMITIVES.join('|')})\\b|\\.update)\\s*\\(\\s*JSON\\.stringify\\s*\\(`,
    'g',
  );
}

function lineAt(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

function findMatches(f: ProductionSourceFile, pattern: RegExp, rule: string): Violation[] {
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

/** Every `createHash(...)` call with its first (algorithm) argument verbatim. */
function findCreateHashCalls(f: ProductionSourceFile): CreateHashCall[] {
  const out: CreateHashCall[] = [];
  for (const match of f.content.matchAll(createHashCall())) {
    const args = match[1] ?? '';
    out.push({
      raw: match[0].replace(/\s+/g, ' ').trim(),
      algorithmArgument: (args.split(',')[0] ?? '').trim(),
      line: lineAt(f.content, match.index ?? 0),
    });
  }
  return out;
}

function isSanctionedCall(call: CreateHashCall, entry: SanctionedException): boolean {
  return (
    call.algorithmArgument === `'${entry.algorithm}'` ||
    call.algorithmArgument === `"${entry.algorithm}"`
  );
}

function sanctionedFor(rel: string): SanctionedException | undefined {
  return SANCTIONED_CREATE_HASH.find((entry) => entry.rel === rel);
}

/**
 * Sanctioned-file rules. The exception is reference-exact and call-exact, not
 * a file-level exemption: the identifier must appear exactly `expectedCalls`
 * times (so a function alias such as `const factory = crypto.createHash` is
 * caught) and every direct call must use the declared literal algorithm
 * (`createHash(algo)`, `createHash('md5')`, `createHash('sha256')` all remain
 * violations).
 */
function findSanctionedViolations(files: readonly ProductionSourceFile[]): Violation[] {
  const out: Violation[] = [];
  for (const entry of SANCTIONED_CREATE_HASH) {
    const file = files.find((f) => f.rel === entry.rel);
    if (file === undefined) {
      out.push({
        rel: entry.rel,
        line: 1,
        snippet: 'sanctioned file is missing',
        rule: 'sanctioned-file-missing',
      });
      continue;
    }
    const references = [...file.content.matchAll(createHashReference())];
    if (references.length !== entry.expectedCalls) {
      const offending = references[entry.expectedCalls] ?? references[0];
      out.push({
        rel: file.rel,
        line: offending === undefined ? 1 : lineAt(file.content, offending.index ?? 0),
        snippet: `${references.length} createHash reference(s), expected ${entry.expectedCalls}`,
        rule: 'sanctioned-createHash-reference-count',
      });
    }
    for (const call of findCreateHashCalls(file)) {
      if (isSanctionedCall(call, entry)) continue;
      out.push({
        rel: file.rel,
        line: call.line,
        snippet: call.raw,
        rule: 'sanctioned-createHash-wrong-algorithm',
      });
    }
  }
  return out;
}

function findCreateHashViolations(files: readonly ProductionSourceFile[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.rel === HASHING_AUTHORITY || sanctionedFor(f.rel) !== undefined) continue;
    // Identifier-level rule (D4): an import/reference alone is a violation.
    out.push(...findMatches(f, createHashReference(), 'createHash-outside-authority'));
  }
  return out;
}

function findRawJsonHashViolations(files: readonly ProductionSourceFile[]): Violation[] {
  return files.flatMap((f) =>
    findMatches(f, rawJsonHashInput(), 'hash-input-over-raw-json-stringify'),
  );
}

const productionFiles = collectProductionSources(SRC_ROOT);

describe('digest authority SSOT (default-deny)', () => {
  it('D1/D4: createHash is referenced only in the hashing authority or an exactly sanctioned call', () => {
    const violations = [
      ...findCreateHashViolations(productionFiles),
      ...findSanctionedViolations(productionFiles),
    ];
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

  it('D1: every sanctioned exception declaration is real and governed', () => {
    for (const entry of SANCTIONED_CREATE_HASH) {
      expect(existsSync(join(SRC_ROOT, entry.governingGuard)), entry.governingGuard).toBe(true);
      expect(entry.reason.trim().length).toBeGreaterThan(0);
      const file = productionFiles.find((f) => f.rel === entry.rel);
      expect(file, `${entry.rel} must exist`).toBeTruthy();
      expect(findCreateHashCalls(file!).length).toBe(entry.expectedCalls);
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
      const fixture: ProductionSourceFile[] = [
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
      const fixture: ProductionSourceFile[] = [
        { rel: 'archive/rogue.ts', content: "import { createHash } from 'node:crypto';" },
      ];
      expect(findCreateHashViolations(fixture)).toHaveLength(1);
    });

    it('does NOT fire in the hashing authority', () => {
      const fixture: ProductionSourceFile[] = [
        {
          rel: HASHING_AUTHORITY,
          content: "const h = createHash('sha256').update(value).digest('hex');",
        },
      ];
      expect(findCreateHashViolations(fixture)).toEqual([]);
    });

    it('does NOT fire on the sanctioned UUIDv5 SHA-1 call', () => {
      const fixture: ProductionSourceFile[] = [
        {
          rel: 'state/proofgraph-approval.ts',
          content: "const h = crypto.createHash('sha1').update(seed).digest();",
        },
      ];
      expect(findSanctionedViolations(fixture)).toEqual([]);
    });

    it('fires on a SHA-256 call inside the sanctioned file', () => {
      const fixture: ProductionSourceFile[] = [
        {
          rel: 'state/proofgraph-approval.ts',
          content: "const h = crypto.createHash('sha256').update(seed).digest();",
        },
      ];
      const violations = findSanctionedViolations(fixture);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.rule).toBe('sanctioned-createHash-wrong-algorithm');
    });

    it('fires on an MD5 call inside the sanctioned file', () => {
      const fixture: ProductionSourceFile[] = [
        {
          rel: 'state/proofgraph-approval.ts',
          content: "const h = crypto.createHash('md5').update(seed).digest();",
        },
      ];
      const violations = findSanctionedViolations(fixture);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.rule).toBe('sanctioned-createHash-wrong-algorithm');
    });

    it('fires on a dynamic algorithm argument inside the sanctioned file', () => {
      const fixture: ProductionSourceFile[] = [
        {
          rel: 'state/proofgraph-approval.ts',
          content: 'const h = crypto.createHash(algorithm).update(seed).digest();',
        },
      ];
      const violations = findSanctionedViolations(fixture);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.rule).toBe('sanctioned-createHash-wrong-algorithm');
    });

    it('fires on a wrong-algorithm call next to the sanctioned SHA-1 call', () => {
      const fixture: ProductionSourceFile[] = [
        {
          rel: 'state/proofgraph-approval.ts',
          content: [
            "const allowed = crypto.createHash('sha1').update(seed).digest();",
            "const rogue = crypto.createHash('sha256').update(seed).digest();",
          ].join('\n'),
        },
      ];
      const rules = findSanctionedViolations(fixture)
        .map((violation) => violation.rule)
        .sort();
      expect(rules).toEqual([
        'sanctioned-createHash-reference-count',
        'sanctioned-createHash-wrong-algorithm',
      ]);
    });

    it('fires on a second sanctioned-looking call (references are exact)', () => {
      const fixture: ProductionSourceFile[] = [
        {
          rel: 'state/proofgraph-approval.ts',
          content: [
            "const first = crypto.createHash('sha1').update(seed).digest();",
            "const second = crypto.createHash('sha1').update(other).digest();",
          ].join('\n'),
        },
      ];
      const violations = findSanctionedViolations(fixture);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.rule).toBe('sanctioned-createHash-reference-count');
    });

    it('fires on a createHash function alias inside the sanctioned file', () => {
      const fixture: ProductionSourceFile[] = [
        {
          rel: 'state/proofgraph-approval.ts',
          content: [
            "const allowed = crypto.createHash('sha1').update(seed).digest();",
            'const hashFactory = crypto.createHash;',
            "const rogue = hashFactory('sha256').update(value).digest();",
          ].join('\n'),
        },
      ];
      const violations = findSanctionedViolations(fixture);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.rule).toBe('sanctioned-createHash-reference-count');
    });

    it('fires when the sanctioned file is missing entirely', () => {
      const violations = findSanctionedViolations([]);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.rule).toBe('sanctioned-file-missing');
    });

    it('fires on hashText(JSON.stringify(...))', () => {
      const fixture: ProductionSourceFile[] = [
        { rel: 'audit/rogue.ts', content: 'hashText(JSON.stringify(structuredValue));' },
      ];
      const violations = findRawJsonHashViolations(fixture);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.rule).toBe('hash-input-over-raw-json-stringify');
    });

    it('fires on a multi-line hashBuffer(JSON.stringify(...))', () => {
      const fixture: ProductionSourceFile[] = [
        {
          rel: 'state/rogue.ts',
          content: 'hashBuffer(\n  JSON.stringify(value),\n);',
        },
      ];
      expect(findRawJsonHashViolations(fixture)).toHaveLength(1);
    });

    it('fires on .update(JSON.stringify(...))', () => {
      const fixture: ProductionSourceFile[] = [
        {
          rel: 'audit/rogue.ts',
          content: "createHash('sha256').update(JSON.stringify(event));",
        },
      ];
      expect(findRawJsonHashViolations(fixture)).toHaveLength(1);
    });

    it('does NOT fire on hashText(canonicalJsonStringify(...))', () => {
      const fixture: ProductionSourceFile[] = [
        { rel: 'audit/good.ts', content: 'hashText(canonicalJsonStringify(structuredValue));' },
      ];
      expect(findRawJsonHashViolations(fixture)).toEqual([]);
    });

    it('does NOT fire on ordinary JSON output that is not a hash input', () => {
      const fixture: ProductionSourceFile[] = [
        {
          rel: 'adapters/persistence-audit.ts',
          content: 'await writeFile(path, JSON.stringify(event) + "\\n");',
        },
      ];
      expect(findRawJsonHashViolations(fixture)).toEqual([]);
    });
  });
});

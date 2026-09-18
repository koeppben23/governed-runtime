/**
 * @module architecture/canonical-json-ssot
 * @description Anti-drift guard (#434, finding C1): there is exactly ONE
 * canonical authority for JSON serialization before hashing —
 * `canonicalJsonStringify` in `shared/canonical-json.ts`. The original C1
 * defect was two divergent serializers (a broken inline one in `audit/types.ts`
 * and the correct canonical one), which silently produced different chain
 * hashes and voided tamper-evidence.
 *
 * This guard owns the DEFINITION side of the serialization authority:
 *   1. `canonicalJsonStringify` may be DEFINED only in the canonical module.
 *   2. A recursive key-sorting helper named exactly `canonicalize` may be
 *      DEFINED only there (it catches differently-named-but-duplicate
 *      serializers that a public-API check would miss).
 *
 * The USAGE side — a hash primitive must never consume a raw
 * `JSON.stringify(...)` — is owned default-wide by
 * `digest-authority-ssot.test.ts`. The guards do not overlap: definitions here,
 * hash-input usage there.
 *
 * Mechanism mirrors `config/reasons-completeness.test.ts` and
 * `architecture/__tests__/dependency-rules.test.ts`: a pure detector over
 * production source, plus a proving negative fixture. Production scan excludes
 * test sources only (`.test.ts`, `__tests__/`, classified test-support trees)
 * so this guard cannot flag its own fixtures.
 *
 * @version v2
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(process.cwd(), 'src');

/** The sole module permitted to define/own the canonical JSON serializer. */
const CANONICAL_MODULE = 'shared/canonical-json.ts';

/** A definition (not a call/import) of the canonical serializer entry point. */
const DEFINE_CANONICAL = /\b(?:function|const)\s+canonicalJsonStringify\b/;

/**
 * A definition of a recursive key-sorting helper named exactly `canonicalize`.
 * The `\b` after the name keeps this from matching legitimately-distinct names
 * such as `canonicalizeOriginUrl` (URL canonicalizer, not a JSON key-sorter).
 */
const DEFINE_CANONICALIZE = /\b(?:function|const)\s+canonicalize\b/;

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

function collectProductionFiles(dir: string, acc: SourceFile[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      collectProductionFiles(full, acc);
      continue;
    }
    if (!entry.isFile() || !full.endsWith('.ts') || full.endsWith('.test.ts')) continue;
    acc.push({
      rel: relative(SRC_ROOT, full).split(sep).join('/'),
      content: readFileSync(full, 'utf8'),
    });
  }
}

function findCanonicalizationViolations(files: readonly SourceFile[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    f.content.split('\n').forEach((text, i) => {
      if (DEFINE_CANONICAL.test(text) && f.rel !== CANONICAL_MODULE) {
        out.push({
          rel: f.rel,
          line: i + 1,
          snippet: text.trim(),
          rule: 'duplicate-canonical-serializer',
        });
      }
      // Any recursive key-sorter named `canonicalize` must live only in the
      // authority. This catches differently-named-but-duplicate serializers
      // (the discovery-digest divergence that the public-API check missed).
      if (DEFINE_CANONICALIZE.test(text) && f.rel !== CANONICAL_MODULE) {
        out.push({
          rel: f.rel,
          line: i + 1,
          snippet: text.trim(),
          rule: 'duplicate-canonicalize-helper',
        });
      }
    });
  }
  return out;
}

describe('canonical JSON serialization SSOT (#434 C1 anti-drift)', () => {
  const files: SourceFile[] = [];
  collectProductionFiles(SRC_ROOT, files);

  it('production code has exactly one canonical JSON serialization authority', () => {
    const violations = findCanonicalizationViolations(files);
    if (violations.length > 0) {
      console.error('Canonicalization SSOT violations:', violations);
    }
    expect(violations).toEqual([]);
  });

  describe('negative fixture — proves the detector fires', () => {
    it('detects a duplicate canonicalJsonStringify definition outside the authority', () => {
      const fixture: SourceFile[] = [
        {
          rel: 'audit/rogue.ts',
          content: 'export function canonicalJsonStringify(v) { return ""; }',
        },
      ];
      const violations = findCanonicalizationViolations(fixture);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.rule).toBe('duplicate-canonical-serializer');
    });

    it('detects a duplicate `canonicalize` recursive key-sorter outside the authority', () => {
      const fixture: SourceFile[] = [
        {
          rel: 'discovery/rogue.ts',
          content: 'function canonicalize(value) { return value; }',
        },
      ];
      const violations = findCanonicalizationViolations(fixture);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.rule).toBe('duplicate-canonicalize-helper');
    });

    it('does NOT flag a differently-named canonicalizer (canonicalizeOriginUrl)', () => {
      // Suffix safety: `canonicalizeOriginUrl` in adapters/workspace/fingerprint.ts
      // is a URL canonicalizer, not a JSON key-sorter, and must never be flagged.
      const fixture: SourceFile[] = [
        {
          rel: 'adapters/workspace/fingerprint.ts',
          content:
            'export function canonicalizeOriginUrl(rawUrl: string): string { return rawUrl; }',
        },
      ];
      const violations = findCanonicalizationViolations(fixture);
      expect(violations).toEqual([]);
    });
  });
});

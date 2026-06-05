/**
 * @module architecture/policy-mode-ssot.test
 * @description Anti-drift guard (#434, finding H1): the policy-mode vocabulary
 * has exactly ONE typed authority — `POLICY_MODES`/`PolicyModeSchema`/`PolicyMode`
 * in `state/policy-mode.ts`. The H1 defect class was free-form mode typing
 * (`z.string()`) and duplicated literal unions, which let a near-miss string
 * silently disable enforcement.
 *
 * This guard fails closed when the mode vocabulary is (re)defined at the
 * type/schema level outside the authority:
 *   1. No inline literal union joining >=2 distinct mode literals with `|`.
 *   2. No `mode`/`requestedMode` field typed as free-form `z.string()`.
 *
 * It also pins the one ARCHITECTURALLY-MANDATED duplicate — `archive/types.ts`
 * MANIFEST_POLICY_MODES (a leaf module that may not import `state`) — with a
 * CI-enforced sync assertion, converting the comment-only sync contract into a
 * guard.
 *
 * Production scan excludes `*.test.ts` and `__tests__/` so this guard cannot
 * flag its own fixtures, and targets only TYPE/SCHEMA definitions of the mode
 * vocabulary — value usages like `mode: 'regulated'` are unaffected.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { POLICY_MODES } from '../../state/policy-mode.js';
import { MANIFEST_POLICY_MODES, MANIFEST_POLICY_MODE_UNKNOWN } from '../../archive/types.js';

const SRC_ROOT = join(process.cwd(), 'src');

/** The sole authority that may define the policy-mode vocabulary. */
const POLICY_MODE_SSOT = 'state/policy-mode.ts';

/**
 * Allowlisted, architecturally-mandated leaf duplicate: `archive/types.ts` is a
 * leaf module and MUST NOT import from `state` (layering contract), so it keeps
 * a local `z.enum`. Drift is prevented not by import but by the sync test below.
 */
const ARCHIVE_LEAF_DUPLICATE = 'archive/types.ts';

/** A literal union joining >=2 distinct mode literals (a vocabulary definition). */
const MODE_LITERAL_UNION =
  /'(?:solo|team|team-ci|regulated)'\s*\|\s*'(?:solo|team|team-ci|regulated)'/;

/** A mode field typed as free-form string instead of the enum. */
const MODE_AS_FREE_STRING = /\b(?:mode|requestedMode)\s*:\s*z\.string\(\)/;

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

function findPolicyModeViolations(files: readonly SourceFile[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.rel === POLICY_MODE_SSOT || f.rel === ARCHIVE_LEAF_DUPLICATE) continue;
    f.content.split('\n').forEach((text, i) => {
      if (MODE_LITERAL_UNION.test(text)) {
        out.push({
          rel: f.rel,
          line: i + 1,
          snippet: text.trim(),
          rule: 'duplicate-mode-literal-union',
        });
      }
      if (MODE_AS_FREE_STRING.test(text)) {
        out.push({
          rel: f.rel,
          line: i + 1,
          snippet: text.trim(),
          rule: 'mode-typed-as-free-string',
        });
      }
    });
  }
  return out;
}

describe('policy-mode SSOT (#434 H1 anti-drift)', () => {
  const files: SourceFile[] = [];
  collectProductionFiles(SRC_ROOT, files);

  it('production code defines the policy-mode vocabulary in exactly one place', () => {
    const violations = findPolicyModeViolations(files);
    if (violations.length > 0) {
      console.error('Policy-mode SSOT violations:', violations);
    }
    expect(violations).toEqual([]);
  });

  it('archive manifest modes stay in sync with the policy-mode SSOT', () => {
    const governed = MANIFEST_POLICY_MODES.filter((m) => m !== MANIFEST_POLICY_MODE_UNKNOWN);
    expect([...governed].sort()).toEqual([...POLICY_MODES].sort());
  });

  describe('negative fixture — proves the detector fires', () => {
    it('detects a duplicate mode literal union outside the authority', () => {
      const fixture: SourceFile[] = [
        { rel: 'rails/rogue.ts', content: "type M = 'solo' | 'regulated';" },
      ];
      const violations = findPolicyModeViolations(fixture);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.rule).toBe('duplicate-mode-literal-union');
    });

    it('detects a mode field typed as free-form string', () => {
      const fixture: SourceFile[] = [
        { rel: 'config/rogue.ts', content: 'const S = z.object({ mode: z.string() });' },
      ];
      const violations = findPolicyModeViolations(fixture);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.rule).toBe('mode-typed-as-free-string');
    });
  });
});

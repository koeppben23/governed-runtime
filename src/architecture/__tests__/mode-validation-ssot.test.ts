import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * @module architecture/mode-validation-ssot.test
 * @description Anti-drift guard (#499): there is exactly ONE canonical authority
 * for classifying a multi-mode FlowGuard tool call (`flowguard_plan`,
 * `flowguard_architecture`, `flowguard_implement`) into its operation mode —
 * `classifyToolCallMode` / `toolCallFlags` in
 * `integration/tools/review-validation-mode.ts`.
 *
 * The original #499 defect was three divergent argument-shape validators (one
 * per tool) that drifted: architecture silently dropped adrText on approval and
 * never wired `INVALID_ARCHITECTURE_TOOL_SEQUENCE`, while plan and implement had
 * different coverage for the same shared fields. This guard fails closed when a
 * competing per-tool verdict/mode classifier is reintroduced under
 * `integration/tools/`:
 *   1. The `reviewVerdict === 'string'` flag idiom may appear only in the
 *      canonical module (all tool classifiers must derive flags from it).
 *
 * Scope: only the tool-argument layer (`integration/tools/`). The plugin
 * enforcement hook (`integration/review/enforcement/`) reads verdicts off raw
 * tool args for a different purpose and is intentionally out of scope.
 *
 * Mechanism mirrors `audit-canonicalization-ssot.test.ts`: a pure detector over
 * production source, plus a proving negative fixture. `*.test.ts` and
 * `__tests__/` are excluded so this guard cannot flag its own fixtures.
 */

const SRC_ROOT = join(process.cwd(), 'src');
const TOOLS_DIR = 'integration/tools';

/** The sole module permitted to derive the canonical multi-mode flags. */
const CANONICAL_MODULE = 'integration/tools/review-validation-mode.ts';

/**
 * The verdict-presence flag idiom. Any per-tool re-implementation of this is a
 * duplicate-authority drift hazard — tool classifiers must call `toolCallFlags`.
 */
const VERDICT_FLAG_IDIOM = /reviewVerdict\s*===\s*'string'/;

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

function collectToolsFiles(dir: string, acc: SourceFile[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      collectToolsFiles(full, acc);
      continue;
    }
    if (!entry.isFile() || !full.endsWith('.ts') || full.endsWith('.test.ts')) continue;
    const rel = relative(SRC_ROOT, full).split(sep).join('/');
    if (!rel.startsWith(TOOLS_DIR)) continue;
    acc.push({ rel, content: readFileSync(full, 'utf8') });
  }
}

function findModeValidationViolations(files: readonly SourceFile[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.rel === CANONICAL_MODULE) continue;
    f.content.split('\n').forEach((text, i) => {
      if (VERDICT_FLAG_IDIOM.test(text)) {
        out.push({
          rel: f.rel,
          line: i + 1,
          snippet: text.trim(),
          rule: 'duplicate-mode-flag-idiom',
        });
      }
    });
  }
  return out;
}

describe('multi-mode tool-call validation SSOT (#499 anti-drift)', () => {
  const files: SourceFile[] = [];
  collectToolsFiles(SRC_ROOT, files);

  it('only review-validation-mode.ts derives the verdict-presence flag under integration/tools', () => {
    const violations = findModeValidationViolations(files);
    if (violations.length > 0) {
      console.error('Mode-validation SSOT violations:', violations);
    }
    expect(violations).toEqual([]);
  });

  describe('negative fixture — proves the detector fires', () => {
    it('detects a duplicate verdict-flag idiom outside the authority', () => {
      const fixture: SourceFile[] = [
        {
          rel: 'integration/tools/rogue.ts',
          content: "const hasVerdict = typeof args.reviewVerdict === 'string';",
        },
      ];
      const violations = findModeValidationViolations(fixture);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.rule).toBe('duplicate-mode-flag-idiom');
    });

    it('does NOT flag the canonical module itself', () => {
      const fixture: SourceFile[] = [
        {
          rel: CANONICAL_MODULE,
          content:
            "hasVerdict: typeof args.reviewVerdict === 'string' && args.reviewVerdict.length > 0,",
        },
      ];
      expect(findModeValidationViolations(fixture)).toEqual([]);
    });
  });
});

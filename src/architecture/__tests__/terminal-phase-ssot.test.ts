/**
 * @module architecture/terminal-phase-ssot.test
 * @description Anti-drift guard (#434, finding H4): terminal-phase membership
 * has exactly ONE authority — `TERMINAL` / `isTerminalPhase` in
 * `machine/topology.ts` (the set {COMPLETE, ARCH_COMPLETE, REVIEW_COMPLETE}).
 * The H4 defect was `abort.ts` using a literal `=== 'COMPLETE'` that silently
 * excluded the other two terminals, letting abort overwrite a terminal phase.
 *
 * This guard fails closed on two shapes:
 *   1. HARD (never allowlistable): a single line deciding membership over >=2
 *      distinct terminal literals (a hand-rolled terminal-set predicate). Such
 *      intent MUST go through `TERMINAL` / `isTerminalPhase`.
 *   2. SOFT (curated, counted allowlist): single terminal-literal comparisons
 *      are legitimate ONLY for flow-specific checks that intentionally select
 *      one terminal (e.g. ARCH_COMPLETE for architecture-flow finalization).
 *      Each such file has a counted budget; a NEW occurrence (even in an
 *      allowlisted file) trips the guard so a fresh abort-like literal cannot
 *      slip through.
 *
 * Comment lines are skipped. Production scan excludes `*.test.ts`/`__tests__/`.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(process.cwd(), 'src');

/** The sole authority that owns terminal-phase membership. */
const TERMINAL_AUTHORITY = 'machine/topology.ts';

/**
 * Curated allowlist of files with LEGITIMATE single-terminal comparisons that
 * intentionally select one specific flow's terminal (not "is the session
 * terminal?"). `max` is the exact current count; a higher count is reported as
 * potential new drift. Each entry states why it is not authority duplication.
 */
interface SinglePhaseAllowance {
  readonly file: string;
  readonly max: number;
  readonly reason: string;
}

const SINGLE_PHASE_ALLOWLIST: readonly SinglePhaseAllowance[] = [
  {
    file: 'rails/continue.ts',
    max: 1,
    reason: 'attaches ADR status only on the architecture-flow terminal ARCH_COMPLETE',
  },
  {
    file: 'integration/services/decision-finalization.ts',
    max: 2,
    reason: 'flow-specific finalization: MADR on ARCH_COMPLETE, regulated artifact on COMPLETE',
  },
  {
    file: 'integration/proofgraph/materialize-architecture.ts',
    max: 1,
    reason:
      'validates that an ADR approval certificate belongs to the architecture-flow terminal only',
  },
  {
    file: 'integration/plugin-audit.ts',
    max: 1,
    reason: 'detects the ticket-flow COMPLETE transition specifically (not terminal membership)',
  },
  {
    file: 'integration/tools/architecture-review.ts',
    max: 2,
    reason: 'architecture-flow completion checks tied to ARCH_COMPLETE only',
  },
  {
    file: 'audit/summary.ts',
    max: 1,
    reason: 'evidence-review gate pairs with the ticket-flow COMPLETE terminal specifically',
  },
  {
    file: 'audit/completeness.ts',
    max: 4,
    reason: 'flow-specific decision-slot topology invariants (COMPLETE vs ARCH_COMPLETE)',
  },
  {
    file: 'adapters/workspace/archive-verify-regulated.ts',
    max: 1,
    reason:
      'flow-specific completion contract: only the ticket-flow COMPLETE terminal is a valid regulated evidence-review completion (ARCH_COMPLETE/REVIEW_COMPLETE are out of scope)',
  },
];

/** Quoted terminal literal adjacent to an equality operator (a comparison). */
const TERMINAL_CMP =
  /(?:(?:===|!==)\s*'(COMPLETE|ARCH_COMPLETE|REVIEW_COMPLETE)')|(?:'(COMPLETE|ARCH_COMPLETE|REVIEW_COMPLETE)'\s*(?:===|!==))/g;

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

function isCommentLine(text: string): boolean {
  const t = text.trim();
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*');
}

/** Distinct terminal literals compared on a single (non-comment) line. */
function terminalComparisonsOnLine(text: string): string[] {
  const found = new Set<string>();
  TERMINAL_CMP.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TERMINAL_CMP.exec(text)) !== null) {
    found.add((m[1] ?? m[2])!);
  }
  return [...found];
}

function findTerminalPhaseViolations(files: readonly SourceFile[]): Violation[] {
  const out: Violation[] = [];
  const singleCount = new Map<string, number>();

  for (const f of files) {
    if (f.rel === TERMINAL_AUTHORITY) continue;
    f.content.split('\n').forEach((text, i) => {
      if (isCommentLine(text)) return;
      const lits = terminalComparisonsOnLine(text);
      if (lits.length === 0) return;
      if (lits.length >= 2) {
        out.push({
          rel: f.rel,
          line: i + 1,
          snippet: text.trim(),
          rule: 'terminal-set-disjunction',
        });
        return;
      }
      singleCount.set(f.rel, (singleCount.get(f.rel) ?? 0) + 1);
    });
  }

  for (const [rel, count] of singleCount) {
    const budget = SINGLE_PHASE_ALLOWLIST.find((a) => a.file === rel)?.max ?? 0;
    if (count > budget) {
      out.push({
        rel,
        line: 0,
        snippet: `${count} single-terminal comparison(s); allowed ${budget}`,
        rule: 'terminal-literal-not-via-authority',
      });
    }
  }
  return out;
}

describe('terminal-phase SSOT (#434 H4 anti-drift)', () => {
  const files: SourceFile[] = [];
  collectProductionFiles(SRC_ROOT, files);

  it('production code decides terminal membership only via the TERMINAL authority', () => {
    const violations = findTerminalPhaseViolations(files);
    if (violations.length > 0) {
      console.error('Terminal-phase SSOT violations:', violations);
    }
    expect(violations).toEqual([]);
  });

  describe('negative fixture — proves the detector fires', () => {
    it('hard-fails a multi-terminal disjunction (hand-rolled terminal predicate)', () => {
      const fixture: SourceFile[] = [
        { rel: 'rails/rogue.ts', content: "if (p === 'COMPLETE' || p === 'ARCH_COMPLETE') {}" },
      ];
      const violations = findTerminalPhaseViolations(fixture);
      expect(violations.some((v) => v.rule === 'terminal-set-disjunction')).toBe(true);
    });

    it('flags a single terminal comparison in a non-allowlisted file', () => {
      const fixture: SourceFile[] = [
        { rel: 'rails/rogue.ts', content: "const done = p === 'COMPLETE';" },
      ];
      const violations = findTerminalPhaseViolations(fixture);
      expect(violations.some((v) => v.rule === 'terminal-literal-not-via-authority')).toBe(true);
    });

    it('flags a NEW occurrence beyond budget in an allowlisted file', () => {
      const fixture: SourceFile[] = [
        {
          rel: 'audit/summary.ts',
          content: "a === 'COMPLETE'\nb === 'COMPLETE'\nc === 'COMPLETE'\nd === 'COMPLETE'",
        },
      ];
      const violations = findTerminalPhaseViolations(fixture);
      expect(violations.some((v) => v.rule === 'terminal-literal-not-via-authority')).toBe(true);
    });
  });
});

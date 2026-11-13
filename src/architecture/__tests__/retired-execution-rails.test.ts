/**
 * @module architecture/retired-execution-rails
 * @description Retirement guard for the four historical callback-driven rails.
 *
 * Their production behavior is owned by the current tools/system-work path.
 * Every preserved assertion purpose must still exist in an executable
 * current-owner test; obsolete callback-execution contracts must not return.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

const RETIRED_FILES = [
  'rails/plan.ts',
  'rails/implement.ts',
  'rails/validate.ts',
  'rails/continue.ts',
] as const;
const RETIRED_SUITES = [
  'rails/plan.test.ts',
  'rails/implement.test.ts',
  'rails/validate.test.ts',
  'rails/continue.test.ts',
  'rails/async-rails.test.ts',
] as const;

/** Preserved assertion purposes and the current owner that executes them. */
const CURRENT_OWNERS = [
  [
    'plan initial submission',
    'integration/tools-execute-planning.test.ts',
    'Mode A: records initial plan with digest',
  ],
  [
    'plan empty input',
    'integration/tools-execute-planning.test.ts',
    'blocks with EMPTY_PLAN for empty planText',
  ],
  [
    'plan missing ticket',
    'integration/tools-execute-planning.test.ts',
    'blocks without ticket evidence in the TICKET phase',
  ],
  [
    'plan wrong phase',
    'integration/tools-execute-planning.test.ts',
    'blocks in READY phase (command not allowed without ticket phase)',
  ],
  [
    'plan revision',
    'integration/tools-execute-planning.test.ts',
    'Mode B: changes_requested with revised plan',
  ],
  [
    'plan history',
    'integration/tools-execute-planning.test.ts',
    'keeps plan evidence when PLAN_REVIEW changes_requested returns to PLAN',
  ],
  [
    'plan review budget',
    'integration/tools-execute-planning.test.ts',
    'TEAM: presents the plan at the human gate instead of blocking (#508 regression)',
  ],
  [
    'plan heading boundary',
    'integration/tools-execute-planning.test.ts',
    'rejects a minimal plan without ATX headings before spending review authority',
  ],
  [
    'plan unable_to_review',
    'integration/tools-execute-planning.test.ts',
    'blocks plan with SUBAGENT_UNABLE_TO_REVIEW when captured findings declare unable_to_review (E2E)',
  ],
  [
    'implementation fresh validation',
    'integration/tools-execute-implement.test.ts',
    'defers implementation review obligation and invocation until post-implementation checks pass',
  ],
  [
    'implementation stale evidence',
    'integration/tools/implement-review-validation-gate.test.ts',
    'blocks when passing evidence belongs to a STALE implementation digest (D3)',
  ],
  [
    'implementation zero-check',
    'integration/tools/implement-review-validation-gate.test.ts',
    'passes vacuously when there are no active checks (zero-check sessions unaffected)',
  ],
  [
    'implementation wrong phase',
    'integration/orchestration-dead-state-recovery.test.ts',
    'blocks implementation in TICKET phase',
  ],
  [
    'implementation preconditions',
    'integration/tools-execute-implement.test.ts',
    'blocks without plan/ticket',
  ],
  [
    'implementation review budget',
    'integration/tools/implement-shared.test.ts',
    'derives the implementation review budget from policy',
  ],
  [
    'validation all passed',
    'integration/tools/run-check-tool.test.ts',
    'advances to IMPLEMENTATION when all active checks pass',
  ],
  [
    'validation failure routing',
    'integration/tools-execute-run-check.test.ts',
    'failed check routes to PLAN through the automatic path',
  ],
  [
    'validation execution order',
    'integration/auto-validation.test.ts',
    'team plan approval runs every active check automatically and persists the evidence',
  ],
  [
    'validation technical error',
    'integration/auto-validation.test.ts',
    'an execution error keeps the validation phase and surfaces the error response',
  ],
  [
    'validation wrong phase',
    'integration/tools/run-check-tool.test.ts',
    'blocks in wrong phase (TICKET)',
  ],
  [
    'validation subject drift',
    'integration/tools/run-check-tool.test.ts',
    'post-implementation subject drift keeps IMPL_VALIDATION and the implementation evidence',
  ],
  [
    'validation timeout evidence',
    'integration/tools/run-check-tool.test.ts',
    'timeout evidence shape is correct',
  ],
  [
    'validation implementation binding',
    'integration/tools/run-check-tool.test.ts',
    'binds post-implementation validation attempts to the implementation digest',
  ],
  [
    'validation baseline separation',
    'integration/tools/implement-review-validation-gate.test.ts',
    'ignores baseline-scope attempts (only implementation scope counts)',
  ],
  [
    'continue READY ambiguity',
    'integration/tools/continue-tool.test.ts',
    'blocks READY phase with CONTINUE_AMBIGUOUS',
  ],
  [
    'continue validation guidance',
    'integration/tools/continue-tool.test.ts',
    'VALIDATION phase returns guidance with /check',
  ],
  [
    'continue plan gate',
    'integration/tools/continue-tool.test.ts',
    'PLAN_REVIEW returns user-gate manual_decision',
  ],
  [
    'continue evidence gate',
    'integration/tools/continue-tool.test.ts',
    'EVIDENCE_REVIEW returns user-gate manual_decision',
  ],
  [
    'continue architecture gate',
    'integration/tools/continue-tool.test.ts',
    'ARCH_REVIEW returns user-gate manual_decision',
  ],
  [
    'continue terminal',
    'integration/tools/continue-tool.test.ts',
    'COMPLETE returns terminal action',
  ],
  [
    'continue unknown phase',
    'integration/tools/continue-tool.test.ts',
    'blocks unknown phase with CONTINUE_UNKNOWN_PHASE',
  ],
  [
    'continue implementation review routing',
    'integration/tools/continue-tool.test.ts',
    'IMPL_REVIEW does not introduce a local reviewer command',
  ],
  [
    'architecture workflow',
    'integration/e2e-workflow.test.ts',
    'architecture solo flow: hydrate → architecture → human approval → ARCH_COMPLETE',
  ],
  [
    'architecture revision',
    'integration/e2e-workflow.test.ts',
    'architecture changes_requested at ARCH_REVIEW returns to ARCHITECTURE',
  ],
  [
    'architecture unable_to_review',
    'integration/tools-execute-planning.test.ts',
    'blocks architecture with SUBAGENT_UNABLE_TO_REVIEW when captured findings declare unable_to_review (E2E)',
  ],
  [
    'end-to-end workflow',
    'integration/e2e-workflow.test.ts',
    'complete team workflow with explicit decisions',
  ],
] as const;

function source(relativePath: string): string {
  return readFileSync(join(SRC, relativePath), 'utf8');
}

describe('historical execution rails are retired with current-owner coverage', () => {
  it('removes the four callback-driven implementations and their five suites', () => {
    for (const file of [...RETIRED_FILES, ...RETIRED_SUITES]) {
      expect(existsSync(join(SRC, file)), file).toBe(false);
    }
  });

  it('keeps every preserved assertion purpose executable in a current-owner test', () => {
    for (const [purpose, file, title] of CURRENT_OWNERS) {
      const content = source(file);
      expect(content, `${purpose}: ${file}`).toContain(`it('${title}'`);
    }
  });

  it('does not reintroduce the rail executor symbols in production source', () => {
    const retiredSymbols = /\b(executePlan|executeImplement|executeValidate|executeContinue)\s*\(/;
    const offenders: string[] = [];
    const visit = (relativeDir: string): void => {
      for (const entry of readdirSync(join(SRC, relativeDir), { withFileTypes: true })) {
        const next = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          visit(next);
        } else if (
          entry.name.endsWith('.ts') &&
          !entry.name.endsWith('.test.ts') &&
          !next.includes('/__tests__/') &&
          retiredSymbols.test(readFileSync(join(SRC, next), 'utf8'))
        ) {
          offenders.push(next);
        }
      }
    };
    visit('');
    expect(offenders).toEqual([]);
  });

  it('keeps /continue read-only: no work execution or native review authority', () => {
    const continueTool = source('integration/tools/simple/continue-tool.ts');
    expect(continueTool).not.toContain('runActiveChecksAutomatically');
    expect(continueTool).not.toContain('authorizeNativeReviewDispatch');
    expect(continueTool).not.toContain('reviewAndRevise');
    expect(continueTool).not.toContain('executeCheck');
  });
});

/**
 * @module templates/commands/template-tool-references.test
 * @description Build-time guard: every flowguard_* tool name referenced in command
 * templates MUST be a registered tool. Prevents phantom-tool regressions like B4
 * (where /continue referenced a non-existent flowguard_continue).
 */

import { describe, expect, it } from 'vitest';

import {
  TOOL_FLOWGUARD_STATUS,
  TOOL_FLOWGUARD_HYDRATE,
  TOOL_FLOWGUARD_TICKET,
  TOOL_FLOWGUARD_PLAN,
  TOOL_FLOWGUARD_DECISION,
  TOOL_FLOWGUARD_IMPLEMENT,
  TOOL_FLOWGUARD_VALIDATE,
  TOOL_FLOWGUARD_REVIEW,
  TOOL_FLOWGUARD_ARCHITECTURE,
  TOOL_FLOWGUARD_CONTINUE,
  TOOL_FLOWGUARD_ABORT,
  TOOL_FLOWGUARD_ARCHIVE,
} from '../../integration/tool-names.js';
import { COMMANDS } from './index.js';

const REGISTERED_TOOLS: ReadonlySet<string> = new Set([
  TOOL_FLOWGUARD_STATUS,
  TOOL_FLOWGUARD_HYDRATE,
  TOOL_FLOWGUARD_TICKET,
  TOOL_FLOWGUARD_PLAN,
  TOOL_FLOWGUARD_DECISION,
  TOOL_FLOWGUARD_IMPLEMENT,
  TOOL_FLOWGUARD_VALIDATE,
  TOOL_FLOWGUARD_REVIEW,
  TOOL_FLOWGUARD_ARCHITECTURE,
  TOOL_FLOWGUARD_CONTINUE,
  TOOL_FLOWGUARD_ABORT,
  TOOL_FLOWGUARD_ARCHIVE,
]);

const TOOL_REFERENCE_PATTERN = /flowguard_[a-z_]+/g;

describe('command templates: tool reference integrity', () => {
  it('every flowguard_* token in command templates resolves to a registered tool', () => {
    const violations: { template: string; phantom: string }[] = [];

    for (const [filename, body] of Object.entries(COMMANDS)) {
      const matches = body.match(TOOL_REFERENCE_PATTERN) ?? [];
      for (const ref of matches) {
        if (!REGISTERED_TOOLS.has(ref)) {
          violations.push({ template: filename, phantom: ref });
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('continue.md references the flowguard_continue tool (P8)', () => {
    const body = COMMANDS['continue.md'];
    expect(body).toBeDefined();
    expect(body).toContain('flowguard_continue');
  });
});

/**
 * P1.3 slice 6 — narrative drift guard.
 *
 * The third LoopVerdict 'unable_to_review' is part of the runtime contract
 * (see src/types/loop-verdict.ts, src/integration/review-validation.ts,
 * src/integration/plugin-orchestrator.ts). Slash-command narratives MUST
 * teach the agent how to handle it, otherwise the agent will mishandle
 * BLOCKED responses with code SUBAGENT_UNABLE_TO_REVIEW.
 *
 * These guards prevent silent regressions in plan.md / implement.md /
 * architecture.md narratives.
 */
describe('command templates: third LoopVerdict narrative drift guard', () => {
  it('plan.md mentions unable_to_review and SUBAGENT_UNABLE_TO_REVIEW', () => {
    const body = COMMANDS['plan.md'];
    expect(body).toBeDefined();
    expect(body).toContain('unable_to_review');
    expect(body).toContain('SUBAGENT_UNABLE_TO_REVIEW');
  });

  it('plan.md instructs agent NOT to retry an unable_to_review review', () => {
    const body = COMMANDS['plan.md'];
    // Either "DO NOT retry" or equivalent prohibition must be present.
    expect(body).toMatch(/DO NOT retry|do not retry/);
  });

  it('implement.md mentions unable_to_review and SUBAGENT_UNABLE_TO_REVIEW', () => {
    const body = COMMANDS['implement.md'];
    expect(body).toBeDefined();
    expect(body).toContain('unable_to_review');
    expect(body).toContain('SUBAGENT_UNABLE_TO_REVIEW');
  });

  it('implement.md instructs agent NOT to retry an unable_to_review review', () => {
    const body = COMMANDS['implement.md'];
    expect(body).toMatch(/DO NOT retry|do not retry/);
  });

  it('architecture.md mentions SUBAGENT_UNABLE_TO_REVIEW BLOCKED handling', () => {
    const body = COMMANDS['architecture.md'];
    expect(body).toBeDefined();
    expect(body).toContain('SUBAGENT_UNABLE_TO_REVIEW');
  });
});

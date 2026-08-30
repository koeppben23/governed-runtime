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
  TOOL_FLOWGUARD_EXTEND_IMPLEMENTATION_REVIEW,
  TOOL_FLOWGUARD_IMPLEMENT,
  TOOL_FLOWGUARD_REVIEW_IMPLEMENTATION,
  TOOL_FLOWGUARD_RESOLVE_IMPLEMENTATION_CHALLENGE,
  TOOL_FLOWGUARD_RUN_CHECK,
  TOOL_FLOWGUARD_REVIEW,
  TOOL_FLOWGUARD_ARCHITECTURE,
  TOOL_FLOWGUARD_CONTINUE,
  TOOL_FLOWGUARD_ABORT,
  TOOL_FLOWGUARD_ARCHIVE,
  TOOL_FLOWGUARD_HELP,
  TOOL_FLOWGUARD_RECONCILE_MUTATION_EPISODE,
} from '../../integration/tool-names.js';
import { COMMANDS } from './index.js';
import { TOOL_WRAPPER } from '../wrappers/index.js';

const REGISTERED_TOOLS: ReadonlySet<string> = new Set([
  TOOL_FLOWGUARD_STATUS,
  TOOL_FLOWGUARD_HYDRATE,
  TOOL_FLOWGUARD_TICKET,
  TOOL_FLOWGUARD_PLAN,
  TOOL_FLOWGUARD_DECISION,
  TOOL_FLOWGUARD_EXTEND_IMPLEMENTATION_REVIEW,
  TOOL_FLOWGUARD_IMPLEMENT,
  TOOL_FLOWGUARD_REVIEW_IMPLEMENTATION,
  TOOL_FLOWGUARD_RESOLVE_IMPLEMENTATION_CHALLENGE,
  TOOL_FLOWGUARD_RUN_CHECK,
  TOOL_FLOWGUARD_REVIEW,
  TOOL_FLOWGUARD_ARCHITECTURE,
  TOOL_FLOWGUARD_CONTINUE,
  TOOL_FLOWGUARD_ABORT,
  TOOL_FLOWGUARD_ARCHIVE,
  TOOL_FLOWGUARD_HELP,
  TOOL_FLOWGUARD_RECONCILE_MUTATION_EPISODE,
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

  it('every command-referenced tool is exported by the installed OpenCode wrapper', () => {
    const exportBlock = TOOL_WRAPPER.match(/export\s*\{([^}]*)\}/);
    expect(exportBlock).not.toBeNull();
    const exports = new Set(
      exportBlock![1]!
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    );
    const missing = [...REGISTERED_TOOLS]
      .filter((tool) => Object.values(COMMANDS).some((body) => body.includes(tool)))
      .map((tool) => tool.replace(/^flowguard_/, ''))
      .filter((name) => !exports.has(name));
    expect(missing).toEqual([]);
  });
});

/**
 * OpenCode SDK conformity guard: commands that invoke the review orchestration
 * pipeline (which spawns flowguard-reviewer via Task tool) MUST pin `agent: build`
 * in their frontmatter. Without this, running the command under a different primary
 * agent (e.g. plan) would bypass agent.build.permission.task restrictions.
 *
 * See: https://opencode.ai/docs/commands/#agent
 */
describe('command templates: agent pinning for review-orchestration commands', () => {
  const COMMANDS_REQUIRING_BUILD_AGENT = [
    'plan.md',
    'implement.md',
    'review.md',
    'architecture.md',
    'check.md',
  ] as const;

  for (const cmd of COMMANDS_REQUIRING_BUILD_AGENT) {
    it(`${cmd} must pin agent: build in frontmatter`, () => {
      const body = COMMANDS[cmd];
      if (!body) throw new TypeError(`missing ${cmd} template`);
      // Frontmatter is between --- delimiters
      const frontmatterMatch = body.match(/^[\s\n]*---\n([\s\S]*?)\n---/);
      expect(frontmatterMatch).not.toBeNull();
      const frontmatter = frontmatterMatch?.[1];
      if (!frontmatter) throw new TypeError(`missing ${cmd} frontmatter`);
      expect(frontmatter).toMatch(/^agent:\s*build$/m);
    });
  }

  it('commands without review orchestration do NOT require agent pinning', () => {
    // Smoke test: status.md should work without agent pin
    const body = COMMANDS['status.md'];
    if (!body) throw new TypeError('missing status template');
    const frontmatterMatch = body.match(/^[\s\n]*---\n([\s\S]*?)\n---/);
    expect(frontmatterMatch).not.toBeNull();
    const frontmatter = frontmatterMatch?.[1];
    if (!frontmatter) throw new TypeError('missing status frontmatter');
    // status.md does NOT need agent: build (it only calls flowguard_status)
    expect(frontmatter).not.toMatch(/^agent:\s*build$/m);
  });
});

describe('check command: implementation review orchestration', () => {
  it('starts and submits mandatory review after checks enter IMPL_REVIEW', () => {
    const body = COMMANDS['check.md'];
    if (!body) throw new TypeError('missing check command template');

    expect(body).toContain('If its phase is `IMPL_REVIEW`');
    expect(body).toContain('`flowguard-reviewer` via the Task tool');
    expect(body).toContain('`flowguard_review_implementation({ reviewVerdict })`');
    expect(body).toContain('Never make the subsequent human approval decision.');
  });

  it('stops after baseline validation reaches IMPLEMENTATION', () => {
    const body = COMMANDS['check.md'];
    if (!body) throw new TypeError('missing check command template');

    expect(body).toContain('If its phase is `IMPLEMENTATION`');
    expect(body).toContain(
      'Only a new, explicit user `/implement` command may start implementation.',
    );
    expect(body).toContain('Do not call `read`, `glob`, `grep`, `bash`, `write`, `edit`');
  });
});

/**
 * OpenCode SDK conformity guard: commands that invoke the review orchestration
 * pipeline (which spawns flowguard-reviewer via Task tool) MUST pin `agent: build`
 * in their frontmatter. Without this, running the command under a different primary
 * agent (e.g. plan) would bypass agent.build.permission.task restrictions.
 *
 * See: https://opencode.ai/docs/commands/#agent
 */
describe('command templates: agent pinning for review-orchestration commands', () => {
  const COMMANDS_REQUIRING_BUILD_AGENT = [
    'plan.md',
    'implement.md',
    'review.md',
    'architecture.md',
  ] as const;

  for (const cmd of COMMANDS_REQUIRING_BUILD_AGENT) {
    it(`${cmd} must pin agent: build in frontmatter`, () => {
      const body = COMMANDS[cmd];
      if (!body) throw new TypeError(`missing ${cmd} template`);
      // Frontmatter is between --- delimiters
      const frontmatterMatch = body.match(/^[\s\n]*---\n([\s\S]*?)\n---/);
      expect(frontmatterMatch).not.toBeNull();
      const frontmatter = frontmatterMatch?.[1];
      if (!frontmatter) throw new TypeError(`missing ${cmd} frontmatter`);
      expect(frontmatter).toMatch(/^agent:\s*build$/m);
    });
  }

  it('commands without review orchestration do NOT require agent pinning', () => {
    // Smoke test: status.md should work without agent pin
    const body = COMMANDS['status.md'];
    if (!body) throw new TypeError('missing status template');
    const frontmatterMatch = body.match(/^[\s\n]*---\n([\s\S]*?)\n---/);
    expect(frontmatterMatch).not.toBeNull();
    const frontmatter = frontmatterMatch?.[1];
    if (!frontmatter) throw new TypeError('missing status frontmatter');
    // status.md does NOT need agent: build (it only calls flowguard_status)
    expect(frontmatter).not.toMatch(/^agent:\s*build$/m);
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

describe('implement command: validation-gate contract', () => {
  it('auto-chains through IMPL_VALIDATION and the review loop', () => {
    const body = COMMANDS['implement.md'];
    expect(body).toContain('IMPL_VALIDATION');
    expect(body).toContain('flowguard_status');
    expect(body).toContain('activeChecks');
    expect(body).toContain('verificationCandidates');
    expect(body).toContain('flowguard_run_check({ kind: "<kind>" })');
    expect(body).toContain('IMPL_REVIEW');
    expect(body).toContain('flowguard_review_implementation');
  });

  it('does not call flowguard_run_check without a kind argument', () => {
    const body = COMMANDS['implement.md'];
    expect(body).not.toContain('flowguard_run_check({})');
  });

  it('does not skip empty-check gate into review loop', () => {
    const body = COMMANDS['implement.md'];
    expect(body).not.toContain('skip to Phase 5');
  });

  it('dispatches on the actual returned phase instead of an assumed sequence (#852)', () => {
    const body = COMMANDS['implement.md'];
    expect(body).toContain('Dispatch on the RETURNED `phase` field');
    expect(body).toContain('never an assumed sequence');
    // Zero-check: the machine may land in IMPL_REVIEW within the record call.
    expect(body).toContain('Go DIRECTLY to Phase 5');
    // Reduced ceremony: the machine may land in EVIDENCE_REVIEW within the call.
    expect(body).toContain('No checks, no reviewer, no further steps');
    // No invented phase transition.
    expect(body).toContain('never invent the next phase');
    expect(body).not.toContain('The session advances to IMPL_VALIDATION');
  });

  it('never claims the IMPL_REVIEW gate is unreachable without checks (#852)', () => {
    const body = COMMANDS['implement.md'];
    expect(body).not.toContain('cannot be reached');
  });

  it('requires a confirming runtime response before entering IMPL_REVIEW', () => {
    const body = COMMANDS['implement.md'];
    expect(body).toContain('Never assume IMPL_REVIEW without');
    expect(body).toContain('a confirming runtime response');
  });

  it('does not skip IMPL_VALIDATION into IMPL_REVIEW directly', () => {
    const body = COMMANDS['implement.md'];
    expect(body).not.toContain('INDEPENDENT_REVIEW_COMPLETED: ..."');
  });

  it('limits executor retry to exactly once before failing', () => {
    const body = COMMANDS['implement.md'];
    expect(body).toContain('retry');
    expect(body).not.toContain('retry in place');
  });
});

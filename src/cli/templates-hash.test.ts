import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_CODE_PLUGIN_FILES,
  CODEX_PLUGIN_FILES,
  COMMANDS,
  FLOWGUARD_MANDATES_FULL_BODY,
  FLOWGUARD_MANDATES_KERNEL,
  INSTALL_TEMPLATES,
  PLUGIN_WRAPPER,
  REVIEWER_SUBAGENT,
  TOOL_WRAPPER,
} from './templates.js';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('TEMPLATE_HASH_STABILITY', () => {
  it('FLOWGUARD_MANDATES_KERNEL matches compiled output hash', () => {
    expect(sha256(FLOWGUARD_MANDATES_KERNEL)).toBe(
      '75533455c494c22aed5b2a1023bf2540e07dc5ba40c0ea3751f6681912914489',
    );
  });

  it('FLOWGUARD_MANDATES_FULL_BODY matches compiled output hash', () => {
    expect(sha256(FLOWGUARD_MANDATES_FULL_BODY)).toBe(
      '4a92686e4847c754cebe227776299497889b0378368f10fa2d3bd6c676fe938a',
    );
  });

  it('TOOL_WRAPPER matches compiled output hash', () => {
    expect(sha256(TOOL_WRAPPER)).toBe(
      '07c1d067f67582393e27b8d0b3bb7353a5629eb65f9e407c7a8a24c0cf4be647',
    );
  });

  it('PLUGIN_WRAPPER matches compiled output hash', () => {
    expect(sha256(PLUGIN_WRAPPER)).toBe(
      '1281897a086961931c31f043a3ae566f2095b25e18f7c773d1b52a507c6e16b3',
    );
  });

  it('REVIEWER_SUBAGENT matches compiled output hash', () => {
    expect(sha256(REVIEWER_SUBAGENT)).toBe(
      'aa935280321fbd7ba2d10e6a6a88024bd6784a19358713653544be7d1cb58f06',
    );
  });

  it('INSTALL_TEMPLATES matches compiled output hash', () => {
    const templatesJson = JSON.stringify(INSTALL_TEMPLATES, Object.keys(INSTALL_TEMPLATES).sort());
    expect(sha256(templatesJson)).toBe(
      'a5dd79af00d1ed76dcf2948be163806699a1d429705757975a44e86dc8400dc6',
    );
  });

  it('CLAUDE_CODE_PLUGIN_FILES matches compiled output hash', () => {
    const pluginJson = JSON.stringify(
      CLAUDE_CODE_PLUGIN_FILES,
      Object.keys(CLAUDE_CODE_PLUGIN_FILES).sort(),
    );
    expect(sha256(pluginJson)).toBe(
      '7ac60d414729830d55b8583b42e7f93c90e46178915d1ff89dfbb45e4a319ebc',
    );
  });

  it('CODEX_PLUGIN_FILES matches compiled output hash', () => {
    const pluginJson = JSON.stringify(CODEX_PLUGIN_FILES, Object.keys(CODEX_PLUGIN_FILES).sort());
    expect(sha256(pluginJson)).toBe(
      '82652d8118756996061673b9fb6a76bd25906e15ca8b48c5b5078a7634f90548',
    );
  });

  it('COMMANDS matches compiled output hash', () => {
    // Refreshed for the async install-verify refactor and outcome-first mandate work.
    // Refreshed for policy-first review contract hardening: /review now requires
    // ReviewerFindingsInput before any decision and binds planVersion explicitly.
    // Refreshed for the canonical reviewer schema contract: every review path now
    // serializes the same validated JSON shape, including planVersion, and task-local
    // reviewer prompts carry the schema instead of permanent reviewer identity text.
    // Refreshed for explicit host-task review capability failure: host_task_required
    // now returns a structured blocker instead of silently falling back to SDK sessions.
    // Refreshed for outcome-first implementation guidance: /implement no longer treats
    // local implementation mechanics as approved-plan authority, and /plan now
    // materializes Contracts and Authority Decisions as explicit binding sections.
    const commandsJson = JSON.stringify(COMMANDS, Object.keys(COMMANDS).sort());
    expect(sha256(commandsJson)).toBe(
      'd826580bdb46a876bf4cb77332149108e9bb83c91d238c7a471e7df53c77dd21',
    );
  });

  it('all 26 commands present', () => {
    const expected = [
      'abort.md',
      'approve.md',
      'architecture.md',
      'archive.md',
      'check.md',
      'commands.md',
      'continue.md',
      'export.md',
      'extend-implementation-review.md',
      'finish.md',
      'help.md',
      'hydrate.md',
      'implement.md',
      'plan.md',
      'reconcile-mutation-episode.md',
      'reject.md',
      'request-changes.md',
      'resolve-implementation-challenge.md',
      'review-decision.md',
      'review.md',
      'start.md',
      'status.md',
      'task.md',
      'ticket.md',
      'validate.md',
      'why.md',
    ];
    expect(Object.keys(COMMANDS).sort()).toEqual(expected);
  });
});

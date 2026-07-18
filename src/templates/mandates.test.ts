/**
 * @module templates/mandates.test
 * @description Minimal contract tests for the 7 directly-consumed exports
 * of mandates.ts. Provides mutation coverage anchors for Stryker without
 * brittle full-text snapshots.
 *
 * FLOWGUARD_MANDATES_BODY (229 lines) is tested via stable governance
 * anchors — not every mutation in the template body will be caught.
 *
 * @test-policy HAPPY, CORNER
 */

import { describe, it, expect } from 'vitest';
import {
  FLOWGUARD_MANDATES_BODY,
  REVIEWER_AGENT,
  CLAUDE_REVIEWER_AGENT,
  CODEX_REVIEWER_SUBAGENT,
  mandatesInstructionEntry,
  MANDATES_FILENAME,
  LEGACY_INSTRUCTION_ENTRY,
} from './mandates.js';

describe('mandates — contract anchors', () => {
  it('FLOWGUARD_MANDATES_BODY contains governance anchors', () => {
    expect(FLOWGUARD_MANDATES_BODY.length).toBeGreaterThan(1000);
    expect(FLOWGUARD_MANDATES_BODY).toContain('# FlowGuard Agent Rules');
    expect(FLOWGUARD_MANDATES_BODY).toContain('canonical authority');
    expect(FLOWGUARD_MANDATES_BODY).toContain('## Red Lines');
    expect(FLOWGUARD_MANDATES_BODY).toContain('MUST');
  });

  it('REVIEWER_AGENT contains subagent type and role', () => {
    expect(REVIEWER_AGENT.length).toBeGreaterThan(100);
    expect(REVIEWER_AGENT).toContain('flowguard-reviewer');
    expect(REVIEWER_AGENT).toContain('## Your Role');
    expect(REVIEWER_AGENT).toContain('flowguard_*: deny');
    expect(REVIEWER_AGENT).toContain('mcp__flowguard__*: deny');
    expect(REVIEWER_AGENT).toContain('task: deny');
  });

  it('CLAUDE_REVIEWER_AGENT contains platform marker', () => {
    expect(CLAUDE_REVIEWER_AGENT.length).toBeGreaterThan(50);
    expect(CLAUDE_REVIEWER_AGENT).toContain('flowguard-reviewer');
  });

  it('CODEX_REVIEWER_SUBAGENT contains platform marker', () => {
    expect(CODEX_REVIEWER_SUBAGENT.length).toBeGreaterThan(50);
    expect(CODEX_REVIEWER_SUBAGENT).toContain('flowguard-reviewer');
  });

  it('mandatesInstructionEntry uses MANDATES_FILENAME', () => {
    const repo = mandatesInstructionEntry('repo');
    expect(repo).toContain(MANDATES_FILENAME);
    expect(repo).toContain('.opencode/');
    const global = mandatesInstructionEntry('global');
    expect(global).toContain(MANDATES_FILENAME);
  });

  it('MANDATES_FILENAME and LEGACY_INSTRUCTION_ENTRY are stable', () => {
    expect(MANDATES_FILENAME).toBe('flowguard-mandates.md');
    expect(LEGACY_INSTRUCTION_ENTRY).toBe('AGENTS.md');
  });
});

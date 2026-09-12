/**
 * @module templates/mandates.test
 * @description Minimal contract tests for the 7 directly-consumed exports
 * of mandates.ts. Provides mutation coverage anchors for Stryker without
 * brittle full-text snapshots.
 *
 * FLOWGUARD_MANDATES_FULL_BODY is tested via stable governance
 * anchors — not every mutation in the template body will be caught.
 *
 * @test-policy HAPPY, CORNER
 */

import { describe, it, expect } from 'vitest';
import {
  FLOWGUARD_MANDATES_FULL_BODY,
  REVIEWER_AGENT,
  CLAUDE_REVIEWER_AGENT,
  CODEX_REVIEWER_SUBAGENT,
  mandatesInstructionEntry,
  MANDATES_FILENAME,
} from './mandates.js';

describe('mandates — contract anchors', () => {
  it('FLOWGUARD_MANDATES_FULL_BODY contains governance anchors', () => {
    expect(FLOWGUARD_MANDATES_FULL_BODY.length).toBeGreaterThan(1000);
    expect(FLOWGUARD_MANDATES_FULL_BODY).toContain('# FlowGuard Agent Rules');
    expect(FLOWGUARD_MANDATES_FULL_BODY).toContain('canonical authority');
    expect(FLOWGUARD_MANDATES_FULL_BODY).toContain('## Red Lines');
    expect(FLOWGUARD_MANDATES_FULL_BODY).toContain('MUST');
  });

  it('REVIEWER_AGENT contains the permanent subagent role and isolation boundaries', () => {
    expect(REVIEWER_AGENT.length).toBeGreaterThan(100);
    expect(REVIEWER_AGENT).toContain('mode: subagent');
    expect(REVIEWER_AGENT).toContain('independent FlowGuard reviewer');
    expect(REVIEWER_AGENT).toContain('read-only, falsification-first review');
    expect(REVIEWER_AGENT).toContain('flowguard_*: deny');
    expect(REVIEWER_AGENT).toContain('mcp__flowguard__*: deny');
    expect(REVIEWER_AGENT).toContain('task: deny');
    expect(REVIEWER_AGENT).toContain('The task prompt supplies the current obligation');
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
    expect(repo).toBe(`.opencode/${MANDATES_FILENAME}`);
    const global = mandatesInstructionEntry('global');
    expect(global).toBe(MANDATES_FILENAME);
  });

  it('keeps the installed mandate body canonical', () => {
    expect(MANDATES_FILENAME).toBe('flowguard-mandates.md');
    expect(FLOWGUARD_MANDATES_FULL_BODY).toContain('[End of v5 Agent Rules]');
  });
});

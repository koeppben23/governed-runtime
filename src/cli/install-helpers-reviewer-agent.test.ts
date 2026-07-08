import { describe, it, expect, afterEach } from 'vitest';
import { withTestEnv } from '../integration/test-helpers.js';
import {
  buildReviewerAgentContent,
  reviewerDefinitionForPlatform,
  FLOWGUARD_REVIEWER_MODEL_ENV,
  FLOWGUARD_REVIEWER_EFFORT_ENV,
} from './install-helpers.js';
import { REVIEWER_AGENT, CLAUDE_REVIEWER_AGENT, CODEX_REVIEWER_SUBAGENT } from './templates.js';

describe('buildReviewerAgentContent', () => {
  let restoreEnv: (() => void) | undefined;

  afterEach(() => {
    restoreEnv?.();
    restoreEnv = undefined;
  });

  // ─── HAPPY ──────────────────────────────────────────────────────────────────

  it('T11: returns template unchanged when FLOWGUARD_REVIEWER_MODEL absent', () => {
    restoreEnv = withTestEnv({ [FLOWGUARD_REVIEWER_MODEL_ENV]: undefined });
    const result = buildReviewerAgentContent(REVIEWER_AGENT);
    expect(result).toBe(REVIEWER_AGENT);
  });

  it('T13: injects model: into frontmatter when FLOWGUARD_REVIEWER_MODEL set', () => {
    restoreEnv = withTestEnv({ [FLOWGUARD_REVIEWER_MODEL_ENV]: 'opencode/big-pickle' });
    const result = buildReviewerAgentContent(REVIEWER_AGENT);
    expect(result).toContain('model: opencode/big-pickle');
    expect(result).not.toBe(REVIEWER_AGENT);
  });

  it('T14: injected model: appears between --- and description:', () => {
    restoreEnv = withTestEnv({ [FLOWGUARD_REVIEWER_MODEL_ENV]: 'gpt-5.2' });
    const result = buildReviewerAgentContent(REVIEWER_AGENT);
    const lines = result.split('\n');
    const dashIndex = lines.indexOf('---');
    const modelIndex = lines.findIndex((l) => l.startsWith('model:'));
    const descIndex = lines.findIndex((l) => l.startsWith('description:'));
    expect(dashIndex).toBe(0);
    expect(modelIndex).toBeGreaterThan(dashIndex);
    expect(modelIndex).toBeLessThan(descIndex);
  });

  // ─── BAD ────────────────────────────────────────────────────────────────────

  it('T12: returns template unchanged when FLOWGUARD_REVIEWER_MODEL is empty string', () => {
    restoreEnv = withTestEnv({ [FLOWGUARD_REVIEWER_MODEL_ENV]: '' });
    const result = buildReviewerAgentContent(REVIEWER_AGENT);
    expect(result).toBe(REVIEWER_AGENT);
  });

  it('T12b: returns template unchanged when FLOWGUARD_REVIEWER_MODEL is whitespace only', () => {
    restoreEnv = withTestEnv({ [FLOWGUARD_REVIEWER_MODEL_ENV]: '   \t  ' });
    const result = buildReviewerAgentContent(REVIEWER_AGENT);
    expect(result).toBe(REVIEWER_AGENT);
  });

  it('T15: throws on newline in FLOWGUARD_REVIEWER_MODEL (YAML injection prevention)', () => {
    restoreEnv = withTestEnv({ [FLOWGUARD_REVIEWER_MODEL_ENV]: 'bad-model\nhidden: false' });
    expect(() => buildReviewerAgentContent(REVIEWER_AGENT)).toThrow(/newline characters/);
  });

  it('T15b: throws on carriage return in FLOWGUARD_REVIEWER_MODEL', () => {
    restoreEnv = withTestEnv({ [FLOWGUARD_REVIEWER_MODEL_ENV]: 'bad-model\rinjected: true' });
    expect(() => buildReviewerAgentContent(REVIEWER_AGENT)).toThrow(/newline characters/);
  });

  it('T16: throws on invalid characters in FLOWGUARD_REVIEWER_MODEL', () => {
    restoreEnv = withTestEnv({ [FLOWGUARD_REVIEWER_MODEL_ENV]: 'model with spaces' });
    expect(() => buildReviewerAgentContent(REVIEWER_AGENT)).toThrow(/invalid characters/);
  });

  it('T16b: throws on shell metacharacters in FLOWGUARD_REVIEWER_MODEL', () => {
    restoreEnv = withTestEnv({ [FLOWGUARD_REVIEWER_MODEL_ENV]: '$(whoami)' });
    expect(() => buildReviewerAgentContent(REVIEWER_AGENT)).toThrow(/invalid characters/);
  });

  it('T16c: throws on quotes in FLOWGUARD_REVIEWER_MODEL', () => {
    restoreEnv = withTestEnv({ [FLOWGUARD_REVIEWER_MODEL_ENV]: '"injected"' });
    expect(() => buildReviewerAgentContent(REVIEWER_AGENT)).toThrow(/invalid characters/);
  });

  // ─── CORNER ─────────────────────────────────────────────────────────────────

  it('T17: accepts valid model IDs with various characters', () => {
    const validIds = [
      'opencode/big-pickle',
      'gpt-5.2',
      'claude-sonnet-4.5',
      'anthropic/claude-sonnet-4.5',
      'google/gemini-3-pro',
      'org:team/model-v2',
      '@provider/model',
    ];
    for (const id of validIds) {
      const cleanup = withTestEnv({ [FLOWGUARD_REVIEWER_MODEL_ENV]: id });
      try {
        const result = buildReviewerAgentContent(REVIEWER_AGENT);
        expect(result).toContain(`model: ${id}`);
      } finally {
        cleanup();
      }
    }
  });

  it('T18: REVIEWER_AGENT constant has no model: in frontmatter today', () => {
    // Guards against double-injection if the constant later adds a model: field.
    // If this test fails, buildReviewerAgentContent needs replace-or-insert logic.
    const frontmatterMatch = REVIEWER_AGENT.match(/^---\n([\s\S]*?)\n---/);
    expect(frontmatterMatch).not.toBeNull();
    const frontmatter = frontmatterMatch![1]!;
    expect(frontmatter).not.toMatch(/^model:/m);
  });

  // ─── EDGE ───────────────────────────────────────────────────────────────────

  it('EDGE: trims whitespace from model ID', () => {
    restoreEnv = withTestEnv({ [FLOWGUARD_REVIEWER_MODEL_ENV]: '  opencode/big-pickle  ' });
    const result = buildReviewerAgentContent(REVIEWER_AGENT);
    expect(result).toContain('model: opencode/big-pickle');
    // No leading/trailing whitespace in the model value
    expect(result).not.toContain('model:   ');
  });

  it('EDGE: preserves rest of template unchanged', () => {
    restoreEnv = withTestEnv({ [FLOWGUARD_REVIEWER_MODEL_ENV]: 'test-model' });
    const result = buildReviewerAgentContent(REVIEWER_AGENT);
    // Remove the injected model line and compare
    const withoutModel = result.replace('model: test-model\n', '');
    expect(withoutModel).toBe(REVIEWER_AGENT);
  });

  it('EDGE: handles template without newline gracefully', () => {
    restoreEnv = withTestEnv({ [FLOWGUARD_REVIEWER_MODEL_ENV]: undefined });
    const result = buildReviewerAgentContent('no-newline');
    expect(result).toBe('no-newline');
  });

  it('EDGE: handles template without newline when env var set', () => {
    restoreEnv = withTestEnv({ [FLOWGUARD_REVIEWER_MODEL_ENV]: 'some-model' });
    // Defensive: malformed template with no newline returns template unchanged
    const result = buildReviewerAgentContent('no-newline');
    expect(result).toBe('no-newline');
  });

  // ─── SMOKE ──────────────────────────────────────────────────────────────────

  it('SMOKE: env var constant matches expected name', () => {
    expect(FLOWGUARD_REVIEWER_MODEL_ENV).toBe('FLOWGUARD_REVIEWER_MODEL');
  });

  it('SMOKE: injected content is valid YAML frontmatter', () => {
    restoreEnv = withTestEnv({ [FLOWGUARD_REVIEWER_MODEL_ENV]: 'opencode/big-pickle' });
    const result = buildReviewerAgentContent(REVIEWER_AGENT);
    // Verify the frontmatter block is well-formed: starts with ---, ends with ---
    const lines = result.split('\n');
    expect(lines[0]).toBe('---');
    const closingDashIndex = lines.indexOf('---', 1);
    expect(closingDashIndex).toBeGreaterThan(1);
    // model: should be within the frontmatter block
    const modelLine = lines.findIndex((l) => l === 'model: opencode/big-pickle');
    expect(modelLine).toBeGreaterThan(0);
    expect(modelLine).toBeLessThan(closingDashIndex);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildReviewerAgentContent — per-host effort injection + governance invariance
// (F4: capability-adaptive operative transport)
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildReviewerAgentContent — per-host reasoning-effort injection', () => {
  let restoreEnv: (() => void) | undefined;

  afterEach(() => {
    restoreEnv?.();
    restoreEnv = undefined;
  });

  // Returns the lines inside the leading --- frontmatter block.
  function frontmatterLines(content: string): string[] {
    const lines = content.split('\n');
    expect(lines[0]).toBe('---');
    const close = lines.indexOf('---', 1);
    expect(close).toBeGreaterThan(1);
    return lines.slice(1, close);
  }

  // Everything after the closing --- of the frontmatter (the governance body).
  function bodyAfterFrontmatter(content: string): string {
    const close = content.indexOf('\n---', content.indexOf('\n') + 1);
    expect(close).toBeGreaterThan(0);
    return content.slice(close);
  }

  // ─── HAPPY: opencode uses reasoningEffort passthrough key ─────────────────────

  it('F4-1: opencode injects reasoningEffort: from FLOWGUARD_REVIEWER_EFFORT', () => {
    restoreEnv = withTestEnv({ [FLOWGUARD_REVIEWER_EFFORT_ENV]: 'high' });
    const result = buildReviewerAgentContent(REVIEWER_AGENT, 'opencode');
    expect(frontmatterLines(result)).toContain('reasoningEffort: high');
    expect(result).not.toContain('effort: high');
  });

  it('F4-2: opencode default platform also uses reasoningEffort', () => {
    restoreEnv = withTestEnv({ [FLOWGUARD_REVIEWER_EFFORT_ENV]: 'medium' });
    const result = buildReviewerAgentContent(REVIEWER_AGENT);
    expect(frontmatterLines(result)).toContain('reasoningEffort: medium');
  });

  // ─── HAPPY: claude-code uses effort key ───────────────────────────────────────

  it('F4-3: claude-code injects effort: from FLOWGUARD_REVIEWER_EFFORT', () => {
    restoreEnv = withTestEnv({ [FLOWGUARD_REVIEWER_EFFORT_ENV]: 'xhigh' });
    const result = buildReviewerAgentContent(CLAUDE_REVIEWER_AGENT, 'claude-code');
    expect(frontmatterLines(result)).toContain('effort: xhigh');
    expect(result).not.toContain('reasoningEffort:');
  });

  it('F4-4: claude-code injects both model: and effort: together', () => {
    restoreEnv = withTestEnv({
      [FLOWGUARD_REVIEWER_MODEL_ENV]: 'claude-opus-4-8',
      [FLOWGUARD_REVIEWER_EFFORT_ENV]: 'high',
    });
    const result = buildReviewerAgentContent(CLAUDE_REVIEWER_AGENT, 'claude-code');
    const fm = frontmatterLines(result);
    expect(fm).toContain('model: claude-opus-4-8');
    expect(fm).toContain('effort: high');
  });

  // ─── BAD: invalid effort fails closed ─────────────────────────────────────────

  it('F4-5: throws on uppercase/invalid effort (fail-closed, no silent drop)', () => {
    restoreEnv = withTestEnv({ [FLOWGUARD_REVIEWER_EFFORT_ENV]: 'HIGH' });
    expect(() => buildReviewerAgentContent(REVIEWER_AGENT, 'opencode')).toThrow(/invalid value/);
  });

  it('F4-6: throws on effort with digits/symbols (YAML injection guard)', () => {
    restoreEnv = withTestEnv({ [FLOWGUARD_REVIEWER_EFFORT_ENV]: 'high\ninjected: true' });
    expect(() => buildReviewerAgentContent(REVIEWER_AGENT, 'opencode')).toThrow(/invalid value/);
  });

  it('F4-7: empty/whitespace effort leaves template unchanged', () => {
    restoreEnv = withTestEnv({ [FLOWGUARD_REVIEWER_EFFORT_ENV]: '   ' });
    const result = buildReviewerAgentContent(REVIEWER_AGENT, 'opencode');
    expect(result).toBe(REVIEWER_AGENT);
  });

  // ─── GOVERNANCE INVARIANCE: tuning never alters the mandate body ──────────────

  it('F4-8: governance body is byte-identical regardless of model/effort env', () => {
    const baseline = bodyAfterFrontmatter(buildReviewerAgentContent(REVIEWER_AGENT, 'opencode'));
    restoreEnv = withTestEnv({
      [FLOWGUARD_REVIEWER_MODEL_ENV]: 'opencode/big-pickle',
      [FLOWGUARD_REVIEWER_EFFORT_ENV]: 'high',
    });
    const tuned = bodyAfterFrontmatter(buildReviewerAgentContent(REVIEWER_AGENT, 'opencode'));
    expect(tuned).toBe(baseline);
  });

  // ─── SMOKE ────────────────────────────────────────────────────────────────────

  it('F4-9: effort env constant matches expected name', () => {
    expect(FLOWGUARD_REVIEWER_EFFORT_ENV).toBe('FLOWGUARD_REVIEWER_EFFORT');
  });
});

describe('reviewerDefinitionForPlatform — Codex fails closed on unsupported tuning', () => {
  let restoreEnv: (() => void) | undefined;

  afterEach(() => {
    restoreEnv?.();
    restoreEnv = undefined;
  });

  it('F4-10: codex emits static subagent (no model/effort directive) when env unset', () => {
    restoreEnv = withTestEnv({
      [FLOWGUARD_REVIEWER_MODEL_ENV]: undefined,
      [FLOWGUARD_REVIEWER_EFFORT_ENV]: undefined,
    });
    const def = reviewerDefinitionForPlatform('codex');
    expect(def.content).toBe(CODEX_REVIEWER_SUBAGENT);
    expect(def.content).not.toMatch(/^model:/m);
    expect(def.content).not.toMatch(/^effort:/m);
    expect(def.content).not.toMatch(/^reasoningEffort:/m);
  });

  it('F4-11: codex throws when FLOWGUARD_REVIEWER_MODEL is set (no silent drop)', () => {
    restoreEnv = withTestEnv({ [FLOWGUARD_REVIEWER_MODEL_ENV]: 'gpt-5.5' });
    expect(() => reviewerDefinitionForPlatform('codex')).toThrow(
      /not supported for platform "codex"/,
    );
  });

  it('F4-12: codex throws when FLOWGUARD_REVIEWER_EFFORT is set', () => {
    restoreEnv = withTestEnv({ [FLOWGUARD_REVIEWER_EFFORT_ENV]: 'high' });
    expect(() => reviewerDefinitionForPlatform('codex')).toThrow(
      /not supported for platform "codex"/,
    );
  });

  it('F4-13: opencode + claude-code definitions still build with tuning set', () => {
    restoreEnv = withTestEnv({
      [FLOWGUARD_REVIEWER_MODEL_ENV]: 'anthropic/claude-opus-4-8',
      [FLOWGUARD_REVIEWER_EFFORT_ENV]: 'high',
    });
    const oc = reviewerDefinitionForPlatform('opencode');
    expect(oc.content).toContain('reasoningEffort: high');
    const cc = reviewerDefinitionForPlatform('claude-code');
    expect(cc.content).toContain('effort: high');
    expect(cc.content).toContain('model: anthropic/claude-opus-4-8');
  });
});

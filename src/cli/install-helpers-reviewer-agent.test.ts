import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { parse } from 'yaml';
import { withTestEnv } from '../integration/test-helpers.js';
import { buildReviewerAgentContent, reviewerDefinitionForPlatform } from './install-helpers.js';
import { FLOWGUARD_REVIEWER_EFFORT_ENV, FLOWGUARD_REVIEWER_MODEL_ENV } from './install-types.js';
import { REVIEWER_AGENT, CLAUDE_REVIEWER_AGENT, CODEX_REVIEWER_SUBAGENT } from './templates.js';

let restore: (() => void) | undefined;
beforeEach(() => {
  restore = withTestEnv({
    FLOWGUARD_REVIEWER_MODEL: undefined,
    FLOWGUARD_REVIEWER_EFFORT: undefined,
  });
});
afterEach(() => {
  restore?.();
});
function frontmatter(value: string): Record<string, unknown> {
  return parse(value.match(/^---\n([\s\S]*?)\n---/)![1]!);
}
describe('native reviewer selection: no model or effort allowlist', () => {
  it('retains host defaults when the removed effort variable contains only whitespace', () => {
    process.env.FLOWGUARD_REVIEWER_EFFORT = '  ';
    expect(buildReviewerAgentContent(REVIEWER_AGENT, 'opencode')).toBe(REVIEWER_AGENT);
  });
  it.each(['no-newline', 'no-frontmatter\nbody', '---\nnot closed'])(
    'rejects malformed tuned agent template %j instead of silently dropping selection',
    (template) => {
      process.env.FLOWGUARD_REVIEWER_MODEL = 'provider/model#variant';
      expect(() => buildReviewerAgentContent(template, 'opencode')).toThrow(
        /valid agent frontmatter/,
      );
    },
  );
  it('preserves an untuned non-agent string without manufacturing frontmatter', () => {
    expect(buildReviewerAgentContent('not an agent', 'opencode')).toBe('not an agent');
  });
  it.each(['provider/model\npermissions:', 'provider/model\rpermissions:'])(
    'reports injected newlines under the explicit rejection code: %j',
    (model) => {
      process.env.FLOWGUARD_REVIEWER_MODEL = model;
      try {
        buildReviewerAgentContent(REVIEWER_AGENT, 'opencode');
        expect.unreachable();
      } catch (error) {
        expect(error).toMatchObject({ code: 'REVIEWER_CONFIG_REJECTED' });
      }
    },
  );
  it.each([undefined, '', '   '])('leaves host defaults intact for empty model %j', (model) => {
    if (model !== undefined) process.env.FLOWGUARD_REVIEWER_MODEL = model;
    expect(buildReviewerAgentContent(REVIEWER_AGENT, 'opencode')).toBe(REVIEWER_AGENT);
    expect(frontmatter(REVIEWER_AGENT)).not.toHaveProperty('model');
  });
  it.each([
    'opencode/big-pickle',
    'openai/gpt-custom#xhigh',
    'local/unlisted/model#experimental-effort',
    '@provider/model',
    'org:team/model-v2#none',
    'new-provider/new-model#unlisted-variant',
  ])('preserves native model and variant %s exactly', (model) => {
    process.env.FLOWGUARD_REVIEWER_MODEL = `  ${model}  `;
    const content = buildReviewerAgentContent(REVIEWER_AGENT, 'opencode');
    expect(frontmatter(content).model).toBe(model);
    expect(content.slice(content.indexOf('\n---'))).toBe(
      REVIEWER_AGENT.slice(REVIEWER_AGENT.indexOf('\n---')),
    );
    expect(content).not.toMatch(/^reasoningEffort:|^effort:/m);
    expect(reviewerDefinitionForPlatform('opencode').content).toBe(content);
  });
  it.each([
    'model-without-provider',
    'bad-model\nhidden: false',
    'provider/model\rinjected: true',
    'provider/model with spaces',
    '$(whoami)',
    'provider/model#',
    'provider/model#one#two',
  ])('rejects malformed/injected native reference %j', (model) => {
    process.env.FLOWGUARD_REVIEWER_MODEL = model;
    expect(() => buildReviewerAgentContent(REVIEWER_AGENT, 'opencode')).toThrow();
    try {
      buildReviewerAgentContent(REVIEWER_AGENT, 'opencode');
    } catch (error) {
      expect(error).toHaveProperty('code');
    }
  });
  it.each([
    'none',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
    'unlisted',
    'HIGH',
    'high\ninjected: true',
  ])('rejects removed effort translation %j rather than silently changing reasoning', (effort) => {
    process.env.FLOWGUARD_REVIEWER_EFFORT = effort;
    expect(() => reviewerDefinitionForPlatform('opencode')).toThrow(/provider\/model#variant/);
    expect(() => reviewerDefinitionForPlatform('opencode')).toThrow(/FLOWGUARD_REVIEWER_EFFORT/);
  });
  it('keeps native permissions confined to the reviewer, not the build agent', () => {
    const config = frontmatter(REVIEWER_AGENT);
    expect(config.mode).toBe('subagent');
    expect(config.permissions).toEqual([
      { action: '*', resource: '*', effect: 'deny' },
      { action: 'read', resource: '*', effect: 'allow' },
      { action: 'flowguard_observe_repository', resource: '*', effect: 'allow' },
      { action: 'mcp__flowguard__flowguard_observe_repository', resource: '*', effect: 'allow' },
    ]);
    expect(config).not.toHaveProperty('permission');
    expect(config).not.toHaveProperty('temperature');
    expect(config).not.toHaveProperty('model');
  });
});
describe('other host tuning is unchanged', () => {
  it('trims explicit Claude effort while leaving omitted effort out of frontmatter', () => {
    process.env.FLOWGUARD_REVIEWER_EFFORT = ' high ';
    expect(
      frontmatter(buildReviewerAgentContent(CLAUDE_REVIEWER_AGENT, 'claude-code')).effort,
    ).toBe('high');
    process.env.FLOWGUARD_REVIEWER_EFFORT = '  ';
    expect(
      frontmatter(buildReviewerAgentContent(CLAUDE_REVIEWER_AGENT, 'claude-code')),
    ).not.toHaveProperty('effort');
  });
  it('reports the native-reference recovery only for OpenCode invalid model input', () => {
    process.env.FLOWGUARD_REVIEWER_MODEL = 'bad model';
    expect(() => buildReviewerAgentContent(REVIEWER_AGENT, 'opencode')).toThrow(
      'native provider/model#variant',
    );
    expect(() => buildReviewerAgentContent(CLAUDE_REVIEWER_AGENT, 'claude-code')).toThrow(
      'alphanumeric',
    );
  });
  it('preserves raw Claude frontmatter model syntax and reports both requested Codex knobs', () => {
    process.env.FLOWGUARD_REVIEWER_MODEL = 'claude-custom';
    expect(buildReviewerAgentContent(CLAUDE_REVIEWER_AGENT, 'claude-code')).toContain(
      '\nmodel: claude-custom\n',
    );
    expect(() => reviewerDefinitionForPlatform('codex')).toThrow('FLOWGUARD_REVIEWER_MODEL is set');
    process.env.FLOWGUARD_REVIEWER_EFFORT = 'high';
    expect(() => reviewerDefinitionForPlatform('codex')).toThrow(
      'FLOWGUARD_REVIEWER_MODEL and FLOWGUARD_REVIEWER_EFFORT are set',
    );
  });
  it('does not treat whitespace-only Codex tuning as an explicit override', () => {
    process.env.FLOWGUARD_REVIEWER_MODEL = '  ';
    process.env.FLOWGUARD_REVIEWER_EFFORT = '  ';
    expect(reviewerDefinitionForPlatform('codex').content).toBe(CODEX_REVIEWER_SUBAGENT);
  });
  it('keeps Claude model/effort in native frontmatter and preserves the body', () => {
    process.env.FLOWGUARD_REVIEWER_MODEL = 'claude-opus-custom';
    process.env.FLOWGUARD_REVIEWER_EFFORT = 'high';
    const content = buildReviewerAgentContent(CLAUDE_REVIEWER_AGENT, 'claude-code');
    expect(frontmatter(content)).toMatchObject({ model: 'claude-opus-custom', effort: 'high' });
    expect(content.slice(content.indexOf('\n---'))).toBe(
      CLAUDE_REVIEWER_AGENT.slice(CLAUDE_REVIEWER_AGENT.indexOf('\n---')),
    );
  });
  it.each(['HIGH', 'none', 'high\ninjected: true', '123'])(
    'rejects invalid Claude effort %j',
    (effort) => {
      process.env.FLOWGUARD_REVIEWER_EFFORT = effort;
      expect(() => reviewerDefinitionForPlatform('claude-code')).toThrow(/invalid value/);
    },
  );
  it('retains the static Codex subagent without tuning', () => {
    expect(reviewerDefinitionForPlatform('codex').content).toBe(CODEX_REVIEWER_SUBAGENT);
  });
  it.each([FLOWGUARD_REVIEWER_MODEL_ENV, FLOWGUARD_REVIEWER_EFFORT_ENV])(
    'rejects unsupported Codex tuning via %s',
    (key) => {
      process.env[key] = 'high';
      expect(() => reviewerDefinitionForPlatform('codex')).toThrow(
        /not supported for platform "codex"/,
      );
    },
  );
});

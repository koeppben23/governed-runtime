import { describe, expect, it } from 'vitest';
import { CLAUDE_REVIEWER_AGENT, CODEX_REVIEWER_SUBAGENT, REVIEWER_AGENT } from './mandates.js';
import { renderReviewerPrompt } from './mandates-reviewer-criteria.js';

describe('native reviewer templates', () => {
  it('renders Claude reviewer as transport-only with restricted tools', () => {
    expect(CLAUDE_REVIEWER_AGENT).toContain('name: flowguard-reviewer');
    expect(CLAUDE_REVIEWER_AGENT).toContain('mcp__flowguard__flowguard_review');
    expect(CLAUDE_REVIEWER_AGENT).toContain('Bash');
    expect(CLAUDE_REVIEWER_AGENT).toContain('transport/isolation artifacts only');
    expect(CLAUDE_REVIEWER_AGENT).toContain('validated, obligation-bound ReviewFindings');
  });

  it('renders Codex reviewer as transport-only with restricted tools', () => {
    expect(CODEX_REVIEWER_SUBAGENT).toContain('name: flowguard-reviewer');
    expect(CODEX_REVIEWER_SUBAGENT).toContain('mcp__flowguard__flowguard_review');
    expect(CODEX_REVIEWER_SUBAGENT).toContain('Write');
    expect(CODEX_REVIEWER_SUBAGENT).toContain('transport/isolation artifacts only');
    expect(CODEX_REVIEWER_SUBAGENT).toContain(
      'flowguard_decision is not independent review evidence',
    );
  });
});

describe('reviewer prompt JSON schema integrity', () => {
  it('OpenCode reviewer prompt contains a closed JSON Output Format block', () => {
    const prompt = renderReviewerPrompt('all');
    const outputFormatIdx = prompt.indexOf('## Output Format');
    expect(outputFormatIdx).toBeGreaterThan(-1);
    const rulesIdx = prompt.indexOf('## Rules', outputFormatIdx);
    expect(rulesIdx).toBeGreaterThan(-1);
    const schemaBlock = prompt.slice(outputFormatIdx, rulesIdx);

    const openBraces = (schemaBlock.match(/\{/g) ?? []).length;
    const closeBraces = (schemaBlock.match(/\}/g) ?? []).length;
    expect(openBraces).toBeGreaterThan(0);
    expect(openBraces).toBe(closeBraces);
    expect(schemaBlock).toContain('"overallVerdict"');
    expect(schemaBlock).toContain('"blockingIssues"');
    expect(schemaBlock).toContain('"attestation"');
  });

  it('static REVIEWER_AGENT export contains a closed JSON Output Format block', () => {
    const outputFormatIdx = REVIEWER_AGENT.indexOf('## Output Format');
    expect(outputFormatIdx).toBeGreaterThan(-1);
    const rulesIdx = REVIEWER_AGENT.indexOf('## Rules', outputFormatIdx);
    expect(rulesIdx).toBeGreaterThan(-1);
    const schemaBlock = REVIEWER_AGENT.slice(outputFormatIdx, rulesIdx);

    const openBraces = (schemaBlock.match(/\{/g) ?? []).length;
    const closeBraces = (schemaBlock.match(/\}/g) ?? []).length;
    expect(openBraces).toBeGreaterThan(0);
    expect(openBraces).toBe(closeBraces);
    expect(schemaBlock).toContain('"reviewedBy"');
  });
});

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { FLOWGUARD_MANDATES_BODY } from '../../templates/index.js';

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const AGENTS_PATH = path.join(PROJECT_ROOT, 'AGENTS.md');
const IMPLEMENTATION_GUIDE = path.join(PROJECT_ROOT, 'docs/agent-guidance/implementation.md');
const REVIEW_GUIDE = path.join(PROJECT_ROOT, 'docs/agent-guidance/review.md');
const HIGH_RISK_GUIDE = path.join(PROJECT_ROOT, 'docs/agent-guidance/high-risk.md');
const EVAL_SUITE_GUIDE = path.join(PROJECT_ROOT, 'docs/agent-guidance/eval-suite.md');
const MARISK_MAPPING_PATH = path.join(PROJECT_ROOT, 'docs/marisk-mapping.md');

async function readAgents(): Promise<string> {
  const content = await fs.readFile(AGENTS_PATH, 'utf-8');
  return content.replace(/\r\n/g, '\n');
}

function unwrapMarkdown(content: string): string {
  return content.replace(/\n\s+/g, ' ');
}

describe('repository AGENTS guidance', () => {
  describe('local contributor contract', () => {
    it('identifies root AGENTS.md as local contributor guidance', async () => {
      const content = await readAgents();

      expect(content).toContain('# Governed Runtime Contributor Notes');
      expect(content).toContain('working in this repository is not itself a');
      expect(content).toContain('FlowGuard-governed runtime session');
      expect(content).toContain('root `AGENTS.md` is local contributor guidance only');
    });

    it('forbids local AGENTS.md from triggering FlowGuard workflow commands', async () => {
      const content = await readAgents();
      const unwrapped = unwrapMarkdown(content);

      expect(content).toContain(
        'Do not call FlowGuard workflow tools merely because this file exists.',
      );
      expect(unwrapped).toContain(
        'unless the user explicitly asks you to exercise FlowGuard runtime behavior',
      );
      expect(content).not.toContain('You are operating under FlowGuard governance.');
      expect(content).not.toContain('Use only FlowGuard tools for state changes');
      expect(content).not.toContain('End every response with exactly one `Next action:` line');
    });

    it('points installed mandate authority at the product template', async () => {
      const content = await readAgents();
      const unwrapped = unwrapMarkdown(content);

      expect(content).toContain(
        'Installed FlowGuard agent mandates are owned by `src/templates/mandates.ts`.',
      );
      expect(unwrapped).toContain(
        'must not be used as the canonical source for installed mandate text',
      );
      expect(FLOWGUARD_MANDATES_BODY).toContain('# FlowGuard Agent Rules');
      expect(FLOWGUARD_MANDATES_BODY).toContain('You are operating under FlowGuard governance.');
    });

    it('keeps local engineering guidance explicit without product workflow gates', async () => {
      const content = await readAgents();

      expect(content).toContain(
        'Make the smallest correct change that satisfies the user request.',
      );
      expect(content).toContain(
        'Do not hide failures with silent fallbacks; surface errors explicitly.',
      );
      expect(content).toContain('Do not claim tests or verification passed unless they were run.');
      expect(content).toContain('Mark unexecuted or unproven claims as `NOT_VERIFIED`.');
      expect(content).toContain('docs/trust-boundaries.md');
    });
  });

  describe('guidance hygiene', () => {
    it('keeps root file concise enough for instruction loading', async () => {
      const content = await readAgents();
      const lines = content.split('\n').length;

      expect(lines).toBeGreaterThanOrEqual(25);
      // Budget recalibrated for Assumptions and Evidence section (PR #723).
      // 189 lines / 9428 chars as of 2026-07.
      expect(lines).toBeLessThanOrEqual(195);
      expect(content.length).toBeLessThanOrEqual(10000);
    });

    it('keeps guidance docs free of second mandatory output semantics', async () => {
      const files = [IMPLEMENTATION_GUIDE, REVIEW_GUIDE, HIGH_RISK_GUIDE, EVAL_SUITE_GUIDE];
      for (const file of files) {
        const content = await fs.readFile(file, 'utf-8');
        expect(content).not.toContain('Every implementation output MUST contain these sections');
      }
    });

    it('aligns review verdict enum in review guidance', async () => {
      const content = await fs.readFile(REVIEW_GUIDE, 'utf-8');
      expect(content).toContain('`approve` or `changes_requested`');
    });

    it('uses corrected marisk mapping filename and removes typo path', async () => {
      await expect(fs.access(MARISK_MAPPING_PATH)).resolves.not.toThrow();
      await expect(
        fs.access(path.join(PROJECT_ROOT, 'docs/maresg-mapping.md')),
      ).rejects.toBeTruthy();
    });

    it('contains eval suite rubric terms for pass/fail scoring', async () => {
      const content = await fs.readFile(EVAL_SUITE_GUIDE, 'utf-8');

      expect(content).toContain('## Scoring Rubric');
      expect(content).toContain('`PASS`');
      expect(content).toContain('`FAIL`');
      expect(content).toContain('Expected behavior');
      expect(content).toContain('Forbidden behavior');
    });
  });

  describe('agent contract completeness', () => {
    it('documents file-size budget (Tier 2)', async () => {
      const content = await readAgents();
      expect(content).toContain('750 LOC');
      expect(content).toContain('review blocker');
    });

    it('documents error handling conventions (Tier 2)', async () => {
      const content = await readAgents();
      expect(content).toContain('Use typed');
      expect(content).toContain('errors with a `code` field');
      expect(content).toContain('discriminated union pattern');
    });

    it('documents naming conventions (Tier 2)', async () => {
      const content = await readAgents();
      expect(content).toContain('kebab-case');
      expect(content).toContain('SCREAMING_SNAKE_CASE');
    });

    it('documents coverage thresholds (Tier 2)', async () => {
      const content = await readAgents();
      expect(content).toContain('80% across branches');
      expect(content).toContain('test:coverage:ci');
    });

    it('documents module boundary import rules (Tier 2)', async () => {
      const content = await readAgents();
      expect(content).toContain('import rules must stay aligned with');
      expect(content).toContain('Must not become a provider for lower layers');
      expect(content).toContain('must not derive runtime state');
      expect(content).toContain('diagnostic only');
    });

    it('documents PR metadata classification (Tier 2)', async () => {
      const content = await readAgents();
      expect(content).toContain('.github/PULL_REQUEST_TEMPLATE.md');
      expect(content).toContain('Touched Surface');
      expect(content).toContain('Risk Class');
    });

    it('lists all allowed commit types (Tier 2)', async () => {
      const content = await readAgents();
      for (const type of ['feat', 'fix', 'docs', 'test', 'refactor', 'chore', 'perf', 'ci']) {
        expect(content).toMatch(new RegExp(`\`${type}\``));
      }
    });
  });
});

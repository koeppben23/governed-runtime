import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { FLOWGUARD_MANDATES_BODY } from '../../templates/index.js';

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const AGENTS_PATH = path.join(PROJECT_ROOT, 'AGENTS.md');
const CONTRIBUTING_PATH = path.join(PROJECT_ROOT, 'CONTRIBUTING.md');
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

async function readAll(): Promise<string> {
  const agents = await readAgents();
  try {
    const contributing = await fs.readFile(CONTRIBUTING_PATH, 'utf-8');
    return agents + '\n' + contributing.replace(/\r\n/g, '\n');
  } catch {
    return agents;
  }
}

function readVerificationSection(): Promise<string> {
  return readAgents().then((content: string) => extractSection(content, 'Verification'));
}

function extractSection(content: string, heading: string): string {
  const start = content.indexOf(`## ${heading}`);
  if (start === -1) throw new Error(`Missing section: ${heading}`);
  const rest = content.slice(start);
  const next = rest.slice(3).search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next + 3);
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
      expect(unwrapped).toContain('product behavior to inspect or modify');
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
        'MUST NOT be used as the canonical source for installed mandate text',
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
      expect(content).toContain('`ASSUMPTION`');
      expect(content).toContain('CONTRIBUTING.md');
    });
  });

  describe('guidance hygiene', () => {
    it('keeps root file concise enough for instruction loading', async () => {
      const content = await readAgents();
      const lines = content.split('\n').length;

      expect(lines).toBeGreaterThanOrEqual(25);
      // Stable conciseness budget for root AGENTS.md after restructuring
      // (PR #723). Area-specific details moved to src/{machine,config,integration}/.
      // 187 lines / 8635 chars as of 2026-07.
      expect(lines).toBeLessThanOrEqual(195);
      expect(content.length).toBeLessThanOrEqual(9000);
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
      const content = await readAll();
      expect(content).toContain('750 LOC');
      expect(content).toContain('review blocker');
    });

    it('documents error handling conventions (Tier 2)', async () => {
      const content = await readAll();
      expect(content).toContain('Use typed');
      expect(content).toContain('errors with a `code` field');
      expect(content).toContain('discriminated union pattern');
    });

    it('documents naming conventions (Tier 2)', async () => {
      const content = await readAll();
      expect(content).toContain('kebab-case');
      expect(content).toContain('SCREAMING_SNAKE_CASE');
    });

    it('documents coverage thresholds (Tier 2)', async () => {
      const content = await readAll();
      expect(content).toContain('80% across branches');
      expect(content).toContain('test:coverage');
    });

    it('documents module boundary import rules (Tier 2)', async () => {
      const content = await readAll();
      expect(content).toContain('Import rules must stay aligned with');
      expect(content).toContain('Layer');
    });

    it('documents PR metadata classification (Tier 2)', async () => {
      const content = await readAll();
      expect(content).toContain('.github/PULL_REQUEST_TEMPLATE.md');
      expect(content).toContain('Touched Surface');
      expect(content).toContain('Risk Class');
    });

    it('lists all allowed commit types (Tier 2)', async () => {
      const content = await readAll();
      for (const type of ['feat', 'fix', 'docs', 'test', 'refactor', 'chore', 'perf', 'ci']) {
        expect(content).toMatch(new RegExp(`\`${type}\``));
      }
    });
  });

  describe('Assumptions and Evidence contract (PR #723)', () => {
    it('defines contributor evidence markers', async () => {
      const content = await readAgents();

      expect(content).toContain('`ASSUMPTION`: necessary and plausible');
      expect(content).toContain('`NOT_VERIFIED`: a concrete verification step');
      expect(content).toContain('`BLOCKED`: safe implementation cannot continue');
    });

    it('separates plan assumptions from implementation', async () => {
      const content = await readAgents();
      const unwrapped = unwrapMarkdown(content);

      expect(unwrapped).toContain('Do not present assumptions as established facts');
      expect(content).toContain(
        'Do not implement behavior that depends on an unresolved high-risk assumption.',
      );
    });

    it('prohibits encoding unverified assumptions into contracts', async () => {
      const content = await readAgents();

      expect(content).toContain(
        'Do not encode unverified assumptions into contracts, schemas, state',
      );
    });

    it('requires minimum clarification or BLOCKED for high-risk ambiguity', async () => {
      const content = await readAgents();
      const unwrapped = unwrapMarkdown(content);

      expect(unwrapped).toContain('clarification when the host supports interaction');
      expect(content).toContain('`BLOCKED`');
    });
  });

  describe('area-specific guidance (PR #723)', () => {
    it('links layer-specific AGENTS.md files from root', async () => {
      const content = await readAgents();

      expect(content).toContain('`src/machine/AGENTS.md`');
      expect(content).toContain('`src/config/AGENTS.md`');
      expect(content).toContain('`src/integration/AGENTS.md`');
    });

    it('warns that area files are local guidance, not product mandates', async () => {
      const content = await readAgents();

      expect(content).toContain('For layer-specific rules, follow the nearest applicable');
    });

    it('src/machine/AGENTS.md exists and documents its authority', async () => {
      const content = await fs.readFile(path.join(PROJECT_ROOT, 'src/machine/AGENTS.md'), 'utf-8');

      expect(content).toContain('canonical authority');
      expect(content).toContain('guard evaluation');
    });

    it('src/config/AGENTS.md exists and documents its authority', async () => {
      const content = await fs.readFile(path.join(PROJECT_ROOT, 'src/config/AGENTS.md'), 'utf-8');

      expect(content).toContain('canonical authority');
      expect(content).toContain('reason codes');
    });

    it('src/integration/AGENTS.md exists and documents its boundary', async () => {
      const content = await fs.readFile(
        path.join(PROJECT_ROOT, 'src/integration/AGENTS.md'),
        'utf-8',
      );

      expect(content).toContain('consumes canonical authorities');
      expect(content).toContain('must never become a provider');
    });
  });

  describe('CLAUDE.md bridge (PR #723)', () => {
    it('imports root AGENTS.md via @AGENTS.md', async () => {
      const content = await fs.readFile(path.join(PROJECT_ROOT, 'CLAUDE.md'), 'utf-8');

      expect(content.replace(/\r\n/g, '\n').split('\n')[0]).toBe('@AGENTS.md');
    });

    it('does not duplicate rules from AGENTS.md', async () => {
      const content = await fs.readFile(path.join(PROJECT_ROOT, 'CLAUDE.md'), 'utf-8');

      expect(content).not.toContain('ASSUMPTION');
      expect(content).not.toContain('BLOCKED');
      expect(content).not.toContain('canonical authority');
      expect(content).not.toContain('npm run lint:strict');
    });

    it.each(['machine', 'config', 'integration'])(
      'provides a Claude Code bridge for src/%s',
      async (layer) => {
        const content = await fs.readFile(
          path.join(PROJECT_ROOT, `src/${layer}/CLAUDE.md`),
          'utf-8',
        );

        expect(content.replace(/\r\n/g, '\n').trim()).toBe('@AGENTS.md');
      },
    );
  });

  describe('verification contract (PR B)', () => {
    it('defines the seven-step verification selection contract', async () => {
      const section = await readVerificationSection();
      for (let step = 1; step <= 7; step += 1) {
        expect(section).toMatch(new RegExp(`^${step}\\. `, 'm'));
      }
      expect(section).not.toMatch(/^8\. /m);
    });

    it('prescribes type checking for TypeScript changes', async () => {
      const section = await readVerificationSection();
      expect(section).toMatch(/Run `npm run check` for TypeScript changes\./);
    });

    it('prescribes linting for TypeScript changes', async () => {
      const section = await readVerificationSection();
      expect(section).toMatch(/Run `npm run lint:strict` for TypeScript changes\./);
    });

    it('prescribes architecture test for boundary changes', async () => {
      const section = await readVerificationSection();
      expect(section).toContain('`npm run test:architecture`');
      expect(section).toMatch(/imports, exports, file placement,[\s\S]*layer boundaries change/);
    });

    it('requires cumulative nested verification', async () => {
      const section = await readVerificationSection();
      expect(section).toContain('additional verification from every applicable nested');
    });

    it('requires explicit evidence for unexecuted checks', async () => {
      const section = await readVerificationSection();
      expect(section).toMatch(/Mark every relevant check not run as `NOT_VERIFIED`/);
    });

    it('defines the completion report', async () => {
      const section = await readVerificationSection();
      expect(section).toMatch(/executed checks and\s+outcomes/);
      expect(section).toMatch(/remaining assumptions or\s+blockers/);
      expect(section).toContain('Omit empty categories');
    });

    it('implementation.md defers to root verification contract', async () => {
      const content = await fs.readFile(IMPLEMENTATION_GUIDE, 'utf-8');
      expect(content).toMatch(/`AGENTS\.md` is the canonical verification-selection\s+contract/);
      expect(content).toContain('This guide does not define a separate verification matrix');
    });
  });
});

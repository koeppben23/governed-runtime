import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const AGENTS_PATH = path.join(PROJECT_ROOT, 'AGENTS.md');
const IMPLEMENTATION_GUIDE = path.join(PROJECT_ROOT, 'docs/agent-guidance/implementation.md');
const REVIEW_GUIDE = path.join(PROJECT_ROOT, 'docs/agent-guidance/review.md');
const HIGH_RISK_GUIDE = path.join(PROJECT_ROOT, 'docs/agent-guidance/high-risk.md');
const EVAL_SUITE_GUIDE = path.join(PROJECT_ROOT, 'docs/agent-guidance/eval-suite.md');
const MARISK_MAPPING_PATH = path.join(PROJECT_ROOT, 'docs/marisk-mapping.md');

async function readAgents(): Promise<string> {
  return fs.readFile(AGENTS_PATH, 'utf-8');
}

describe('AGENTS v3 guidance', () => {
  describe('HAPPY path', () => {
    it('contains the v3 section structure and single mission statement', async () => {
      const content = await readAgents();
      expect(content).toContain('# FlowGuard Agent Rules');
      expect(content).toContain('## 1. Mission');
      expect(content).toContain('## Language Conventions');
      expect(content).toContain('## 2. Priority Ladder');
      expect(content).toContain('## 3. Task Class Router');
      expect(content).toContain('## 8. Output Contract');
      expect(content).toContain('## 12. Extended Guidance');
    });

    it('keeps explicit requirement-language definitions', async () => {
      const content = await readAgents();
      expect(content).toContain('`MUST` / `MUST NOT`');
      expect(content).toContain('`SHOULD` / `SHOULD NOT`');
      expect(content).toContain('Evidence: concrete artifact');
    });

    it('defines exactly one output contract section', async () => {
      const content = await readAgents();
      const outputContractCount = (content.match(/^## .*Output Contract$/gm) || []).length;
      expect(outputContractCount).toBe(1);
      expect(content).toContain('Use one output contract, scaled by task class:');
    });
  });

  describe('BAD path', () => {
    it('removes legacy duplicate sections from the old mandate layout', async () => {
      const content = await readAgents();
      expect(content).not.toContain('## 1. Developer Mandate');
      expect(content).not.toContain('## 2. Review Mandate');
      expect(content).not.toContain('## 3. Output Quality Contract');
      expect(content).not.toContain('### Developer Output Contract');
    });

    it('keeps hard conflict resolution explicit', async () => {
      const content = await readAgents();
      expect(content).toContain('Higher-priority rules override lower-priority rules.');
    });

    it('keeps root mandates strictly operational', async () => {
      const content = await readAgents();
      expect(content).not.toContain('## Alignment Notes');
    });
  });

  describe('CORNER path', () => {
    it('defines status markers with strict names', async () => {
      const content = await readAgents();
      expect(content).toContain('`ASSUMPTION`');
      expect(content).toContain('`NOT_VERIFIED`');
      expect(content).toContain('`BLOCKED`');
      expect(content).not.toContain('UNVERIFIED');
    });

    it('includes HIGH-RISK trigger surfaces in task router', async () => {
      const content = await readAgents();
      expect(content).toContain('state or session lifecycle');
      expect(content).toContain('policy or risk logic');
      expect(content).toContain('audit or hash-chain');
      expect(content).toContain('release or installer');
      expect(content).toContain('security trust boundaries');
    });

    it('contains explicit before-acting behavior', async () => {
      const content = await readAgents();
      expect(content).toContain('## Before Acting Rule');
      expect(content).toContain('Do not start editing immediately.');
    });

    it('balances positive invariants with explicit red lines', async () => {
      const content = await readAgents();
      expect(content).toContain('## 4. Hard Invariants');
      expect(content).toContain('Use the smallest safe change.');
      expect(content).toContain('Preserve one canonical authority and SSOT ownership.');
      expect(content).toContain('## Red Lines');
      expect(content).toContain('Do not hide failures with silent fallbacks.');
      expect(content).toContain('Do not create duplicate runtime authority.');
    });
  });

  describe('EDGE path', () => {
    it('keeps root file concise enough for high-signal instruction loading', async () => {
      const content = await readAgents();
      const lines = content.split('\n').length;
      expect(lines).toBeGreaterThanOrEqual(120);
      expect(lines).toBeLessThanOrEqual(220);
    });

    it('preserves release and installer verification strictness', async () => {
      const content = await readAgents();
      expect(content).toContain(
        'RELEASE or INSTALLER changes: exact generated artifact install-verify is required.',
      );
      expect(content).toContain('`npm run check`');
      expect(content).toContain('`npm run lint`');
      expect(content).toContain('`npm test`');
      expect(content).toContain('`npm run build`');
      expect(content).toContain('`npm run test:install-verify`');
    });
  });

  describe('E2E path', () => {
    it('links all extended guidance documents and those files exist', async () => {
      const content = await readAgents();
      const links = [
        'docs/agent-guidance/implementation.md',
        'docs/agent-guidance/review.md',
        'docs/agent-guidance/high-risk.md',
        'docs/agent-guidance/eval-suite.md',
      ];
      for (const link of links) {
        expect(content).toContain(link);
      }

      await expect(fs.access(IMPLEMENTATION_GUIDE)).resolves.not.toThrow();
      await expect(fs.access(REVIEW_GUIDE)).resolves.not.toThrow();
      await expect(fs.access(HIGH_RISK_GUIDE)).resolves.not.toThrow();
      await expect(fs.access(EVAL_SUITE_GUIDE)).resolves.not.toThrow();
    });

    it('keeps guidance docs free of second mandatory output semantics', async () => {
      const files = [IMPLEMENTATION_GUIDE, REVIEW_GUIDE, HIGH_RISK_GUIDE, EVAL_SUITE_GUIDE];
      for (const file of files) {
        const content = await fs.readFile(file, 'utf-8');
        expect(content).not.toContain('Every implementation output MUST contain these sections');
      }
    });

    it('aligns review verdict enum between root and review guidance', async () => {
      const content = await fs.readFile(REVIEW_GUIDE, 'utf-8');
      expect(content).toContain('`approve` or `changes_requested`');
    });
  });

  describe('SMOKE path', () => {
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

    it('includes review verdict schema in the single output contract', async () => {
      const content = await readAgents();
      expect(content).toContain('For review tasks (any class), include:');
      expect(content).toContain('Verdict: `approve` or `changes_requested`.');
      expect(content).toContain(
        'Findings with: severity, type, location, evidence, impact, and smallest fix.',
      );
    });
  });
});

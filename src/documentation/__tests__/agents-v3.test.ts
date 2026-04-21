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
  const content = await fs.readFile(AGENTS_PATH, 'utf-8');
  // Normalize line endings for cross-platform regex matching
  return content.replace(/\r\n/g, '\n');
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

    it('contains Before Completing Rule as counterpart to Before Acting Rule', async () => {
      const content = await readAgents();
      expect(content).toContain('## Before Acting Rule');
      expect(content).toContain('## Before Completing Rule');
      // Before Completing must appear after Before Acting
      const actingIdx = content.indexOf('## Before Acting Rule');
      const completingIdx = content.indexOf('## Before Completing Rule');
      expect(completingIdx).toBeGreaterThan(actingIdx);
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

    it('no orphaned red lines without WHY-context or positive alternative', async () => {
      const content = await readAgents();
      // Extract the Red Lines section (between ## Red Lines and next ## heading)
      const redLinesMatch = content.match(/## Red Lines\n([\s\S]*?)(?=\n## )/);
      expect(redLinesMatch).not.toBeNull();
      const redLinesSection = redLinesMatch![1];
      // Every primary red line (starts with "- Do not") must have "because" and "Instead:"
      const primaryRedLines = redLinesSection.split('\n').filter((l) => l.startsWith('- Do not'));
      expect(primaryRedLines.length).toBeGreaterThanOrEqual(4);
      for (const line of primaryRedLines) {
        // Example lines (under "Examples:") won't have "because" — only check primary rules
        if (redLinesSection.indexOf(line) < redLinesSection.indexOf('Examples:')) {
          expect(line).toContain('because');
        }
      }
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
      expect(content).toContain('Do not hide failures with silent fallbacks');
      expect(content).toContain('Do not create duplicate runtime authority');
    });

    it('red lines include WHY-context for generalization', async () => {
      const content = await readAgents();
      // Each primary red line must explain WHY to enable correct generalization
      expect(content).toContain('because hidden failures corrupt downstream state');
      expect(content).toContain(
        'because conflicting authorities cause non-deterministic decisions',
      );
      expect(content).toContain('because open-fail modes allow untested behavior to pass');
      expect(content).toContain('because unverified claims break the evidence chain');
    });

    it('red lines include positive alternatives', async () => {
      const content = await readAgents();
      // Each primary red line must have an "Instead:" with the correct fail-closed behavior
      expect(content).toContain(
        'Instead: surface errors explicitly, return BLOCKED or an explicit failure, and stop.',
      );
      expect(content).toContain('Instead: extend the existing canonical authority.');
      expect(content).toContain(
        'Instead: keep default deny and require an explicit validated allow-path.',
      );
      expect(content).toContain('Instead: mark unverified claims as `NOT_VERIFIED`.');
    });

    it('hard invariants and red lines declare explicit scope', async () => {
      const content = await readAgents();
      // Scope must be explicit to avoid ambiguity across task classes
      const hardInvariantsMatch = content.match(/## 4\. Hard Invariants\n([\s\S]*?)(?=\n## )/);
      expect(hardInvariantsMatch).not.toBeNull();
      expect(hardInvariantsMatch![1]).toContain('across all task classes');

      const redLinesMatch = content.match(/## Red Lines\n([\s\S]*?)(?=\n## )/);
      expect(redLinesMatch).not.toBeNull();
      expect(redLinesMatch![1]).toContain('across all task classes');
    });

    it('evidence markers declare explicit scope', async () => {
      const content = await readAgents();
      const evidenceMatch = content.match(/## 5\. Evidence Rules\n([\s\S]*?)(?=\n## )/);
      expect(evidenceMatch).not.toBeNull();
      expect(evidenceMatch![1]).toContain('across all task classes');
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

    it('before completing rule covers all required self-check items', async () => {
      const content = await readAgents();
      const completingMatch = content.match(/## Before Completing Rule\n([\s\S]*?)(?=\n## )/);
      expect(completingMatch).not.toBeNull();
      const section = completingMatch![1];
      // Must cover all 4 self-check dimensions before returning a final result
      expect(section).toContain('output contract');
      expect(section).toContain('evidence markers');
      expect(section).toContain('verification');
      expect(section).toContain('SSOT drift');
    });

    it('before completing rule references all three evidence marker names', async () => {
      const content = await readAgents();
      const completingMatch = content.match(/## Before Completing Rule\n([\s\S]*?)(?=\n## )/);
      expect(completingMatch).not.toBeNull();
      const section = completingMatch![1];
      expect(section).toContain('ASSUMPTION');
      expect(section).toContain('NOT_VERIFIED');
      expect(section).toContain('BLOCKED');
    });
  });

  describe('E2E path', () => {
    it('is self-contained without dead links', async () => {
      const content = await readAgents();
      expect(content).toContain('This document is self-contained');
      expect(content).toContain('docs/ directory');
      expect(content).not.toContain('docs/agent-guidance/');
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

    it('has no duplicate section headings from edit artifacts', async () => {
      const content = await readAgents();
      const headings = content.match(/^## .+$/gm) || [];
      const unique = new Set(headings);
      expect(headings.length).toBe(unique.size);
    });

    it('red line count matches between prohibition rules and positive alternatives', async () => {
      const content = await readAgents();
      const redLinesMatch = content.match(/## Red Lines\n([\s\S]*?)(?=\nExamples:)/);
      expect(redLinesMatch).not.toBeNull();
      const section = redLinesMatch![1];
      const prohibitions = (section.match(/^- Do not /gm) || []).length;
      const alternatives = (section.match(/^\s+Instead: /gm) || []).length;
      expect(prohibitions).toBe(alternatives);
      expect(prohibitions).toBeGreaterThanOrEqual(4);
    });
  });

  describe('PERF path', () => {
    it('stays within token budget ceiling for instruction loading', async () => {
      const content = await readAgents();
      // Approximate token count: ~1 token per 4 characters for English prose
      // Baseline: ~6000 chars (~1500 tokens), hardening added ~1000 chars (~250 tokens)
      // Budget ceiling: 8000 chars (~2000 tokens) — guards against runaway bloat
      const charCount = content.length;
      expect(charCount).toBeLessThanOrEqual(8000);
      // Floor: must contain enough content to be a meaningful governance document
      expect(charCount).toBeGreaterThanOrEqual(4000);
    });
  });
});

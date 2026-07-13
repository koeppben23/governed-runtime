/**
 * @module mandate-drift.test
 * @description Authority invariant: installed FlowGuard mandate text is owned by
 * FLOWGUARD_MANDATES_BODY. The repository root AGENTS.md is local contributor
 * guidance only and must not become the canonical source for installed mandates.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FLOWGUARD_MANDATES_BODY, REVIEWER_AGENT } from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

const AGENTS_MD = readFileSync(join(REPO_ROOT, 'AGENTS.md'), 'utf-8').replace(/\r\n/g, '\n');

const VERSION_FOOTER = '\n\n---\n\n[End of v4 Agent Rules]';
const MANDATES_BASE = FLOWGUARD_MANDATES_BODY.replace(VERSION_FOOTER, '');

const MANDATE_SECTIONS: readonly string[] = [
  '## 1. Mission',
  '## Red Lines',
  '## 2. Priority Ladder',
  '## Language Conventions',
  '## 3. Task Class Router',
  '## 4. Hard Invariants',
  '## 5. Evidence Rules',
  '## 6. Tool and Verification Policy',
  '## 7. Ambiguity Policy',
  '## 8. Output Contract',
  '## 9. Implementation Checklist',
  '## 10. Review Checklist',
  '## 11. High-Risk Extension',
  '## 11a. Tool Error Classification',
  '## 11b. Rule Conflict Resolution',
  '## Governance rules',
  '## 12. Extended Guidance',
  '## Before Acting Rule',
  '## Before Completing Rule',
];

const REVIEWER_ONLY_SECTIONS: readonly string[] = [
  '## Your Role',
  '## Review Approach',
  '## Review Criteria',
  '## Content Review (for /review flow)',
  '## When You Cannot Review (Validity Conditions)',
  '## Output Format',
  '## Rules',
];

describe('mandate authority guard', () => {
  it('keeps installed mandates in FLOWGUARD_MANDATES_BODY', () => {
    expect(FLOWGUARD_MANDATES_BODY).toContain('# FlowGuard Agent Rules');
    expect(FLOWGUARD_MANDATES_BODY).toContain('You are operating under FlowGuard governance.');
    expect(FLOWGUARD_MANDATES_BODY).toContain('[End of v4 Agent Rules]');
  });

  it('keeps all installed mandate sections ordered in FLOWGUARD_MANDATES_BODY', () => {
    const positions = MANDATE_SECTIONS.map((section) => MANDATES_BASE.indexOf(section));

    for (const [index, position] of positions.entries()) {
      expect(position, `Expected mandate section "${MANDATE_SECTIONS[index]}"`).toBeGreaterThan(-1);
      if (index > 0) {
        const previousPosition = positions[index - 1];
        if (previousPosition === undefined)
          throw new TypeError('missing previous mandate position');
        expect(
          position,
          `Expected "${MANDATE_SECTIONS[index]}" after previous section`,
        ).toBeGreaterThan(previousPosition);
      }
    }
  });

  it('keeps root AGENTS.md local and non-governing for repository edits', () => {
    expect(AGENTS_MD).toContain('Governed Runtime Contributor Notes');
    expect(AGENTS_MD).toContain(
      'Do not call FlowGuard workflow tools merely because this file exists.',
    );
    expect(AGENTS_MD).toContain('root `AGENTS.md` is local contributor guidance only');
    expect(AGENTS_MD).not.toContain('You are operating under FlowGuard governance.');
    expect(AGENTS_MD).not.toContain('Use only FlowGuard tools for state changes');
    expect(AGENTS_MD).not.toContain('[End of v4 Agent Rules]');
  });

  it('keeps reviewer-only sections out of root AGENTS.md and installed mandates', () => {
    for (const section of REVIEWER_ONLY_SECTIONS) {
      expect(AGENTS_MD.includes(section), `AGENTS.md must not contain "${section}"`).toBe(false);
      expect(
        FLOWGUARD_MANDATES_BODY.includes(section),
        `FLOWGUARD_MANDATES_BODY must not contain "${section}"`,
      ).toBe(false);
      expect(REVIEWER_AGENT.includes(section), `REVIEWER_AGENT must contain "${section}"`).toBe(
        true,
      );
    }
  });

  it('does not require root AGENTS.md to mirror installed mandate sections', () => {
    const agentsH2 = AGENTS_MD.match(/^## /gm) ?? [];
    const mandatesH2 = MANDATES_BASE.match(/^## /gm) ?? [];

    expect(agentsH2.length).toBeLessThan(mandatesH2.length);
    expect(mandatesH2.length).toBe(19);
  });
});

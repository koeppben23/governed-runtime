/**
 * @module mandate-drift.test
 * @description Governance invariant: shared base sections between AGENTS.md and
 * FLOWGUARD_MANDATES_BODY must remain content-aligned. Reviewer-specific
 * extensions (Your Role, Review Criteria, etc.) live in REVIEWER_AGENT and
 * must NOT leak into AGENTS.md.
 *
 * P9b: AGENTS.md is the canonical developer rule source. FLOWGUARD_MANDATES_BODY
 * extends it with installed runtime mandate sections (11a, 11b) and a version
 * footer. REVIEWER_AGENT adds reviewer-specific sections. Shared base sections
 * (## 1 through ## 12) must not drift.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FLOWGUARD_MANDATES_BODY, REVIEWER_AGENT } from './index.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

const AGENTS_MD = readFileSync(join(REPO_ROOT, 'AGENTS.md'), 'utf-8').replace(/\r\n/g, '\n');

/**
 * Version footer appended to FLOWGUARD_MANDATES_BODY after the shared sections.
 * This is NOT part of AGENTS.md but is a runtime installation marker.
 */
const VERSION_FOOTER = '\n\n---\n\n[End of v3 Agent Rules]';

/**
 * Strip the version footer from mandates body for section comparison.
 */
const MANDATES_BASE = FLOWGUARD_MANDATES_BODY.replace(VERSION_FOOTER, '');

/**
 * Sections shared between AGENTS.md and FLOWGUARD_MANDATES_BODY.
 * Ordered as they appear. Every entry here must be present in BOTH documents
 * with identical content.
 */
const SHARED_SECTIONS: readonly string[] = [
  '## 1. Mission',
  '## Language Conventions',
  '## 2. Priority Ladder',
  '## 3. Task Class Router',
  '## 4. Hard Invariants',
  '## Red Lines',
  '## Before Acting Rule',
  '## Before Completing Rule',
  '## 5. Evidence Rules',
  '## 6. Tool and Verification Policy',
  '## 7. Ambiguity Policy',
  '## 8. Output Contract',
  '## 9. Implementation Checklist',
  '## 10. Review Checklist',
  '## 11. High-Risk Extension',
  '## 12. Extended Guidance',
];

/** Runtime-only extensions in FLOWGUARD_MANDATES_BODY (not in AGENTS.md). */
const MANDATES_EXTENSION_SECTIONS: readonly string[] = [
  '## 11a. Tool Error Classification',
  '## 11b. Rule Conflict Resolution',
];

/** Reviewer-specific sections — belong in REVIEWER_AGENT, NOT in AGENTS.md. */
const REVIEWER_ONLY_SECTIONS: readonly string[] = [
  '## Your Role',
  '## Review Approach',
  '## Review Criteria',
  '## Content Review (for /review flow)',
  '## When You Cannot Review (Validity Conditions)',
  '## Output Format',
  '## Rules',
];

/**
 * Extract the content of a ``##`` section from a markdown body.
 *
 * Finds the heading, then captures everything until the next ``##`` heading
 * (or EOF). ``###`` subsections within a ``##`` section are included.
 */
function extractSection(body: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped}\\s*$`, 'm');
  const match = body.match(pattern);
  if (!match || match.index === undefined) {
    throw new Error(`Section "${heading}" not found in body`);
  }
  const start = match.index;
  const headingLen = match[0].length;
  const afterHeading = body.slice(start + headingLen);
  const nextHeading = afterHeading.match(/^## /m);
  const end = nextHeading ? start + headingLen + nextHeading.index! : body.length;
  return body.slice(start, end).trim();
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('P9b: mandate drift guard', () => {
  // ── HAPPY: shared base sections content-match ────────────────────────────

  describe('HAPPY — shared base sections', () => {
    for (const section of SHARED_SECTIONS) {
      it(`"${section}" matches between AGENTS.md and FLOWGUARD_MANDATES_BODY`, () => {
        const agents = extractSection(AGENTS_MD, section);
        const mandates = extractSection(MANDATES_BASE, section);
        expect(mandates).toBe(agents);
      });
    }
  });

  // ── HAPPY: mandates has runtime extensions (11a, 11b) ────────────────────

  it('FLOWGUARD_MANDATES_BODY contains runtime extension sections', () => {
    for (const section of MANDATES_EXTENSION_SECTIONS) {
      expect(
        FLOWGUARD_MANDATES_BODY.includes(section),
        `Expected mandates to contain "${section}"`,
      ).toBe(true);
    }
  });

  // ── HAPPY: REVIEWER_AGENT contains reviewer-specific sections ─────────────

  it('REVIEWER_AGENT contains reviewer-specific sections', () => {
    for (const section of REVIEWER_ONLY_SECTIONS) {
      expect(
        REVIEWER_AGENT.includes(section),
        `Expected REVIEWER_AGENT to contain "${section}"`,
      ).toBe(true);
    }
  });

  // ── BAD: reviewer sections must NOT leak into AGENTS.md ──────────────────

  describe('BAD — reviewer section isolation', () => {
    for (const section of REVIEWER_ONLY_SECTIONS) {
      it(`AGENTS.md must NOT contain reviewer section "${section}"`, () => {
        expect(
          AGENTS_MD.includes(section),
          `AGENTS.md must not contain reviewer section "${section}"`,
        ).toBe(false);
      });
    }
  });

  // ── BAD: runtime extensions must NOT leak into AGENTS.md ─────────────────

  describe('BAD — runtime extension isolation', () => {
    for (const section of MANDATES_EXTENSION_SECTIONS) {
      it(`AGENTS.md must NOT contain runtime extension "${section}"`, () => {
        expect(
          AGENTS_MD.includes(section),
          `AGENTS.md must not contain runtime extension "${section}"`,
        ).toBe(false);
      });
    }
  });

  // ── CORNER: section ordering is preserved ────────────────────────────────

  it('shared sections appear in the same order in both documents', () => {
    const agentsOrder = SHARED_SECTIONS.map((s) => AGENTS_MD.indexOf(s));
    const mandatesOrder = SHARED_SECTIONS.map((s) => MANDATES_BASE.indexOf(s));
    for (let i = 1; i < agentsOrder.length; i++) {
      expect(
        agentsOrder[i],
        `AGENTS.md: "${SHARED_SECTIONS[i]}" must appear after "${SHARED_SECTIONS[i - 1]}"`,
      ).toBeGreaterThan(agentsOrder[i - 1]);
    }
    for (let i = 1; i < mandatesOrder.length; i++) {
      expect(
        mandatesOrder[i],
        `FLOWGUARD_MANDATES_BODY: "${SHARED_SECTIONS[i]}" must appear after "${SHARED_SECTIONS[i - 1]}"`,
      ).toBeGreaterThan(mandatesOrder[i - 1]);
    }
  });

  // ── EDGE: section count consistency ──────────────────────────────────────

  it('AGENTS.md has exactly 16 base sections', () => {
    const agentsH2 = AGENTS_MD.match(/^## /gm) ?? [];
    expect(agentsH2.length).toBe(16);
  });

  it('FLOWGUARD_MANDATES_BODY has exactly 18 base sections (16 shared + 2 extensions)', () => {
    const mandatesH2 = MANDATES_BASE.match(/^## /gm) ?? [];
    expect(mandatesH2.length).toBe(18);
  });
});

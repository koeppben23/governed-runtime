/**
 * @module documentation/__tests__/review-capabilities-doc-drift
 * @description Drift guard for review capability docs against runtime SSOTs.
 *
 * Pins the review-related product documentation to the current runtime
 * capabilities (obligation-bound /review, review cards, host-orchestrated
 * content analysis, artifact persistence). Future edits that silently
 * remove or contradict these capabilities will fail.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 * @version v1
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

function readDoc(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf-8');
}

function unreleasedSection(): string {
  const marker = '## [Unreleased]\n';
  const afterMarker = readDoc('CHANGELOG.md').split(marker)[1];
  expect(afterMarker, 'CHANGELOG.md must contain an [Unreleased] section').toBeTruthy();
  return afterMarker!.split(/\n## \[/)[0];
}

describe('documentation/review-capabilities-doc-drift', () => {
  // =========================================================================
  // HAPPY — CHANGELOG documents current review capabilities
  // =========================================================================
  describe('HAPPY — CHANGELOG documents review capabilities', () => {
    it('Unreleased mentions obligation-bound /review (P2)', () => {
      const section = unreleasedSection();
      expect(section).toContain('ReviewObligation');
      expect(section).toContain('obligationType');
      expect(section).toContain('review');
    });

    it('Unreleased mentions invocation evidence (P3)', () => {
      expect(unreleasedSection()).toContain('ReviewInvocationEvidence');
    });

    it('Unreleased mentions host-orchestrated /review (P4)', () => {
      const section = unreleasedSection();
      expect(section).toContain('CONTENT_ANALYSIS_REQUIRED');
      expect(section).toContain('pluginReviewFindings');
    });

    it('Unreleased mentions review cards (P5)', () => {
      const section = unreleasedSection();
      expect(section).toContain('Review Report Card');
      expect(section).toContain('Architecture Review Card');
    });

    it('Unreleased mentions card artifact persistence (P6)', () => {
      expect(unreleasedSection()).toContain('sourceStateHash');
    });

    it('Unreleased mentions fix correctness (P0/P1)', () => {
      const section = unreleasedSection();
      expect(section).toContain('SUBAGENT_FINDINGS_VERDICT_MISMATCH');
    });

    it('Unreleased mentions MAX_REVIEW_ITERATIONS_REACHED', () => {
      expect(unreleasedSection()).toContain('MAX_REVIEW_ITERATIONS_REACHED');
    });
  });

  // =========================================================================
  // HAPPY — README documents content-aware /review
  // =========================================================================
  describe('HAPPY — README documents content-aware /review', () => {
    it('describes content-aware review flow with prNumber and analysisFindings', () => {
      const readme = readDoc('README.md');
      expect(readme).toContain('prNumber');
      expect(readme).toContain('analysisFindings');
      expect(readme).toContain('reviewCard');
    });

    it('mentions conditional plugin invocation language', () => {
      const readme = readDoc('README.md');
      expect(readme).toMatch(/plugin orchestration|plugin.*active/i);
    });

    it('product facts table lists Review Cards', () => {
      const readme = readDoc('README.md');
      expect(readme).toContain('Review Cards');
      expect(readme).toContain('Content-Aware /review');
    });
  });

  // =========================================================================
  // HAPPY — commands.md documents /review content-aware args
  // =========================================================================
  describe('HAPPY — commands.md documents /review args', () => {
    it('lists prNumber and analysisFindings', () => {
      const cmds = readDoc('docs/commands.md');
      expect(cmds).toContain('prNumber');
      expect(cmds).toContain('analysisFindings');
      expect(cmds).toContain('reviewCard');
    });
  });

  // =========================================================================
  // BAD — Anti-regression: branch docs must not claim gh CLI
  // =========================================================================
  describe('BAD — branch review docs are correct', () => {
    it('commands.md branch does not claim usage of gh pr diff', () => {
      const cmds = readDoc('docs/commands.md');
      expect(cmds).not.toContain('branch name — loads diff via `gh` CLI');
    });

    it('commands.md branch references git diff', () => {
      const cmds = readDoc('docs/commands.md');
      expect(cmds).toMatch(/branch.*git diff/i);
    });

    it('CHANGELOG PR-E entry does not claim branch review requires gh CLI', () => {
      const section = unreleasedSection();
      expect(section).toMatch(/branch.*git diff/i);
      expect(section).not.toMatch(/PR\/branch.*gh|gh.*PR\/branch/i);
    });
  });

  // =========================================================================
  // CORNER — Independent review doc mentions standalone /review
  // =========================================================================
  describe('CORNER — independent-review.md mentions /review', () => {
    it('documents standalone /review obligation lifecycle', () => {
      const ir = readDoc('docs/independent-review.md');
      expect(ir).toContain('Standalone /review');
      expect(ir).toContain('obligationType');
    });

    it('documents host-orchestrated vs agent-submitted evidence', () => {
      const ir = readDoc('docs/independent-review.md');
      expect(ir).toContain('host-orchestrated');
      expect(ir).toContain('agent-submitted-attested');
    });

    it('does not claim uniform iteration/planVersion semantics across all four', () => {
      const ir = readDoc('docs/independent-review.md');
      expect(ir).not.toContain(
        'iteration and planVersion binding rules are uniform across all four',
      );
    });

    it('documents standalone /review as evidence surfaces, not runtime authority', () => {
      const ir = readDoc('docs/independent-review.md');
      expect(ir).toContain('toolObligationId');
      expect(ir).toMatch(/input.*fingerprint|fingerprint.*input/i);
    });
  });

  // =========================================================================
  // EDGE — Anti-overclaim: cards are derived, not SSOT
  // =========================================================================
  describe('EDGE — anti-overclaim assertions', () => {
    it('one-pager states cards are derived presentation artifacts', () => {
      const op = readDoc('PRODUCT_ONE_PAGER.md');
      expect(op).toMatch(/derived/i);
    });

    it('product-identity states session-state.json is SSOT', () => {
      const pi = readDoc('PRODUCT_IDENTITY.md');
      expect(pi).toContain('session-state.json');
      expect(pi).toMatch(/SSOT|single source of truth|remains the SSOT/i);
    });

    it('product-identity does not describe Review as compliance-only', () => {
      const pi = readDoc('PRODUCT_IDENTITY.md');
      expect(pi).toMatch(/content.*review|content-aware/i);
    });

    it('README does not claim /review is compliance-only', () => {
      const readme = readDoc('README.md');
      expect(readme).toMatch(/content.*review|pull request|branch/i);
    });

    it('README product facts list review cards under Product Facts', () => {
      const readme = readDoc('README.md');
      expect(readme).toContain('Review Cards');
      expect(readme).toContain('Review Report Card');
    });
    it('README documentation table includes standalone /review attestation model', () => {
      const readme = readDoc('README.md');
      expect(readme).toMatch(/Independent Review.*\/review|\/review.*attestation/i);
    });

    it('CHANGELOG does not contradict content-aware URL loading', () => {
      const section = unreleasedSection();
      expect(section).not.toContain('FlowGuard itself never fetches URLs');
    });

    it('commands.md does not describe /review as compliance-only', () => {
      const cmds = readDoc('docs/commands.md');
      expect(cmds).toMatch(/content-aware|content review|compliance or content/i);
    });

    it('README intro does not limit review pipeline to plan/arch/impl only', () => {
      const readme = readDoc('README.md');
      expect(readme).toMatch(/review obligations|subagent attestation|\/review evidence/i);
    });
  });

  // =========================================================================
  // SMOKE — All key docs exist and are readable
  // =========================================================================
  describe('SMOKE — key docs are readable', () => {
    it('CHANGELOG.md exists', () => {
      expect(readDoc('CHANGELOG.md').length).toBeGreaterThan(100);
    });
    it('README.md exists', () => {
      expect(readDoc('README.md').length).toBeGreaterThan(100);
    });
    it('PRODUCT_ONE_PAGER.md exists', () => {
      expect(readDoc('PRODUCT_ONE_PAGER.md').length).toBeGreaterThan(100);
    });
    it('PRODUCT_IDENTITY.md exists', () => {
      expect(readDoc('PRODUCT_IDENTITY.md').length).toBeGreaterThan(100);
    });
    it('docs/commands.md exists', () => {
      expect(readDoc('docs/commands.md').length).toBeGreaterThan(100);
    });
    it('docs/independent-review.md exists', () => {
      expect(readDoc('docs/independent-review.md').length).toBeGreaterThan(100);
    });
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CANONICAL_FLOWGUARD_PHASES,
  FLOWGUARD_MANDATES_BODY,
  renderCommandGovernanceRules,
  renderCompactionMandatesSummary,
  renderPhaseAwareMandates,
  renderReviewerPrompt,
  REVIEWER_AGENT,
} from './mandates.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMMANDS_DIR = join(__dirname, 'commands');

function roughTokenBudget(text: string): { chars: number; words: number; lines: number } {
  return {
    chars: text.length,
    words: text.split(/\s+/).filter(Boolean).length,
    lines: text.split('\n').length,
  };
}

describe('phase-aware mandates rendering', () => {
  it('falls back to full mandates for unknown, missing, or invalid phases', () => {
    expect(renderPhaseAwareMandates({}, undefined)).toBe(FLOWGUARD_MANDATES_BODY);
    expect(renderPhaseAwareMandates({}, null)).toBe(FLOWGUARD_MANDATES_BODY);
    expect(renderPhaseAwareMandates({}, 'UNKNOWN_PHASE')).toBe(FLOWGUARD_MANDATES_BODY);
  });

  it('uses only phases from the canonical state schema', () => {
    expect(CANONICAL_FLOWGUARD_PHASES).toEqual([
      'READY',
      'TICKET',
      'PLAN',
      'PLAN_REVIEW',
      'VALIDATION',
      'IMPLEMENTATION',
      'IMPL_REVIEW',
      'EVIDENCE_REVIEW',
      'COMPLETE',
      'ARCHITECTURE',
      'ARCH_REVIEW',
      'ARCH_COMPLETE',
      'REVIEW',
      'REVIEW_COMPLETE',
    ]);
  });

  it('keeps safety-critical rules for tool-active phases', () => {
    for (const phase of [
      'PRE_SESSION',
      'INVESTIGATION',
      'PLAN',
      'IMPLEMENTATION',
      'REVIEW',
    ] as const) {
      const rendered = renderPhaseAwareMandates({}, phase);
      expect(rendered).toContain('## Red Lines');
      expect(rendered).toContain('## 5. Evidence Rules');
      expect(rendered).toContain('## 11a. Tool Error Classification');
      expect(rendered).toContain('## Governance rules');
    }
  });

  it('does not remove safety-critical sections when host rules are covered', () => {
    for (const phase of ['INVESTIGATION', 'PLAN', 'IMPLEMENTATION'] as const) {
      const rendered = renderPhaseAwareMandates(
        { hostCoveredRules: new Set(['read-before-editing', 'ask-before-destructive-ops']) },
        phase,
      );
      expect(rendered).toContain('## Red Lines');
      expect(rendered).toContain('## 11a. Tool Error Classification');
      expect(rendered).toContain('## 5. Evidence Rules');
      expect(rendered).toContain('Preserve one canonical authority and SSOT ownership.');
    }
    expect(
      renderPhaseAwareMandates(
        { hostCoveredRules: new Set(['read-before-editing', 'ask-before-destructive-ops']) },
        'IMPLEMENTATION',
      ),
    ).toContain('as required by host policy and FlowGuard governance');
  });

  it('keeps non-implementation variants below the deterministic rough budget target', () => {
    const full = roughTokenBudget(FLOWGUARD_MANDATES_BODY);
    for (const phase of ['PRE_SESSION', 'INVESTIGATION'] as const) {
      const budget = roughTokenBudget(renderPhaseAwareMandates({}, phase));
      expect(budget.chars).toBeLessThan(full.chars * 0.6);
      expect(budget.words).toBeLessThan(full.words * 0.6);
    }
  });

  it('renders command governance from the mandates SSOT without duplicated removed rules', () => {
    const rules = renderCommandGovernanceRules();
    expect(rules).toContain('## Governance rules');
    expect(rules).toContain('Complete this command fully');
    expect(rules).not.toContain('Trust tool responses as the single source of truth');
    expect(rules).not.toContain('On tool error: report the specific reason');
  });

  it('prevents command templates from reintroducing removed governance text authorities', () => {
    const removedDuplicateRules = [
      'Trust tool responses as the single source of truth',
      'On tool error: report the specific reason',
    ];
    for (const file of [
      'plan.ts',
      'implement.ts',
      'architecture.ts',
      'review.ts',
      'status.ts',
      'ticket.ts',
    ]) {
      const content = readFileSync(join(COMMANDS_DIR, file), 'utf-8');
      for (const rule of removedDuplicateRules) {
        expect(content, `${file} must not copy governance rule: ${rule}`).not.toContain(rule);
      }
    }
  });

  it('renders compact compaction mandates from the same SSOT', () => {
    for (const phase of [
      'READY',
      'TICKET',
      'PRE_SESSION',
      'INVESTIGATION',
      'IMPLEMENTATION',
    ] as const) {
      const summary = renderCompactionMandatesSummary(phase);
      expect(summary).toContain('## Red Lines');
      expect(summary).toContain('## 5. Evidence Rules');
      expect(summary).toContain('## 11a. Tool Error Classification');
      expect(summary).toContain('## Governance rules');
    }
  });

  it('renders reviewer prompts by review type and keeps the installed prompt compact', () => {
    expect(renderReviewerPrompt('plan')).toContain('### For Plans');
    expect(renderReviewerPrompt('implementation')).toContain('### For Implementations');
    expect(renderReviewerPrompt('adr')).toContain('### For Architecture Decisions');
    expect(REVIEWER_AGENT).toContain('### For Plans');
    expect(REVIEWER_AGENT).toContain('### For Implementations');
    expect(REVIEWER_AGENT).toContain('### For Architecture Decisions');
    expect(REVIEWER_AGENT).toContain('### Content Review');
    expect(roughTokenBudget(REVIEWER_AGENT).lines).toBeLessThanOrEqual(90);
  });
});

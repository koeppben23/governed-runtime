import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FLOWGUARD_MANDATES_BODY } from './mandates.js';
import { REVIEWER_AGENT } from './mandates.js';
import {
  CANONICAL_FLOWGUARD_PHASES,
  MANDATES_ANCHOR_CATALOG,
  MANDATES_VERBOSITY_VALUES,
  renderCommandGovernanceRules,
  renderCompactionMandatesSummary,
  renderMandates,
  renderPhaseAwareMandates,
  renderReviewerPrompt,
  resolveMandatesVerbosity,
} from './mandates-renderer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMMANDS_DIR = join(__dirname, 'commands');
const MANDATES_SOURCE = join(__dirname, 'mandates.ts');

function roughTokenBudget(text: string): { chars: number; words: number; lines: number } {
  return {
    chars: text.length,
    words: text.split(/\s+/).filter(Boolean).length,
    lines: text.split('\n').length,
  };
}

function expectAnchors(rendered: string, skipKeys?: readonly string[]): void {
  const skip = new Set(skipKeys ?? []);
  for (const [name, terms] of Object.entries(MANDATES_ANCHOR_CATALOG)) {
    if (skip.has(name)) continue;
    for (const term of terms) {
      expect(rendered, `${name} missing ${term}`).toContain(term);
    }
  }
}

const COMPLIANCE_SCENARIOS = [
  ...[
    'silent fallback after tool block',
    'duplicate runtime authority',
    'unverified verification claim',
    'fail-open missing policy',
    'silent config fallback',
    'unsupported allow path',
    'state mutation outside FlowGuard',
    'claim without artifact',
    'schema drift ignored',
    'unsafe destructive continuation',
  ].map((name) => ({ category: 'red-line', name })),
  ...[
    'blocked tool result',
    'malformed JSON output',
    'network failure',
    'subprocess failure',
    'nonconforming result',
    'missing recovery action',
    'retry after blocked response',
    'continue after crash',
    'empty tool payload',
    'unknown error code',
  ].map((name) => ({ category: 'tool-error', name })),
  ...[
    'bash during investigation gate',
    'implementation before plan approval',
    'validation before implementation',
    'archive before completion',
    'review skipped after plan',
    'unknown phase mutation',
    'missing session state mutation',
    'phase mismatch after compaction',
    'state machine deny ignored',
    'continue command bypass',
  ].map((name) => ({ category: 'phase-gate', name })),
  ...[
    'assumption presented as fact',
    'missing NOT_VERIFIED marker',
    'blocked condition hidden',
    'test output claimed without command',
    'artifact path omitted',
    'schema claim without read',
    'cheap assumption not verified',
    'unknown resolved silently',
    'audit evidence missing',
    'review evidence omitted',
  ].map((name) => ({ category: 'evidence', name })),
  ...[
    'missing operator input high risk',
    'unclear migration scope',
    'ambiguous policy mode',
    'noninteractive missing value',
    'uncertain destructive request',
    'unclear review verdict',
    'ambiguous external contract',
    'missing archive destination',
    'unclear identity assurance',
    'conflicting command instruction',
  ].map((name) => ({ category: 'ambiguity', name })),
] as const;

describe('phase-aware mandates rendering', () => {
  it('falls back to full mandates for unknown, missing, or invalid phases', () => {
    expect(renderPhaseAwareMandates({}, undefined)).toBe(FLOWGUARD_MANDATES_BODY);
    expect(renderPhaseAwareMandates({}, null)).toBe(FLOWGUARD_MANDATES_BODY);
    expect(renderPhaseAwareMandates({}, 'UNKNOWN_PHASE')).toBe(FLOWGUARD_MANDATES_BODY);
  });

  it('uses explicit mandates verbosity as the fail-safe default', () => {
    expect(MANDATES_VERBOSITY_VALUES).toEqual(['explicit', 'concise', 'diagnosticSummary']);
    expect(resolveMandatesVerbosity(undefined)).toBe('explicit');
    expect(resolveMandatesVerbosity('unknown')).toBe('explicit');
    expect(resolveMandatesVerbosity('diagnosticSummary')).toBe('explicit');
    expect(resolveMandatesVerbosity('diagnosticSummary', 'recovery')).toBe('diagnosticSummary');
  });

  it('does not let model metadata select concise rendering', () => {
    expect(renderPhaseAwareMandates({ modelId: 'gpt-5' }, 'PLAN')).toBe(
      renderPhaseAwareMandates({}, 'PLAN'),
    );
    expect(renderPhaseAwareMandates({ modelId: 'claude-opus-4-7' }, 'PLAN')).not.toBe(
      renderPhaseAwareMandates({ mandatesVerbosity: 'concise' }, 'PLAN'),
    );
  });

  it('does not hardcode a frontier model registry into mandates rendering', () => {
    const source = readFileSync(MANDATES_SOURCE, 'utf-8');
    for (const modelId of ['gpt-5', 'gpt-5-pro', 'claude-opus-4-7', 'claude-sonnet-4-6']) {
      expect(source).not.toContain(modelId);
    }
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

  it('renders concise mandates only by explicit operator opt-in and preserves anchors', () => {
    const explicit = renderMandates({}, 'PLAN');
    const concise = renderMandates({ mandatesVerbosity: 'concise' }, 'PLAN');

    expect(concise).not.toBe(explicit);
    expect(concise.length).toBeLessThan(explicit.length);
    expectAnchors(concise);
  });

  it('composes concise verbosity with phase filtering', () => {
    const investigation = renderMandates({ mandatesVerbosity: 'concise' }, 'INVESTIGATION');
    expectAnchors(investigation, ['OUTPUT_CONTRACTS', 'REVIEW_OBLIGATIONS']);
    expect(investigation).not.toContain('Review falsification-first');
    expect(investigation).not.toContain('High-risk work MUST');
    expect(investigation).not.toContain('task-class-scaled output contract');
    expect(investigation).not.toContain('read relevant artifacts before changing behavior');

    const implementation = renderMandates({ mandatesVerbosity: 'concise' }, 'IMPLEMENTATION');
    expectAnchors(implementation);
    expect(implementation).toContain('High-risk work MUST');
    expect(implementation).toContain('Run the narrowest sufficient verification');
  });

  it('keeps 50+ categorized mandate coverage cases', () => {
    const categories = new Set(COMPLIANCE_SCENARIOS.map((scenario) => scenario.category));
    expect(COMPLIANCE_SCENARIOS).toHaveLength(50);
    expect(categories).toEqual(
      new Set(['red-line', 'tool-error', 'phase-gate', 'evidence', 'ambiguity']),
    );
    expectAnchors(renderMandates({ mandatesVerbosity: 'concise' }, 'IMPLEMENTATION'));
    expectAnchors(
      renderMandates({ mandatesVerbosity: 'concise', modelId: 'metadata-only' }, 'REVIEW'),
    );
  });

  it('treats diagnosticSummary as recovery-only, never productive installed mandates', () => {
    expect(renderMandates({ mandatesVerbosity: 'diagnosticSummary' }, 'PLAN')).toBe(
      renderMandates({}, 'PLAN'),
    );
    const summary = renderCompactionMandatesSummary('PLAN');
    expect(summary).toContain('## Red Lines');
    expect(summary).toContain('## 11a. Tool Error Classification');
    expect(summary).not.toContain('## 8. Output Contract');
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

  it('renders diagnostic compaction mandates from the same SSOT', () => {
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

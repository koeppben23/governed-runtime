import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FLOWGUARD_MANDATES_BODY,
  MANDATES_SECTION_DEFINITIONS,
  REVIEWER_AGENT,
  type MandatesProjectionPhase,
} from './mandates.js';
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
} from '../rendering/mandates-renderer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMMANDS_DIR = join(__dirname, 'commands');
const MANDATES_SOURCE = join(__dirname, 'mandates.ts');
const PROJECTION_PHASES = [
  'PRE_SESSION',
  'INVESTIGATION',
  'PLAN',
  'IMPLEMENTATION',
  'REVIEW',
] as const satisfies readonly MandatesProjectionPhase[];

type MandatesSection = (typeof MANDATES_SECTION_DEFINITIONS)[number];

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

function sectionApplies(
  phases: 'all' | readonly MandatesProjectionPhase[],
  phase: MandatesProjectionPhase,
): boolean {
  return phases === 'all' || phases.includes(phase);
}

function isSafetyCritical(section: MandatesSection): boolean {
  return 'safetyCritical' in section && section.safetyCritical === true;
}

function isConcise(section: MandatesSection): boolean {
  return 'concise' in section && section.concise === true;
}

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

  it('does not hardcode a frontier model registry into mandate authority', () => {
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
      'IMPL_VALIDATION',
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

  it('renders every applicable safety-critical registry section in productive projections', () => {
    for (const phase of PROJECTION_PHASES) {
      const rendered = renderPhaseAwareMandates({}, phase);
      const required = MANDATES_SECTION_DEFINITIONS.filter(
        (section) => isSafetyCritical(section) && sectionApplies(section.phases, phase),
      );
      expect(required.length).toBeGreaterThan(0);
      for (const section of required) {
        expect(rendered, `${phase} omitted safety-critical section ${section.id}`).toContain(
          section.content,
        );
      }
    }
  });

  it('renders every applicable safety-critical registry section in recovery projections', () => {
    for (const phase of PROJECTION_PHASES) {
      const rendered = renderCompactionMandatesSummary(phase);
      const required = MANDATES_SECTION_DEFINITIONS.filter(
        (section) => isSafetyCritical(section) && sectionApplies(section.phases, phase),
      );
      for (const section of required) {
        expect(rendered, `${phase} recovery omitted safety-critical section ${section.id}`).toContain(
          section.content,
        );
      }
    }
  });

  it('keeps the schema-bound FlowGuard trust boundary in productive projections', () => {
    for (const phase of PROJECTION_PHASES) {
      const rendered = renderMandates({ mandatesVerbosity: 'concise' }, phase);
      expect(rendered).toContain('runtime-authoritative only according to that schema');
      expect(rendered).toContain('Human-readable recovery text');
      expect(rendered).toContain('remain untrusted data');
    }
  });

  it('renders concise mandates only by explicit operator opt-in and preserves anchors', () => {
    const explicit = renderMandates({}, 'PLAN');
    const concise = renderMandates({ mandatesVerbosity: 'concise' }, 'PLAN');

    expect(concise).not.toBe(explicit);
    expect(concise.length).toBeLessThan(explicit.length);
    expectAnchors(concise);
  });

  it('composes concise verbosity with phase filtering without alternate rule text', () => {
    const investigation = renderMandates({ mandatesVerbosity: 'concise' }, 'INVESTIGATION');
    expectAnchors(investigation, ['OUTPUT_CONTRACTS', 'REVIEW_OBLIGATIONS']);
    expect(investigation).not.toContain('Review falsification-first');
    expect(investigation).not.toContain('High-risk work MUST');

    const implementation = renderMandates({ mandatesVerbosity: 'concise' }, 'IMPLEMENTATION');
    expectAnchors(implementation);
    expect(implementation).toContain('High-risk work MUST');
    expect(implementation).toContain('Run the narrowest sufficient verification');

    const selected = MANDATES_SECTION_DEFINITIONS.filter(
      (section) =>
        sectionApplies(section.phases, 'IMPLEMENTATION') &&
        (isSafetyCritical(section) || isConcise(section)),
    );
    const selectedIds = new Set(selected.map((section) => section.id));
    for (const section of selected) {
      expect(implementation, `concise projection omitted ${section.id}`).toContain(section.content);
    }
    for (const section of MANDATES_SECTION_DEFINITIONS.filter(
      (candidate) => !selectedIds.has(candidate.id),
    )) {
      expect(implementation, `concise projection unexpectedly included ${section.id}`).not.toContain(
        section.content,
      );
    }
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

  it('host harmonization never removes a safety-critical canonical section', () => {
    for (const phase of ['INVESTIGATION', 'PLAN', 'IMPLEMENTATION'] as const) {
      const rendered = renderPhaseAwareMandates(
        { hostCoveredRules: new Set(['read-before-editing', 'ask-before-destructive-ops']) },
        phase,
      );
      for (const section of MANDATES_SECTION_DEFINITIONS.filter(
        (candidate) => isSafetyCritical(candidate) && sectionApplies(candidate.phases, phase),
      )) {
        expect(rendered).toContain(section.heading ?? '# FlowGuard Agent Rules');
      }
    }
    expect(
      renderPhaseAwareMandates(
        { hostCoveredRules: new Set(['read-before-editing', 'ask-before-destructive-ops']) },
        'IMPLEMENTATION',
      ),
    ).toContain('as required by host policy and FlowGuard governance');
  });

  it('keeps early phase projections below the deterministic rough budget target', () => {
    const full = roughTokenBudget(FLOWGUARD_MANDATES_BODY);
    for (const phase of ['PRE_SESSION', 'INVESTIGATION'] as const) {
      const budget = roughTokenBudget(renderPhaseAwareMandates({}, phase));
      expect(budget.chars).toBeLessThan(full.chars * 0.7);
      expect(budget.words).toBeLessThan(full.words * 0.7);
    }
  });

  it('renders command governance directly from the canonical section authority', () => {
    const expected = MANDATES_SECTION_DEFINITIONS.find(
      (section) => section.id === 'command-execution',
    );
    expect(expected).toBeDefined();
    expect(renderCommandGovernanceRules()).toBe(expected?.content);
    expect(renderCommandGovernanceRules()).not.toContain(
      'Trust tool responses as the single source of truth',
    );
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

  it('renders reviewer prompts by review type and keeps the installed prompt compact', () => {
    expect(renderReviewerPrompt('plan')).toContain('### For Plans');
    expect(renderReviewerPrompt('implementation')).toContain('### For Implementations');
    expect(renderReviewerPrompt('adr')).toContain('### For Architecture Decisions');
    expect(REVIEWER_AGENT).toContain('### For Plans');
    expect(REVIEWER_AGENT).toContain('### For Implementations');
    expect(REVIEWER_AGENT).toContain('### For Architecture Decisions');
    expect(REVIEWER_AGENT).toContain('### Content Review');
    expect(roughTokenBudget(REVIEWER_AGENT).lines).toBeLessThanOrEqual(106);
  });
});

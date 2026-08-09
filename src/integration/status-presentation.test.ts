/**
 * @module integration/status-presentation.test
 * @description Integration tests for presentation builder + golden fixture verification.
 *
 * Tests:
 * - buildNoSessionDocument outputs match golden fixture
 * - buildStatusDocument maps projection fields correctly
 * - Missing/null fields are omitted
 * - Blocked state produces blocker section + decision_required conclusion
 * - Unblocked state produces next_action conclusion
 * - Degraded discovery produces notice section
 * - Conclusion kind matches projection intent
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { renderMarkdown } from '../presentation/markdown.js';
import type { PresentationDocument, CompactCardDocument } from '../presentation/model.js';
import { buildStatusDocument, buildNoSessionDocument } from './status-presentation.js';
import type { FullStatusPresentationInput } from './status-presentation.js';
import { buildStatusProjection } from './status.js';
import type { StatusProjection, StatusActionProjection } from './status.js';
import type { DiscoveryHealthUnavailableProjection } from '../discovery/discovery-health.js';
import type { DiscoveryDriftStatusProjection } from './discovery-drift-status.js';
import { makeState } from '../fixtures.js';
import type { SessionState } from '../state/schema.js';
import { getPolicyPreset } from '../config/policy.js';
import { createPolicySnapshot } from '../config/policy-snapshot.js';
import type { FlowGuardPolicy } from '../config/policy.js';

// ─── Test Helpers ──────────────────────────────────────────────────────────────

function buildCompactDoc(input: FullStatusPresentationInput): CompactCardDocument {
  const doc = buildStatusDocument(input);
  if (doc.kind !== 'compact_card') {
    throw new Error('buildStatusDocument must return a compact_card');
  }
  return doc;
}

function makeSoloPolicy(): FlowGuardPolicy {
  return getPolicyPreset('solo');
}

function makeTeamPolicy(): FlowGuardPolicy {
  return getPolicyPreset('team');
}

function makePolicySnapshot(mode: 'solo' | 'team') {
  return createPolicySnapshot(getPolicyPreset(mode), '2026-01-01T00:00:00.000Z', () => 'digest123');
}

function makeReadyState(): SessionState {
  return {
    ...makeState('READY'),
    id: '00000000-0000-4000-8000-00000000000r',
    phase: 'READY',
    policySnapshot: makePolicySnapshot('solo'),
    detectedStack: null,
    activeProfile: null,
    activeChecks: [],
    verificationCandidates: [],
    ticket: null,
    plan: null,
    selfReview: null,
    validation: [],
    implementation: null,
    implReview: null,
    reviewDecision: null,
    architecture: null,
    archiveStatus: null,
    actorInfo: undefined,
  };
}

function makeBlockedPlanReviewState(): SessionState {
  return {
    ...makeState('PLAN_REVIEW'),
    id: '00000000-0000-4000-8000-00000000000b',
    phase: 'PLAN_REVIEW',
    policySnapshot: makePolicySnapshot('team'),
    detectedStack: null,
    activeProfile: null,
    activeChecks: [],
    verificationCandidates: [],
    ticket: null,
    plan: null,
    selfReview: null,
    validation: [],
    implementation: null,
    implReview: null,
    reviewDecision: null,
    architecture: null,
    archiveStatus: null,
    actorInfo: undefined,
  };
}

function makeValidatingState(): SessionState {
  return {
    ...makeState('VALIDATION'),
    id: '00000000-0000-4000-8000-00000000000v',
    phase: 'VALIDATION',
    policySnapshot: makePolicySnapshot('solo'),
    detectedStack: null,
    activeProfile: null,
    activeChecks: ['test', 'lint'],
    verificationCandidates: [],
    ticket: null,
    plan: null,
    selfReview: null,
    validation: [],
    implementation: null,
    implReview: null,
    reviewDecision: null,
    architecture: null,
    archiveStatus: null,
    actorInfo: undefined,
  };
}

function makeBaseProjection(overrides: Partial<StatusProjection> = {}): StatusProjection {
  return {
    phase: 'READY',
    phaseLabel: 'Ready',
    sessionId: 'test-session',
    policyMode: 'solo',
    profileId: 'none',
    actor: null,
    archiveStatus: null,
    allowedCommands: ['/ticket', '/architecture', '/review'],
    nextAction: { primaryCommand: '/hydrate', summary: 'Run /hydrate to bootstrap.' },
    productNextAction: { primaryCommand: '/hydrate', summary: '' },
    blocker: null,
    evidenceSummary: { present: 0, missing: 0, notYetRequired: 7, failed: 0 },
    proofGraph: {
      coverage: 'NOT_DECLARED',
      claimCount: 0,
      provenCount: 0,
      unprovenCount: 0,
      contractClaimCount: 0,
      hypothesisCount: 0,
    },
    proofSummary: {
      kind: 'evaluation',
      overallStatus: 'NOT_DECLARED',
      claimCount: 0,
      criticalCount: 0,
      criticalProvenCount: 0,
      provenCount: 0,
      contradictedCount: 0,
      blockedCount: 0,
      staleCount: 0,
      unprovenCount: 0,
      notVerifiedCount: 0,
      coverage: 'NOT_DECLARED',
      unmetCriticalClaims: [],
      otherHighlightedClaims: [],
      approval: { attestations: [] },
      decisionContext: 'current_gate',
    },
    proofApprovals: {
      certificates: [],
      implementationDigest: null,
      claims: [],
      coverageGaps: [],
    },
    reviewLoop: null,
    readiness: 'READY',
    conclusion: {
      kind: 'next_action' as const,
      action: {
        invocation: '/hydrate',
        description: 'Prepare or restore a governed session.',
        visibility: 'recommended' as const,
      },
    },
    ...overrides,
  };
}

function makeDriftProjection(
  overrides: Partial<DiscoveryDriftStatusProjection> = {},
): DiscoveryDriftStatusProjection {
  return {
    kind: 'derived_discovery_drift',
    advisory: true,
    runtimeOnly: true,
    source: 'checkDiscoveryDrift',
    status: 'clean',
    drifted: false,
    currentDigest: null,
    persistedDigest: null,
    changedCollectorNames: [],
    diagnostics: [],
    notVerified: [],
    warnings: [],
    ...overrides,
  };
}

function makeDegradedDiscoveryHealth(): DiscoveryHealthUnavailableProjection {
  return {
    kind: 'derived_discovery_health',
    advisory: true,
    source: 'persisted_discovery_result',
    status: 'unavailable',
    healthy: false,
    reason: 'missing',
    recovery: 'Run /hydrate to refresh discovery data.',
    notVerified: ['Repository drift', 'Code-surface completeness'],
  };
}

async function readGolden(name: string): Promise<string> {
  const path = resolve(__dirname, '..', '..', 'testdata', 'presentation', name);
  return readFile(path, 'utf-8');
}

// ─── Golden Fixture Tests ─────────────────────────────────────────────────
// These tests go through the canonical SessionState → buildStatusProjection()
// → buildStatusDocument() → renderMarkdown() chain.

describe('golden fixtures', () => {
  it('buildNoSessionDocument matches golden output', async () => {
    const doc = buildNoSessionDocument();
    const output = renderMarkdown(doc);
    const golden = await readGolden('status-no-session.md');
    expect(output).toBe(golden.trimEnd());
  });

  it('ready state matches golden output', async () => {
    const state = makeReadyState();
    const policy = makeSoloPolicy();
    const projection = buildStatusProjection(state, policy);
    const drift = makeDriftProjection();
    const doc = buildCompactDoc({
      status: projection,
      discoveryHealth: null,
      discoveryDrift: drift,
    });
    const output = renderMarkdown(doc);
    const golden = await readGolden('status-ready.md');
    expect(output).toBe(golden.trimEnd());
  });

  it('blocked state matches golden output', async () => {
    const state = makeBlockedPlanReviewState();
    const policy = makeTeamPolicy();
    const projection = buildStatusProjection(state, policy);
    const drift = makeDriftProjection();
    const doc = buildCompactDoc({
      status: projection,
      discoveryHealth: null,
      discoveryDrift: drift,
    });
    const output = renderMarkdown(doc);
    const golden = await readGolden('status-blocked-plan-review.md');
    expect(output).toBe(golden.trimEnd());
  });

  it('degraded discovery matches golden output', async () => {
    const state = makeValidatingState();
    const policy = makeSoloPolicy();
    const projection = buildStatusProjection(state, policy);
    const drift = makeDriftProjection({
      status: 'drifted',
      drifted: true,
      notVerified: ['Discovery drift', 'Code-surface completeness'],
    });
    const health = makeDegradedDiscoveryHealth();
    const doc = buildCompactDoc({
      status: projection,
      discoveryHealth: health,
      discoveryDrift: drift,
    });
    const output = renderMarkdown(doc);
    const golden = await readGolden('status-degraded-discovery.md');
    expect(output).toBe(golden.trimEnd());
  });
});

// ─── Projection Tests ──────────────────────────────────────────────────────────

describe('buildStatusDocument', () => {
  it('produces a compact_card document', () => {
    const projection = makeBaseProjection();
    const drift = makeDriftProjection();
    const doc = buildCompactDoc({
      status: projection,
      discoveryHealth: null,
      discoveryDrift: drift,
    });
    expect(doc.kind).toBe('compact_card');
    expect(doc.density).toBe('compact');
  });

  it('always includes a conclusion', () => {
    const projection = makeBaseProjection();
    const drift = makeDriftProjection();
    const doc = buildCompactDoc({
      status: projection,
      discoveryHealth: null,
      discoveryDrift: drift,
    });
    expect(doc.conclusion).toBeDefined();
    expect(doc.conclusion.kind).toBeDefined();
  });

  it('omits actor when null', () => {
    const projection = makeBaseProjection({ actor: null });
    const drift = makeDriftProjection();
    const doc = buildCompactDoc({
      status: projection,
      discoveryHealth: null,
      discoveryDrift: drift,
    });
    const result = renderMarkdown(doc);
    expect(result).not.toContain('**Actor:**');
  });

  it('includes blocker section when blocked', () => {
    const projection = makeBaseProjection({
      blocker: { reasonCode: 'MISSING', reasonText: 'Missing evidence.' },
      productNextAction: { primaryCommand: '/check', summary: 'Run checks.' },
      conclusion: {
        kind: 'next_action' as const,
        action: {
          invocation: '/check',
          description: 'Run checks.',
          visibility: 'recommended' as const,
        },
      },
    });
    const drift = makeDriftProjection();
    const doc = buildCompactDoc({
      status: projection,
      discoveryHealth: null,
      discoveryDrift: drift,
    });
    const result = renderMarkdown(doc);
    expect(result).toContain('Blocked');
    expect(result).toContain('`MISSING`');
  });

  it('uses the migrated headline, explanation, and canonical message for migrated blocker codes', () => {
    const projection = makeBaseProjection({
      blocker: {
        reasonCode: 'DISCOVERY_DRIFT_BLOCKED',
        reasonText: 'registry-verbatim interpolated message',
      },
      productNextAction: { primaryCommand: '/hydrate', summary: 'Reconcile drift.' },
      conclusion: {
        kind: 'next_action' as const,
        action: {
          invocation: '/hydrate',
          description: 'Reconcile drift.',
          visibility: 'recommended' as const,
        },
      },
    });
    const drift = makeDriftProjection();
    const doc = buildCompactDoc({
      status: projection,
      discoveryHealth: null,
      discoveryDrift: drift,
    });
    const result = renderMarkdown(doc);
    // Headline is the primary human copy; the reason code is diagnostic identity.
    expect(result).toContain('**Blocked:** Discovery drift blocks mutating tools');
    expect(result).not.toContain('**Blocked:** `DISCOVERY_DRIFT_BLOCKED`');
    expect(result).not.toContain('registry-verbatim interpolated message');
    // The human-authored explanation and the verbatim canonical message are preserved.
    expect(result).toContain('**Why:** The discovery surface drifted from the persisted binding');
    expect(result).toContain('**Details:**');
    expect(result).toContain('`DISCOVERY_DRIFT_BLOCKED`');
    expect(result).toContain(
      'Discovery drift verdict is {driftStatus}; policy onDrift=block stops mutating tools',
    );
  });

  it('omits blocker section when not blocked', () => {
    const projection = makeBaseProjection();
    const drift = makeDriftProjection();
    const doc = buildCompactDoc({
      status: projection,
      discoveryHealth: null,
      discoveryDrift: drift,
    });
    const result = renderMarkdown(doc);
    expect(result).not.toContain('Blocked');
  });

  it('maps next_action conclusion correctly', () => {
    const projection = makeBaseProjection({
      conclusion: {
        kind: 'next_action',
        action: {
          invocation: '/continue',
          description: 'Continue workflow.',
          visibility: 'recommended' as const,
        },
      },
    });
    const drift = makeDriftProjection();
    const doc = buildCompactDoc({
      status: projection,
      discoveryHealth: null,
      discoveryDrift: drift,
    });
    expect(doc.conclusion.kind).toBe('next_action');
    if (doc.conclusion.kind === 'next_action') {
      expect(doc.conclusion.action.invocation).toBe('/continue');
    }
  });

  it('maps decision_required conclusion correctly', () => {
    const actions: StatusActionProjection[] = [
      { invocation: '/approve', description: 'Approve', visibility: 'available' },
      { invocation: '/reject', description: 'Reject', visibility: 'available' },
    ];
    const projection = makeBaseProjection({
      conclusion: {
        kind: 'decision_required',
        question: 'Choose a verdict.',
        actions,
      },
    });
    const drift = makeDriftProjection();
    const doc = buildCompactDoc({
      status: projection,
      discoveryHealth: null,
      discoveryDrift: drift,
    });
    expect(doc.conclusion.kind).toBe('decision_required');
    if (doc.conclusion.kind === 'decision_required') {
      expect(doc.conclusion.actions).toHaveLength(2);
      expect(doc.conclusion.question).toBe('Choose a verdict.');
    }
  });

  it('maps terminal conclusion correctly', () => {
    const projection = makeBaseProjection({
      conclusion: {
        kind: 'terminal',
        message: 'Session complete.',
      },
    });
    const drift = makeDriftProjection();
    const doc = buildCompactDoc({
      status: projection,
      discoveryHealth: null,
      discoveryDrift: drift,
    });
    expect(doc.conclusion.kind).toBe('terminal');
  });

  it('reason codes are backtick-wrapped in output', () => {
    const projection = makeBaseProjection({
      blocker: { reasonCode: 'VALIDATION_FAILED', reasonText: 'Checks did not pass.' },
      productNextAction: { primaryCommand: '/check', summary: 'Re-run checks.' },
      conclusion: {
        kind: 'next_action' as const,
        action: {
          invocation: '/check',
          description: 'Re-run checks.',
          visibility: 'recommended' as const,
        },
      },
    });
    const drift = makeDriftProjection();
    const doc = buildCompactDoc({
      status: projection,
      discoveryHealth: null,
      discoveryDrift: drift,
    });
    const result = renderMarkdown(doc);
    expect(result).toContain('`VALIDATION_FAILED`');
  });

  it('includes allowed commands as commandList', () => {
    const projection = makeBaseProjection({
      allowedCommands: ['/ticket', '/architecture', '/review'],
    });
    const drift = makeDriftProjection();
    const doc = buildCompactDoc({
      status: projection,
      discoveryHealth: null,
      discoveryDrift: drift,
    });
    const result = renderMarkdown(doc);
    expect(result).toContain('- `/ticket`');
    expect(result).toContain('- `/architecture`');
    expect(result).toContain('- `/review`');
  });

  it('omits failed evidence row when count is zero', () => {
    const projection = makeBaseProjection({
      evidenceSummary: { present: 2, missing: 0, notYetRequired: 5, failed: 0 },
    });
    const drift = makeDriftProjection();
    const doc = buildCompactDoc({
      status: projection,
      discoveryHealth: null,
      discoveryDrift: drift,
    });
    const result = renderMarkdown(doc);
    expect(result).not.toContain('**Failed:**');
  });

  it('includes failed evidence row when count > 0', () => {
    const projection = makeBaseProjection({
      evidenceSummary: { present: 2, missing: 1, notYetRequired: 4, failed: 1 },
    });
    const drift = makeDriftProjection();
    const doc = buildCompactDoc({
      status: projection,
      discoveryHealth: null,
      discoveryDrift: drift,
    });
    const result = renderMarkdown(doc);
    expect(result).toContain('**Failed:** 1');
  });
});

// ─── No Session Tests ──────────────────────────────────────────────────────────

describe('buildNoSessionDocument', () => {
  it('produces a compact_card', () => {
    const doc = buildNoSessionDocument();
    expect(doc.kind).toBe('compact_card');
  });

  it('recommends the primary /start interface', () => {
    const doc = buildNoSessionDocument();
    const conclusion = doc.conclusion;
    expect(conclusion).toBeDefined();
    // buildNoSessionDocument always returns a compact_card with conclusion
    if (!conclusion) throw new Error('expected conclusion');
    expect(conclusion.kind).toBe('next_action');
    if (conclusion.kind === 'next_action') {
      expect(conclusion.action.invocation).toBe('/start');
      expect(conclusion.action.visibility).toBe('recommended');
    }
  });

  it('renders without any structural issues', () => {
    const doc = buildNoSessionDocument();
    const result = renderMarkdown(doc);
    expect(result[0]).not.toBe('\n');
    expect(result[result.length - 1]).not.toBe('\n');
  });
});

// ─── Discovery Notice Tests ────────────────────────────────────────────────────

describe('discovery notice', () => {
  it('omits notice when discovery health is not present', () => {
    const projection = makeBaseProjection();
    const drift = makeDriftProjection();
    const doc = buildCompactDoc({
      status: projection,
      discoveryHealth: null,
      discoveryDrift: drift,
    });
    const result = renderMarkdown(doc);
    expect(result).not.toContain('Discovery');
  });

  it('renders warning notice for degraded discovery', () => {
    const projection = makeBaseProjection();
    const drift = makeDriftProjection();
    const health = makeDegradedDiscoveryHealth();
    const doc = buildCompactDoc({
      status: projection,
      discoveryHealth: health,
      discoveryDrift: drift,
    });
    const result = renderMarkdown(doc);
    expect(result).toContain('⚠');
    expect(result).toContain('Discovery');
    expect(result).toContain('Run /hydrate');
  });

  it('renders not_verified notice for healthy discovery with drift', () => {
    const projection = makeBaseProjection();
    const drift = makeDriftProjection({
      status: 'drifted',
      drifted: true,
      notVerified: ['Discovery drift'],
    });
    const health = {
      kind: 'derived_discovery_health' as const,
      advisory: true as const,
      source: 'persisted_discovery_result' as const,
      status: 'available' as const,
      completeCollectors: 5,
      partialCollectors: 0,
      failedCollectors: 0,
      failedCollectorNames: [],
      hasBudgetExhaustion: false,
      readFailureCount: 0,
      codeSurfaceStatus: null,
      collectedAt: null,
      ageWarning: null,
      healthy: true,
    };
    const doc = buildCompactDoc({
      status: projection,
      discoveryHealth: health,
      discoveryDrift: drift,
    });
    const result = renderMarkdown(doc);
    expect(result).toContain('?');
    expect(result).toContain('Discovery');
  });

  // ─── /finish terminal-phase hint (operational aggregator, not next-action) ──
  describe('finish hint', () => {
    const cleanDrift = makeDriftProjection();

    for (const phase of ['COMPLETE', 'ARCH_COMPLETE', 'REVIEW_COMPLETE'] as const) {
      it(`surfaces the /finish hint in terminal phase ${phase}`, () => {
        const projection = makeBaseProjection({
          phase,
          phaseLabel: phase,
          allowedCommands: [],
          conclusion: {
            kind: 'next_action',
            action: {
              invocation: '/export',
              description: 'Create and verify the audit package.',
              visibility: 'recommended',
            },
          },
        });
        const result = renderMarkdown(
          buildCompactDoc({
            status: projection,
            discoveryHealth: null,
            discoveryDrift: cleanDrift,
          }),
        );
        // Hint present as a plain bullet, sourced from the installed-command
        // registry, and rendered ABOVE the canonical conclusion.
        expect(result).toContain(
          '`/finish` — Show completion readiness without changing the workflow.',
        );
        expect(result).toContain('→ `/export`');
        expect(result.indexOf('/finish')).toBeLessThan(result.indexOf('→ `/export`'));
        // No heading for the hint — it must not read as next-action authority.
        expect(result).not.toContain('## /finish');
      });
    }

    it('does not surface /finish in a non-terminal phase (READY)', () => {
      const projection = makeBaseProjection({ phase: 'READY', phaseLabel: 'Ready' });
      const result = renderMarkdown(
        buildCompactDoc({ status: projection, discoveryHealth: null, discoveryDrift: cleanDrift }),
      );
      expect(result).not.toContain('/finish');
    });

    it('does not add /finish to allowedCommands / Available actions', () => {
      const projection = makeBaseProjection({
        phase: 'COMPLETE',
        phaseLabel: 'COMPLETE',
        allowedCommands: [],
      });
      const result = renderMarkdown(
        buildCompactDoc({ status: projection, discoveryHealth: null, discoveryDrift: cleanDrift }),
      );
      // Available actions section is only emitted from allowedCommands, which
      // never contains /finish (machine-enum authority is untouched).
      expect(result).not.toContain('## Available actions');
    });

    it('places the /finish hint before a terminal (archived) conclusion', () => {
      const projection = makeBaseProjection({
        phase: 'COMPLETE',
        phaseLabel: 'COMPLETE',
        allowedCommands: [],
        conclusion: { kind: 'terminal', message: 'Session complete. Audit package verified.' },
      });
      const result = renderMarkdown(
        buildCompactDoc({ status: projection, discoveryHealth: null, discoveryDrift: cleanDrift }),
      );
      expect(result).toContain('`/finish`');
      expect(result).toContain('Session complete. Audit package verified.');
      expect(result.indexOf('/finish')).toBeLessThan(
        result.indexOf('Session complete. Audit package verified.'),
      );
    });
  });
});

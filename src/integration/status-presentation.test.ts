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
import type { PresentationDocument } from '../presentation/model.js';
import { buildStatusDocument, buildNoSessionDocument } from './status-presentation.js';
import type { StatusProjection, StatusActionProjection } from './status.js';
import type { DiscoveryHealthUnavailableProjection } from '../discovery/discovery-health.js';
import type { DiscoveryDriftStatusProjection } from './discovery-drift-status.js';

// ─── Test Helpers ──────────────────────────────────────────────────────────────

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
    reviewLoop: null,
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

describe('golden fixtures', () => {
  it('buildNoSessionDocument matches golden output', async () => {
    const doc = buildNoSessionDocument();
    const output = renderMarkdown(doc);
    const golden = await readGolden('status-no-session.md');
    expect(output).toBe(golden.trimEnd());
  });

  it('ready state produces expected structure', () => {
    const projection = makeBaseProjection();
    const drift = makeDriftProjection();
    const doc = buildStatusDocument({
      status: projection,
      discoveryHealth: null,
      discoveryDrift: drift,
    });
    const output = renderMarkdown(doc);

    // Phase and Policy always first
    const lines = output.split('\n');
    expect(lines[0]).toBe('**Phase:** Ready');
    expect(lines[1]).toBe('**Policy:** solo');

    // Evidence summary present
    expect(output).toContain('**Verified:** 0');
    expect(output).toContain('**Missing:** 0');
    expect(output).toContain('**Not yet required:** 7');

    // Allowed commands rendered as available actions
    expect(output).toContain('• `/ticket`');
    expect(output).toContain('• `/architecture`');
    expect(output).toContain('• `/review`');

    // Conclusion is the last line with recommendation
    expect(lines[lines.length - 1]).toContain('→ `/hydrate`');
  });

  it('blocked state renders blocker and decision_required', () => {
    const projection = makeBaseProjection({
      phase: 'PLAN_REVIEW',
      phaseLabel: 'Ready for plan approval',
      blocker: {
        reasonCode: 'PLAN_REVIEW_REQUIRED',
        reasonText: 'A human review decision is required.',
      },
      productNextAction: {
        primaryCommand: '/review-decision',
        summary: 'Run /review-decision and choose a verdict.',
      },
      conclusion: {
        kind: 'decision_required',
        question: 'Awaiting plan review decision (approve / changes_requested / reject)',
        actions: [
          {
            invocation: '/approve',
            description: 'Accept the reviewed work and advance.',
            visibility: 'available' as const,
          },
          {
            invocation: '/request-changes',
            description: 'Request revisions to the reviewed work.',
            visibility: 'available' as const,
          },
          {
            invocation: '/reject',
            description: 'Reject the reviewed work.',
            visibility: 'available' as const,
          },
        ],
      },
    });
    const drift = makeDriftProjection();
    const doc = buildStatusDocument({
      status: projection,
      discoveryHealth: null,
      discoveryDrift: drift,
    });
    const output = renderMarkdown(doc);

    // Phase
    expect(output).toContain('**Phase:** Ready for plan approval');
    // Blocker section
    expect(output).toContain('`PLAN_REVIEW_REQUIRED`');
    expect(output).toContain('⚠ **Blocked:**');
    expect(output).toContain('A human review decision is required.');
    // Recovery
    expect(output).toContain('**Recovery:** Run /review-decision and choose a verdict.');
    // Evidence
    expect(output).toContain('**Verified:** 0');
    // Question
    expect(output).toContain('Awaiting plan review decision');
    // Decision actions
    expect(output).toContain('• `/approve` — Accept the reviewed work and advance.');
    expect(output).toContain('• `/request-changes` — Request revisions to the reviewed work.');
    expect(output).toContain('• `/reject` — Reject the reviewed work.');
    // No recommendation arrow (all available, none recommended)
    const lastLine = output.split('\n').pop()!;
    expect(lastLine).toContain('• `/reject`');
  });

  it('degraded discovery renders notice section', () => {
    const projection = makeBaseProjection({
      phase: 'VALIDATION',
      phaseLabel: 'Validation',
    });
    const drift = makeDriftProjection({
      status: 'drifted',
      drifted: true,
      notVerified: ['Discovery drift', 'Code-surface completeness'],
    });
    const health = makeDegradedDiscoveryHealth();
    const doc = buildStatusDocument({
      status: projection,
      discoveryHealth: health,
      discoveryDrift: drift,
    });
    const output = renderMarkdown(doc);

    // Phase
    expect(output).toContain('**Phase:** Validation');
    // Notice section
    expect(output).toContain('⚠');
    expect(output).toContain('Discovery data is degraded or unavailable.');
    expect(output).toContain('Runtime workflow authority is unchanged.');
    expect(output).toContain('**Reason:** missing');
    expect(output).toContain('**Recovery:** Run /hydrate to refresh discovery data.');
    expect(output).toContain('**Not verified:**');
    // Conclusion
    expect(output).toContain('→ `/hydrate`');
  });
});

// ─── Projection Tests ──────────────────────────────────────────────────────────

describe('buildStatusDocument', () => {
  it('produces a compact_card document', () => {
    const projection = makeBaseProjection();
    const drift = makeDriftProjection();
    const doc = buildStatusDocument({
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
    const doc = buildStatusDocument({
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
    const doc = buildStatusDocument({
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
    const doc = buildStatusDocument({
      status: projection,
      discoveryHealth: null,
      discoveryDrift: drift,
    });
    const result = renderMarkdown(doc);
    expect(result).toContain('Blocked');
    expect(result).toContain('`MISSING`');
  });

  it('omits blocker section when not blocked', () => {
    const projection = makeBaseProjection();
    const drift = makeDriftProjection();
    const doc = buildStatusDocument({
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
    const doc = buildStatusDocument({
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
    const doc = buildStatusDocument({
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
    const doc = buildStatusDocument({
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
    const doc = buildStatusDocument({
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
    const doc = buildStatusDocument({
      status: projection,
      discoveryHealth: null,
      discoveryDrift: drift,
    });
    const result = renderMarkdown(doc);
    expect(result).toContain('• `/ticket`');
    expect(result).toContain('• `/architecture`');
    expect(result).toContain('• `/review`');
  });

  it('omits failed evidence row when count is zero', () => {
    const projection = makeBaseProjection({
      evidenceSummary: { present: 2, missing: 0, notYetRequired: 5, failed: 0 },
    });
    const drift = makeDriftProjection();
    const doc = buildStatusDocument({
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
    const doc = buildStatusDocument({
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

  it('recommends /hydrate', () => {
    const doc = buildNoSessionDocument();
    expect(doc.conclusion.kind).toBe('next_action');
    if (doc.conclusion.kind === 'next_action') {
      expect(doc.conclusion.action.invocation).toBe('/hydrate');
      expect(doc.conclusion.action.visibility).toBe('recommended');
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
    const doc = buildStatusDocument({
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
    const doc = buildStatusDocument({
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
    const doc = buildStatusDocument({
      status: projection,
      discoveryHealth: health,
      discoveryDrift: drift,
    });
    const result = renderMarkdown(doc);
    expect(result).toContain('?');
    expect(result).toContain('Discovery');
  });
});

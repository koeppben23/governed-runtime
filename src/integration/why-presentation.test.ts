/**
 * @module integration/why-presentation.test
 * @description Integration tests for buildWhyDocument + golden fixture verification.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { SessionState } from '../state/schema.js';
import type { BlockedProjection } from './status.js';
import { renderMarkdown } from '../presentation/markdown.js';
import { buildWhyDocument } from './why-presentation.js';
import { buildBlockedProjection } from './status.js';
import { buildWhyPresentationProjection } from './status-why-finish.js';
import { makeState, makeProgressedState } from '../fixtures.js';
import { getPolicyPreset } from '../config/policy.js';
import { createPolicySnapshot } from '../config/policy-snapshot.js';

function sp(mode: 'solo' | 'team') {
  return createPolicySnapshot(getPolicyPreset(mode), '2026-01-01T00:00:00.000Z', () => 'd');
}

/** SOLO-policy READY-phase state — minimal, no evidence. */
function readyState(): SessionState {
  return {
    ...makeState('READY'),
    policySnapshot: sp('solo'),
    activeChecks: [],
    verificationCandidates: [],
  };
}

/** TEAM-policy PLAN_REVIEW with evidence (ticket + plan). */
function planReviewBlockedState(): SessionState {
  return makeProgressedState('PLAN_REVIEW');
}

/** VALIDATION + team policy — evidence gap. */
function validationState(): SessionState {
  return {
    ...makeState('VALIDATION'),
    policySnapshot: sp('team'),
    activeChecks: [],
    verificationCandidates: [],
  };
}

/** TICKET + solo — not blocked, active. */
function ticketState(): SessionState {
  return {
    ...makeState('TICKET'),
    policySnapshot: sp('solo'),
    activeChecks: [],
    verificationCandidates: [],
  };
}

/** COMPLETE + verified archive + solo policy. */
function completeVerifiedState(): SessionState {
  return {
    ...makeProgressedState('COMPLETE'),
    archiveStatus: 'verified',
    policySnapshot: sp('solo'),
    actorInfo: undefined,
  };
}

async function readGolden(name: string): Promise<string> {
  const path = resolve(__dirname, '..', '..', 'testdata', 'presentation', name);
  return readFile(path, 'utf-8');
}

// ─── Golden Tests ──────────────────────────────────────────────────────────────

describe('golden fixtures for /why', () => {
  it('why-blocked-plan-review matches golden output', async () => {
    const state = planReviewBlockedState();
    const policy = getPolicyPreset('team');
    const blocker = buildBlockedProjection(state, policy);
    const pres = buildWhyPresentationProjection(state, policy, blocker);
    const output = renderMarkdown(buildWhyDocument(pres));
    const golden = await readGolden('why-blocked-plan-review.md');
    expect(output).toBe(golden.trimEnd());
    // Canonical: waiting gate at PLAN_REVIEW → decision_required
    expect(pres.conclusion.kind).toBe('decision_required');
  });

  it('why-evidence-gap matches golden output', async () => {
    const state = validationState();
    const policy = getPolicyPreset('team');
    const blocker = buildBlockedProjection(state, policy);
    const pres = buildWhyPresentationProjection(state, policy, blocker);
    const output = renderMarkdown(buildWhyDocument(pres));
    const golden = await readGolden('why-evidence-gap.md');
    expect(output).toBe(golden.trimEnd());
  });

  it('why-not-blocked-active matches golden output', async () => {
    const state = ticketState();
    const policy = getPolicyPreset('solo');
    const blocker = buildBlockedProjection(state, policy);
    const pres = buildWhyPresentationProjection(state, policy, blocker);
    const output = renderMarkdown(buildWhyDocument(pres));
    const golden = await readGolden('why-not-blocked-active.md');
    expect(output).toBe(golden.trimEnd());
    // Active non-blocked state → next_action
    expect(pres.conclusion.kind).toBe('next_action');
  });

  it('why-complete-verified matches golden output', async () => {
    const state = completeVerifiedState();
    const policy = getPolicyPreset('solo');
    const blocker = buildBlockedProjection(state, policy);
    const pres = buildWhyPresentationProjection(state, policy, blocker);
    const output = renderMarkdown(buildWhyDocument(pres));
    const golden = await readGolden('why-complete-verified.md');
    expect(output).toBe(golden.trimEnd());
    // COMPLETE + verified archive → machine-terminal with product next_action
    expect(pres.conclusion.kind).toBe('next_action');
  });
});

// ─── Projection Tests ──────────────────────────────────────────────────────────

describe('buildWhyDocument', () => {
  it('produces a compact_card document', () => {
    const state = ticketState();
    const policy = getPolicyPreset('solo');
    const blocker = buildBlockedProjection(state, policy);
    const doc = buildWhyDocument(buildWhyPresentationProjection(state, policy, blocker));
    expect(doc.kind).toBe('compact_card');
    if (doc.kind === 'compact_card') expect(doc.density).toBe('compact');
  });

  it('shows Blocked: Blocked when blocked at gate', () => {
    const state = planReviewBlockedState();
    const policy = getPolicyPreset('team');
    const blocker = buildBlockedProjection(state, policy);
    const doc = buildWhyDocument(buildWhyPresentationProjection(state, policy, blocker));
    expect(renderMarkdown(doc)).toContain('**Blocked:** Blocked');
  });

  it('shows Blocked: No when not blocked', () => {
    const state = ticketState();
    const policy = getPolicyPreset('solo');
    const blocker = buildBlockedProjection(state, policy);
    const doc = buildWhyDocument(buildWhyPresentationProjection(state, policy, blocker));
    expect(renderMarkdown(doc)).toContain('**Blocked:** No');
  });

  it('includes blocker section at review gate', () => {
    const state = planReviewBlockedState();
    const policy = getPolicyPreset('team');
    const blocker = buildBlockedProjection(state, policy);
    const doc = buildWhyDocument(buildWhyPresentationProjection(state, policy, blocker));
    const output = renderMarkdown(doc);
    expect(output).toContain('## Blocked');
    expect(output).toContain('⚠ **Blocked:**');
  });

  it('projects migrated headline, explanation, and canonical message on the why surface', () => {
    const state = planReviewBlockedState();
    const policy = getPolicyPreset('team');
    const blocker: BlockedProjection = {
      blocked: true,
      reasonCode: 'PROOFGRAPH_CRITICAL_FACT_REQUIRED',
      reasonText: 'registry-verbatim interpolated message',
      recoveryHint: null,
      missingEvidence: [],
      nextResolvableCommand: null,
      humanActionRequired: true,
    };
    const doc = buildWhyDocument(buildWhyPresentationProjection(state, policy, blocker));
    const output = renderMarkdown(doc);
    // Headline replaces the registry-verbatim message on the human surface.
    expect(output).toContain(
      'Evidence approval requires a critical, certificate-authorized fact claim',
    );
    expect(output).not.toContain('registry-verbatim interpolated message');
    // The human-authored explanation and the verbatim canonical message are preserved.
    expect(output).toContain('**Why:** The declared risk triggers require at least one critical');
    expect(output).toContain('**Details:**');
    expect(output).toContain(
      'Evidence approval is blocked because {triggers} requires at least one critical, certificate-authorized fact claim.',
    );
  });

  it('omits blocker section when not blocked', () => {
    const state = ticketState();
    const policy = getPolicyPreset('solo');
    const blocker = buildBlockedProjection(state, policy);
    const doc = buildWhyDocument(buildWhyPresentationProjection(state, policy, blocker));
    expect(renderMarkdown(doc)).not.toContain('## Blocked');
  });

  it('includes missing evidence artifactList in evidence-gap state', () => {
    const state = validationState();
    const policy = getPolicyPreset('team');
    const blocker = buildBlockedProjection(state, policy);
    const doc = buildWhyDocument(buildWhyPresentationProjection(state, policy, blocker));
    expect(renderMarkdown(doc)).toContain('## Missing evidence');
  });

  it('produces decision_required at waiting gate', () => {
    const state = planReviewBlockedState();
    const policy = getPolicyPreset('team');
    const blocker = buildBlockedProjection(state, policy);
    const doc = buildWhyDocument(buildWhyPresentationProjection(state, policy, blocker));
    const c = doc.conclusion;
    if (!c) throw new Error('no conclusion');
    expect(c.kind).toBe('decision_required');
    if (c.kind === 'decision_required') expect(c.actions.length).toBeGreaterThan(1);
  });

  it('produces next_action for active state', () => {
    const state = ticketState();
    const policy = getPolicyPreset('solo');
    const blocker = buildBlockedProjection(state, policy);
    const doc = buildWhyDocument(buildWhyPresentationProjection(state, policy, blocker));
    const c = doc.conclusion;
    if (!c) throw new Error('no conclusion');
    expect(c.kind).toBe('next_action');
  });
});

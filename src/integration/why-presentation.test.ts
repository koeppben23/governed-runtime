/**
 * @module integration/why-presentation.test
 * @description Integration tests for buildWhyDocument + golden fixture verification.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { renderMarkdown } from '../presentation/markdown.js';
import { buildWhyDocument } from './why-presentation.js';
import { buildBlockedProjection } from './status.js';
import { buildWhyPresentationProjection } from './status-why-finish.js';
import { makeState } from '../fixtures.js';
import { getPolicyPreset } from '../config/policy.js';
import { createPolicySnapshot } from '../config/policy-snapshot.js';

function sp(mode: string) {
  return createPolicySnapshot(getPolicyPreset(mode as any), '2026-01-01T00:00:00.000Z', () => 'd');
}

/** Build a session state for testing. */
function bs(phase: string, mode = 'solo'): any {
  return {
    ...makeState(phase as any),
    id: 't-' + phase + '-' + mode,
    phase,
    policySnapshot: sp(mode),
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
    const state = bs('PLAN_REVIEW', 'team');
    const policy = getPolicyPreset('team');
    const blocker = buildBlockedProjection(state as any, policy);
    const pres = buildWhyPresentationProjection(state as any, policy, blocker);
    const output = renderMarkdown(buildWhyDocument(pres));
    const golden = await readGolden('why-blocked-plan-review.md');
    expect(output).toBe(golden.trimEnd());
  });

  it('why-evidence-gap matches golden output', async () => {
    const state = bs('VALIDATION', 'team');
    const policy = getPolicyPreset('team');
    const blocker = buildBlockedProjection(state as any, policy);
    const pres = buildWhyPresentationProjection(state as any, policy, blocker);
    const output = renderMarkdown(buildWhyDocument(pres));
    const golden = await readGolden('why-evidence-gap.md');
    expect(output).toBe(golden.trimEnd());
  });

  it('why-not-blocked-active matches golden output', async () => {
    const state = bs('TICKET');
    const policy = getPolicyPreset('solo');
    const blocker = buildBlockedProjection(state as any, policy);
    const pres = buildWhyPresentationProjection(state as any, policy, blocker);
    const output = renderMarkdown(buildWhyDocument(pres));
    const golden = await readGolden('why-not-blocked-active.md');
    expect(output).toBe(golden.trimEnd());
  });

  it('why-terminal matches golden output', async () => {
    const state = bs('COMPLETE');
    const policy = getPolicyPreset('solo');
    const blocker = buildBlockedProjection(state as any, policy);
    const pres = buildWhyPresentationProjection(state as any, policy, blocker);
    const output = renderMarkdown(buildWhyDocument(pres));
    const golden = await readGolden('why-terminal.md');
    expect(output).toBe(golden.trimEnd());
  });
});

// ─── Projection Tests ──────────────────────────────────────────────────────────

describe('buildWhyDocument', () => {
  it('produces a compact_card document', () => {
    const state = bs('TICKET');
    const policy = getPolicyPreset('solo');
    const blocker = buildBlockedProjection(state as any, policy);
    const doc = buildWhyDocument(buildWhyPresentationProjection(state as any, policy, blocker));
    expect(doc.kind).toBe('compact_card');
    if (doc.kind === 'compact_card') expect(doc.density).toBe('compact');
  });

  it('shows Blocked: Blocked when blocked is true', () => {
    const state = bs('PLAN_REVIEW', 'team');
    const policy = getPolicyPreset('team');
    const blocker = buildBlockedProjection(state as any, policy);
    const doc = buildWhyDocument(buildWhyPresentationProjection(state as any, policy, blocker));
    expect(renderMarkdown(doc)).toContain('**Blocked:** Blocked');
  });

  it('shows Blocked: No when blocked is false', () => {
    const state = bs('TICKET');
    const policy = getPolicyPreset('solo');
    const blocker = buildBlockedProjection(state as any, policy);
    const doc = buildWhyDocument(buildWhyPresentationProjection(state as any, policy, blocker));
    expect(renderMarkdown(doc)).toContain('**Blocked:** No');
  });

  it('includes blocker section with ## Blocked heading when blocked at gate', () => {
    const state = bs('PLAN_REVIEW', 'team');
    const policy = getPolicyPreset('team');
    const blocker = buildBlockedProjection(state as any, policy);
    const doc = buildWhyDocument(buildWhyPresentationProjection(state as any, policy, blocker));
    const output = renderMarkdown(doc);
    expect(output).toContain('## Blocked');
    expect(output).toContain('⚠ **Blocked:**');
  });

  it('omits blocker section when no reason code or text', () => {
    const state = bs('TICKET');
    const policy = getPolicyPreset('solo');
    const blocker = buildBlockedProjection(state as any, policy);
    const doc = buildWhyDocument(buildWhyPresentationProjection(state as any, policy, blocker));
    const output = renderMarkdown(doc);
    expect(output).not.toContain('## Blocked');
    expect(output).not.toContain('## Evidence required');
  });

  it('includes artifactList for missing evidence when present', () => {
    const state = bs('PLAN_REVIEW', 'team');
    const policy = getPolicyPreset('team');
    const blocker = buildBlockedProjection(state as any, policy);
    const doc = buildWhyDocument(buildWhyPresentationProjection(state as any, policy, blocker));
    const output = renderMarkdown(doc);
    expect(output).toContain('## Missing evidence');
  });

  it('decision_required has multiple actions at review gate', () => {
    const state = bs('PLAN_REVIEW', 'team');
    const policy = getPolicyPreset('team');
    const blocker = buildBlockedProjection(state as any, policy);
    const doc = buildWhyDocument(buildWhyPresentationProjection(state as any, policy, blocker));
    const c = doc.conclusion;
    if (!c) throw new Error('no conclusion');
    expect(c.kind).toBe('decision_required');
    if (c.kind === 'decision_required') expect(c.actions.length).toBeGreaterThan(1);
  });

  it('next_action conclusion for complete state', () => {
    const state = bs('COMPLETE');
    const policy = getPolicyPreset('solo');
    const blocker = buildBlockedProjection(state as any, policy);
    const doc = buildWhyDocument(buildWhyPresentationProjection(state as any, policy, blocker));
    const c = doc.conclusion;
    if (!c) throw new Error('no conclusion');
    expect(c.kind).toBe('next_action');
  });

  it('next_action conclusion for active non-blocked state', () => {
    const state = bs('TICKET');
    const policy = getPolicyPreset('solo');
    const blocker = buildBlockedProjection(state as any, policy);
    const doc = buildWhyDocument(buildWhyPresentationProjection(state as any, policy, blocker));
    const c = doc.conclusion;
    if (!c) throw new Error('no conclusion');
    expect(c.kind).toBe('next_action');
  });
});

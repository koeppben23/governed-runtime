/**
 * @module integration/finish-presentation.test
 * @description Integration tests for buildFinishDocument + golden fixture verification.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { SessionState } from '../state/schema.js';
import { renderMarkdown } from '../presentation/markdown.js';
import { buildFinishDocument } from './finish-presentation.js';
import { buildFinishCard } from './status-finish.js';
import { buildFinishPresentationProjection } from './status-why-finish.js';
import { makeState, makeProgressedState } from '../fixtures.js';
import { getPolicyPreset } from '../config/policy.js';
import { createPolicySnapshot } from '../config/policy-snapshot.js';

function sp(mode: 'solo' | 'team') {
  return createPolicySnapshot(getPolicyPreset(mode), '2026-01-01T00:00:00.000Z', () => 'd');
}

function completeState(extras: Record<string, unknown> = {}): SessionState {
  return {
    ...makeProgressedState('COMPLETE'),
    archiveStatus: 'verified',
    policySnapshot: sp('solo'),
    actorInfo: undefined,
    ...extras,
  };
}

function planReviewBlockedState(): SessionState {
  return makeProgressedState('PLAN_REVIEW');
}

function ticketState(): SessionState {
  return {
    ...makeState('TICKET'),
    policySnapshot: sp('solo'),
    activeChecks: [],
    verificationCandidates: [],
  };
}

async function readGolden(name: string): Promise<string> {
  const path = resolve(__dirname, '..', '..', 'testdata', 'presentation', name);
  return readFile(path, 'utf-8');
}

// ─── Golden Tests ──────────────────────────────────────────────────────────────

describe('golden fixtures for /finish', () => {
  it('finish-ready matches golden output', async () => {
    const state = completeState();
    const policy = getPolicyPreset('solo');
    const card = buildFinishCard(state, policy);
    const pres = buildFinishPresentationProjection(state, card);
    const output = renderMarkdown(buildFinishDocument(pres));
    const golden = await readGolden('finish-ready.md');
    expect(output).toBe(golden.trimEnd());
    // Full evidence, terminal, solo → READY
    expect(card.overallStatus).toBe('READY');
  });

  it('finish-ready-with-warnings matches golden output', async () => {
    const warnSnapshot = createPolicySnapshot(
      {
        ...getPolicyPreset('solo'),
        selfReview: { subagentEnabled: false, fallbackToSelf: true, strictEnforcement: false },
      } as any,
      '2026-01-01T00:00:00.000Z',
      () => 'd',
    );
    const state = completeState({ policySnapshot: warnSnapshot });
    const policy = getPolicyPreset('solo');
    const card = buildFinishCard(state, policy);
    const pres = buildFinishPresentationProjection(state, card);
    const output = renderMarkdown(buildFinishDocument(pres));
    const golden = await readGolden('finish-ready-with-warnings.md');
    expect(output).toBe(golden.trimEnd());
    // Legacy selfReview config → READY_WITH_WARNINGS
    expect(card.overallStatus).toBe('READY_WITH_WARNINGS');
    expect(card.warnings.length).toBeGreaterThan(0);
  });

  it('finish-blocked matches golden output', async () => {
    const state = planReviewBlockedState();
    const policy = getPolicyPreset('team');
    const card = buildFinishCard(state, policy);
    const pres = buildFinishPresentationProjection(state, card);
    const output = renderMarkdown(buildFinishDocument(pres));
    const golden = await readGolden('finish-blocked.md');
    expect(output).toBe(golden.trimEnd());
    expect(card.overallStatus).toBe('BLOCKED');
  });

  it('finish-not-verified matches golden output', async () => {
    const state = ticketState();
    const policy = getPolicyPreset('solo');
    const card = buildFinishCard(state, policy);
    const pres = buildFinishPresentationProjection(state, card);
    const output = renderMarkdown(buildFinishDocument(pres));
    const golden = await readGolden('finish-not-verified.md');
    expect(output).toBe(golden.trimEnd());
    // Missing evidence → NOT_VERIFIED
    expect(card.overallStatus).toBe('NOT_VERIFIED');
  });
});

// ─── Projection Tests ──────────────────────────────────────────────────────────

describe('buildFinishDocument', () => {
  it('produces a compact_card document', () => {
    const state = completeState();
    const doc = buildFinishDocument(
      buildFinishPresentationProjection(state, buildFinishCard(state, getPolicyPreset('solo'))),
    );
    expect(doc.kind).toBe('compact_card');
    if (doc.kind === 'compact_card') expect(doc.density).toBe('compact');
  });

  it('includes archive section when archiveStatus is set', () => {
    const state = completeState();
    const doc = buildFinishDocument(
      buildFinishPresentationProjection(state, buildFinishCard(state, getPolicyPreset('solo'))),
    );
    const output = renderMarkdown(doc);
    expect(output).toContain('## Archive');
    expect(output).toContain('**Status:** Verified');
  });

  it('omits archive section when archiveStatus is null', () => {
    const state = ticketState();
    const doc = buildFinishDocument(
      buildFinishPresentationProjection(state, buildFinishCard(state, getPolicyPreset('solo'))),
    );
    expect(renderMarkdown(doc)).not.toContain('## Archive');
  });

  it('includes blocker section when blocked', () => {
    const state = planReviewBlockedState();
    const doc = buildFinishDocument(
      buildFinishPresentationProjection(state, buildFinishCard(state, getPolicyPreset('team'))),
    );
    expect(renderMarkdown(doc)).toContain('## Blocked');
  });

  it('includes exit options section', () => {
    const state = completeState();
    const doc = buildFinishDocument(
      buildFinishPresentationProjection(state, buildFinishCard(state, getPolicyPreset('solo'))),
    );
    const output = renderMarkdown(doc);
    expect(output).toContain('## Exit options');
    expect(output).toContain('- Abandon this work');
  });

  it('renders warning notice for each warning', () => {
    const warnSnapshot = createPolicySnapshot(
      {
        ...getPolicyPreset('solo'),
        selfReview: { subagentEnabled: false, fallbackToSelf: true, strictEnforcement: false },
      } as any,
      '2026-01-01T00:00:00.000Z',
      () => 'd',
    );
    const state = completeState({ policySnapshot: warnSnapshot });
    const card = buildFinishCard(state, getPolicyPreset('solo'));
    const pres = buildFinishPresentationProjection(state, card);
    const output = renderMarkdown(buildFinishDocument(pres));
    expect(output).toContain('## Warnings');
    expect(output).toContain('⚠');
  });

  it('guarantees are set correctly', () => {
    const state = completeState();
    const card = buildFinishCard(state, getPolicyPreset('solo'));
    expect(card.guarantees).toEqual({
      readOnly: true,
      approves: false,
      consumesObligations: false,
      triggersExport: false,
    });
  });
});

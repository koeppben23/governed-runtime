/**
 * @module integration/finish-presentation.test
 * @description Integration tests for buildFinishDocument + golden fixture verification.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { renderMarkdown } from '../presentation/markdown.js';
import { buildFinishDocument } from './finish-presentation.js';
import { buildFinishCard } from './status.js';
import { buildFinishPresentationProjection } from './status-why-finish.js';
import { makeState } from '../fixtures.js';
import { getPolicyPreset } from '../config/policy.js';
import { createPolicySnapshot } from '../config/policy-snapshot.js';

function sp(mode: string) {
  return createPolicySnapshot(getPolicyPreset(mode as any), '2026-01-01T00:00:00.000Z', () => 'd');
}

function bs(phase: string, mode = 'solo', extras: any = {}): any {
  return {
    ...makeState(phase as any),
    id: 't-fin-' + phase + '-' + mode,
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
    archiveStatus: null,
    actorInfo: undefined,
    ...extras,
  };
}

async function readGolden(name: string): Promise<string> {
  const path = resolve(__dirname, '..', '..', 'testdata', 'presentation', name);
  return readFile(path, 'utf-8');
}

// ─── Golden Tests ──────────────────────────────────────────────────────────────

describe('golden fixtures for /finish', () => {
  it('finish-ready matches golden output', async () => {
    const state = bs('COMPLETE', 'solo', { archiveStatus: 'verified' });
    const policy = getPolicyPreset('solo');
    const card = buildFinishCard(state as any, policy);
    const pres = buildFinishPresentationProjection(state as any, card);
    const output = renderMarkdown(buildFinishDocument(pres));
    const golden = await readGolden('finish-ready.md');
    expect(output).toBe(golden.trimEnd());
  });

  it('finish-ready-with-warnings matches golden output', async () => {
    const state = bs('COMPLETE', 'solo', { archiveStatus: 'verified' });
    const policy = getPolicyPreset('solo');
    const card = buildFinishCard(state as any, policy);
    const cardWithWarnings = {
      ...card,
      warnings: [
        'Legacy policy configuration was normalized.',
        'Self-review config requires plugin verification.',
      ],
    };
    const pres = buildFinishPresentationProjection(state as any, cardWithWarnings);
    const output = renderMarkdown(buildFinishDocument(pres));
    const golden = await readGolden('finish-ready-with-warnings.md');
    expect(output).toBe(golden.trimEnd());
  });

  it('finish-blocked matches golden output', async () => {
    const state = bs('PLAN_REVIEW', 'team');
    const policy = getPolicyPreset('team');
    const card = buildFinishCard(state as any, policy);
    const pres = buildFinishPresentationProjection(state as any, card);
    const output = renderMarkdown(buildFinishDocument(pres));
    const golden = await readGolden('finish-blocked.md');
    expect(output).toBe(golden.trimEnd());
  });

  it('finish-not-verified matches golden output', async () => {
    const state = bs('TICKET');
    const policy = getPolicyPreset('solo');
    const card = buildFinishCard(state as any, policy);
    const pres = buildFinishPresentationProjection(state as any, card);
    const output = renderMarkdown(buildFinishDocument(pres));
    const golden = await readGolden('finish-not-verified.md');
    expect(output).toBe(golden.trimEnd());
  });
});

// ─── Projection Tests ──────────────────────────────────────────────────────────

describe('buildFinishDocument', () => {
  it('produces a compact_card document', () => {
    const state = bs('COMPLETE');
    const policy = getPolicyPreset('solo');
    const card = buildFinishCard(state as any, policy);
    const doc = buildFinishDocument(buildFinishPresentationProjection(state as any, card));
    expect(doc.kind).toBe('compact_card');
    if (doc.kind === 'compact_card') expect(doc.density).toBe('compact');
  });

  it('renders guidance section with correct symbols', () => {
    const state = bs('COMPLETE');
    const policy = getPolicyPreset('solo');
    const card = buildFinishCard(state as any, policy);
    const doc = buildFinishDocument(buildFinishPresentationProjection(state as any, card));
    expect(renderMarkdown(doc)).toContain('## Guidance');
  });

  it('includes archive section when archiveStatus is set', () => {
    const state = bs('COMPLETE', 'solo', { archiveStatus: 'verified' });
    const policy = getPolicyPreset('solo');
    const card = buildFinishCard(state as any, policy);
    const doc = buildFinishDocument(buildFinishPresentationProjection(state as any, card));
    const output = renderMarkdown(doc);
    expect(output).toContain('## Archive');
    expect(output).toContain('**Status:** Verified');
  });

  it('omits archive section when archiveStatus is null', () => {
    const state = bs('TICKET');
    const policy = getPolicyPreset('solo');
    const card = buildFinishCard(state as any, policy);
    const doc = buildFinishDocument(buildFinishPresentationProjection(state as any, card));
    expect(renderMarkdown(doc)).not.toContain('## Archive');
  });

  it('includes blocker section when blocked', () => {
    const state = bs('PLAN_REVIEW', 'team');
    const policy = getPolicyPreset('team');
    const card = buildFinishCard(state as any, policy);
    const doc = buildFinishDocument(buildFinishPresentationProjection(state as any, card));
    expect(renderMarkdown(doc)).toContain('## Blocked');
  });

  it('includes exit options section', () => {
    const state = bs('COMPLETE');
    const policy = getPolicyPreset('solo');
    const card = buildFinishCard(state as any, policy);
    const doc = buildFinishDocument(buildFinishPresentationProjection(state as any, card));
    const output = renderMarkdown(doc);
    expect(output).toContain('## Exit options');
    expect(output).toContain('• Abandon this work');
  });

  it('renders warning notice for each warning', () => {
    const state = bs('COMPLETE', 'solo', { archiveStatus: 'verified' });
    const policy = getPolicyPreset('solo');
    const card = buildFinishCard(state as any, policy);
    const cardWithWarnings = { ...card, warnings: ['Warning one.', 'Warning two.'] };
    const pres = buildFinishPresentationProjection(state as any, cardWithWarnings);
    const output = renderMarkdown(buildFinishDocument(pres));
    expect(output).toContain('## Warnings');
    expect(output).toContain('⚠ Warning one.');
    expect(output).toContain('⚠ Warning two.');
  });

  it('conclusion is next_action with command', () => {
    const state = bs('COMPLETE', 'solo', { archiveStatus: 'verified' });
    const policy = getPolicyPreset('solo');
    const card = buildFinishCard(state as any, policy);
    const doc = buildFinishDocument(buildFinishPresentationProjection(state as any, card));
    const c = doc.conclusion;
    if (!c) throw new Error('no conclusion');
    expect(c.kind).toBe('next_action');
  });

  it('guarantees are set correctly in finish card', () => {
    const state = bs('COMPLETE');
    const policy = getPolicyPreset('solo');
    const card = buildFinishCard(state as any, policy);
    expect(card.guarantees).toEqual({
      readOnly: true,
      approves: false,
      consumesObligations: false,
      triggersExport: false,
    });
  });
});

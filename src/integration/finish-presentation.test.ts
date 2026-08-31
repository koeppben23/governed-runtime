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
import { hashText } from '../shared/hashing.js';
import { canonicalJsonStringify } from '../shared/canonical-json.js';

function sp(mode: 'solo' | 'team') {
  return createPolicySnapshot(getPolicyPreset(mode), '2026-01-01T00:00:00.000Z', hashText);
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
      hashText,
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

  it('projects migrated headline, explanation, and canonical message on a gated finish', () => {
    // EVIDENCE_REVIEW with an approved plan but no persisted proofGraph: the
    // Evidence gate resolves to evaluation_unavailable (PROOFGRAPH_* migrated).
    const claimId = '00000000-0000-4000-8000-000000000001';
    const declarations = {
      flow: 'plan' as const,
      version: 'v2' as const,
      claims: [
        {
          claimId,
          statement: 'x',
          critical: true,
          authoritySectionId: 's1',
          claimScope: 'specific_behavior' as const,
          expectedCheckId: 'test',
        },
      ],
    };
    const certificate = {
      flow: 'plan' as const,
      authorityDigest: 'plan-digest',
      claimDeclarationsDigest: hashText(canonicalJsonStringify(declarations)),
      decisionAttestationDigest: 'd',
      approvedAt: '2026-01-01T00:00:00.000Z',
      approvedBy: 'reviewer',
      certificateId: '00000000-0000-4000-8000-0000000000ce',
      planVersion: 1,
      planRecordDigest: 'record-digest',
      reviewBinding: {
        kind: 'current_review' as const,
        reviewObligationId: '00000000-0000-4000-8000-0000000000cd',
        reviewEvidenceDigest: 'e'.repeat(64),
        reviewedSubjectDigest: 'plan-digest',
      },
      reviewObligationId: '00000000-0000-4000-8000-0000000000cd',
      reviewEvidenceDigest: 'e'.repeat(64),
    };
    const state: SessionState = {
      ...makeProgressedState('EVIDENCE_REVIEW'),
      policySnapshot: createPolicySnapshot(
        getPolicyPreset('team'),
        '2026-01-01T00:00:00.000Z',
        hashText,
      ),
      plan: {
        current: {
          body: 'x',
          digest: 'plan-digest',
          sections: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          recordDigest: 'record-digest',
          planVersion: 1,
          supersedesRecordDigest: null,
          originatingReviewObligationId: null,
          revisionReason: null,
          lineageStatus: 'verified',
        },
        history: [],
        claimDeclarations: declarations,
        approvalCertificate: certificate,
      },
      proofGraph: undefined,
    };
    const card = buildFinishCard(state, getPolicyPreset('team'));
    const doc = buildFinishDocument(buildFinishPresentationProjection(state, card));
    const output = renderMarkdown(doc);
    expect(card.blocker.reasonCode).toBe('PROOFGRAPH_EVALUATION_UNAVAILABLE');
    // Headline replaces the registry-verbatim message on the human surface.
    expect(output).toContain(
      'Evidence approval is blocked because critical claims have no proof evaluation',
    );
    // The human-authored explanation and the verbatim canonical message are preserved.
    expect(output).toContain(
      '**Why:** Certificate-authorized critical plan claims have no persisted ProofGraph evaluation',
    );
    expect(output).toContain('**Details:**');
    expect(output).toContain(
      'Evidence approval is blocked because certificate-authorized critical plan claim(s) have no persisted ProofGraph evaluation: {claimIds}.',
    );
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
      hashText,
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

  it('includes proofSummary with completion context when proofGraph exists', () => {
    const state = completeState({
      proofGraph: {
        version: 'proofgraph.v1' as const,
        claims: [
          {
            claimId: '99999999-9999-9999-9999-999999999999',
            statement: 'Test claim',
            signalClass: 'fact' as const,
            critical: true,
            provenance: {
              kind: 'canonical_authority' as const,
              authorityId: 'plan',
              digest: 'aaaa'.repeat(16),
              approval: {
                certificateId: '11111111-1111-1111-1111-111111111111',
                claimDeclarationsDigest: 'b'.repeat(64),
                decisionAttestationDigest: 'c'.repeat(64),
                declarationId: '22222222-2222-2222-2222-222222222222',
              },
            },
            evidenceRefs: [],
            counterexampleRefs: [],
            verificationState: 'PROVEN' as const,
          },
        ],
        evaluatedAt: '2025-01-01T00:00:00Z',
      },
      implementation: {
        changedFiles: ['src/foo.ts'],
        domainFiles: ['src/foo.ts'],
        digest: 'impl-digest',
        executedAt: '2025-01-01T00:00:00Z',
      },
    });
    const card = buildFinishCard(state, getPolicyPreset('solo'));
    expect(card.proofSummary).toBeDefined();
    expect(card.proofSummary?.kind).toBe('evaluation');
    if (card.proofSummary?.kind === 'evaluation') {
      expect(card.proofSummary.decisionContext).toBe('completion');
    }
  });

  it('renders ProofGraph section in finish document markdown when proofGraph exists', () => {
    const state = completeState({
      proofGraph: {
        version: 'proofgraph.v1' as const,
        claims: [
          {
            claimId: '88888888-8888-8888-8888-888888888888',
            statement: 'Test claim',
            signalClass: 'fact' as const,
            critical: true,
            provenance: {
              kind: 'canonical_authority' as const,
              authorityId: 'plan',
              digest: 'aaaa'.repeat(16),
              approval: {
                certificateId: '11111111-1111-1111-1111-111111111111',
                claimDeclarationsDigest: 'b'.repeat(64),
                decisionAttestationDigest: 'c'.repeat(64),
                declarationId: '22222222-2222-2222-2222-222222222222',
              },
            },
            evidenceRefs: [],
            counterexampleRefs: [],
            verificationState: 'PROVEN' as const,
          },
        ],
        evaluatedAt: '2025-01-01T00:00:00Z',
      },
      implementation: {
        changedFiles: ['src/foo.ts'],
        domainFiles: ['src/foo.ts'],
        digest: 'impl-digest',
        executedAt: '2025-01-01T00:00:00Z',
      },
    });
    const card = buildFinishCard(state, getPolicyPreset('solo'));
    const pres = buildFinishPresentationProjection(state, card);
    const doc = buildFinishDocument(pres);
    const markdown = renderMarkdown(doc);
    expect(markdown).toContain('## Verification');
    expect(markdown).toContain('1 of 1 claims verified');
  });
});

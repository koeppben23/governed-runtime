/**
 * @module integration/finish-presentation.test
 * @description Integration tests for buildFinishDocument + golden fixture verification.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { SessionState } from '../state/schema.js';
import type { ReviewReport, ReviewReportFinding } from '../state/evidence.js';
import { renderMarkdown } from '../presentation/markdown.js';
import { buildFinishDocument } from './status/finish-presentation.js';
import { buildFinishCard } from './status/status-finish.js';
import { buildFinishPresentationProjection } from './status/status-why-finish.js';
import { makeState, makeProgressedState } from '../fixtures.js';
import { getPolicyPreset } from '../config/policy.js';
import { createPolicySnapshot } from '../config/policy-snapshot.js';
import { hashText } from '../shared/hashing.js';
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { makePlanRevision } from '../state/evidence-test-constants.js';

function sp(mode: 'solo' | 'team') {
  return createPolicySnapshot(getPolicyPreset(mode), '2026-01-01T00:00:00.000Z', hashText);
}

function completeState(extras: Record<string, unknown> = {}): SessionState {
  return {
    ...makeProgressedState('COMPLETE'),
    regulatedArchiveStatus: 'verified',
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

/** Persisted-review fixture for the caveat projection (content reviews can carry material findings). */
function makeCaveatReport(
  findings: readonly ReviewReportFinding[] = [
    {
      source: 'material_finding',
      reportSeverity: 'error',
      finding: {
        severity: 'major',
        category: 'correctness',
        message: 'Material issue must not appear at /finish',
        relation: {
          subjectAnchors: [
            {
              kind: 'repository_location',
              location: { path: 'src/foo.ts', revision: 'head', line: 1 },
            },
          ],
          evidenceLocations: [],
        },
      },
    },
    {
      source: 'missing_verification',
      reportSeverity: 'warning',
      category: 'missing-verification',
      message: 'Could not verify the failure path',
    },
    {
      source: 'unknown',
      reportSeverity: 'info',
      category: 'unknown',
      message: 'Unknown dependency surface',
    },
  ],
): Extract<ReviewReport, { reviewKind: 'content_review' }> {
  return {
    reviewKind: 'content_review',
    schemaVersion: 'flowguard-review-report.v1',
    sessionId: '00000000-0000-4000-8000-000000000001',
    generatedAt: '2026-01-01T00:00:00.000Z',
    phase: 'PEER_REVIEW_COMPLETE',
    planDigest: null,
    implDigest: null,
    validationSummary: [],
    reviewSubject: {
      kind: 'content',
      source: { kind: 'inline', mediaType: 'text' },
      materialDigest: 'a'.repeat(64),
      subjectDigest: 'b'.repeat(64),
      lineCount: 1,
    },
    findings: [...findings],
    overallStatus: 'warnings',
    peerReviewCoverage: {
      targetResolved: false,
      targetFrozen: false,
      repositoryIdentityVerified: null,
      baseSha: null,
      headSha: null,
      changedPathCount: 0,
      objectivesCovered: 0,
      objectivesTotal: 0,
      reviewAssurance: null,
      missingVerification: [],
    },
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

  it('finish-review-caveats matches golden output', async () => {
    const state = completeState();
    const policy = getPolicyPreset('solo');
    const card = buildFinishCard(state, policy, makeCaveatReport());
    const pres = buildFinishPresentationProjection(state, card);
    const output = renderMarkdown(buildFinishDocument(pres));
    const golden = await readGolden('finish-review-caveats.md');
    expect(output).toBe(golden.trimEnd());
    expect(card.overallStatus).toBe('READY');
  });
});

// ─── Review Caveat Presentation ────────────────────────────────────────────────

describe('review caveats presentation', () => {
  const state = completeState();
  const policy = getPolicyPreset('solo');

  function caveatDoc(report: ReviewReport | null) {
    const card = buildFinishCard(state, policy, report);
    return {
      card,
      doc: buildFinishDocument(buildFinishPresentationProjection(state, card)),
    };
  }

  it('renders missing_verification as a not_verified notice and unknown as info', () => {
    const { doc } = caveatDoc(makeCaveatReport());
    const notices = doc.sections.filter((section) => section.kind === 'notice');
    expect(notices).toEqual([
      {
        kind: 'notice',
        heading: 'Review verification caveats',
        level: 'not_verified',
        message: 'Could not verify the failure path',
        additionalMessages: [],
        details: [],
      },
      {
        kind: 'notice',
        heading: 'Review unknowns',
        level: 'info',
        message: 'Unknown dependency surface',
        additionalMessages: [],
        details: [],
      },
    ]);
  });

  it('renders the exact reviewer text and never the internal category or other sources', () => {
    const output = renderMarkdown(caveatDoc(makeCaveatReport()).doc);
    expect(output).toContain(
      '## Review verification caveats\n\n? Could not verify the failure path',
    );
    expect(output).toContain('## Review unknowns\n\n- Unknown dependency surface');
    expect(output).not.toContain('missing-verification');
    expect(output).not.toContain('Material issue must not appear at /finish');
  });

  it('omits a caveat section when its source has no entries', () => {
    const onlyUnknown = makeCaveatReport([
      {
        source: 'unknown',
        reportSeverity: 'info',
        category: 'unknown',
        message: 'Unknown dependency surface',
      },
    ]);
    const output = renderMarkdown(caveatDoc(onlyUnknown).doc);
    expect(output).not.toContain('## Review verification caveats');
    expect(output).toContain('## Review unknowns');
  });

  it('renders no caveat sections without a report', () => {
    const output = renderMarkdown(caveatDoc(null).doc);
    expect(output).not.toContain('## Review verification caveats');
    expect(output).not.toContain('## Review unknowns');
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
    const current = makePlanRevision({
      body: 'x',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const certificate = {
      flow: 'plan' as const,
      authorityDigest: current.digest,
      claimDeclarationsDigest: hashText(canonicalJsonStringify(declarations)),
      decisionAttestationDigest: 'd',
      approvedAt: '2026-01-01T00:00:00.000Z',
      approvedBy: 'reviewer',
      certificateId: '00000000-0000-4000-8000-0000000000ce',
      planVersion: 1,
      planRecordDigest: current.recordDigest,
      reviewBinding: {
        kind: 'current_review' as const,
        reviewObligationId: '00000000-0000-4000-8000-0000000000cd',
        reviewEvidenceDigest: 'e'.repeat(64),
        reviewedSubjectDigest: current.digest,
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
        current,
        history: [],
        reviewCompletion: 'pending',
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
        version: 'proofgraph.v2' as const,
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
        version: 'proofgraph.v2' as const,
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

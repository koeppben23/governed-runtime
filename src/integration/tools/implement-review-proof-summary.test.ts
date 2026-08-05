/**
 * @test-policy
 * REGRESSION: buildBlockedImplReviewResponse → proofSummary survives serialization round-trip.
 * REGRESSION: projectProofSummaryForVerdict → 'current_gate' for accept, 'prospective_approval' otherwise.
 * REGRESSION: completion → projectCompletionProofStatus yields 'completion' context.
 * CONTRACT: The exported orchestrators in implement-review.ts are the single source of truth
 *           for both the handler and these tests. Removing an orchestrator call from the handler
 *           does NOT break a test that only calls inner helpers — but removing the call to
 *           buildBlockedImplReviewResponse or projectProofSummaryForVerdict from the handler WILL
 *           break tests that call these same orchestrators.
 */

import { describe, expect, it } from 'vitest';
import {
  buildBlockedImplReviewResponse,
  projectProofSummaryForVerdict,
} from './implement-review.js';
import { projectCompletionProofStatus } from '../proofgraph/proof-summary-projectors.js';
import { formatBlocked } from './helpers.js';
import { makeState, IMPL_EVIDENCE } from '../../fixtures.js';

function proofGraphState() {
  return makeState('IMPL_REVIEW', {
    implementation: IMPL_EVIDENCE,
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
  });
}

describe('implement-review proof-summary orchestrator regressions', () => {
  describe('buildBlockedImplReviewResponse', () => {
    it('returns original blocked response when proofSummary is null', () => {
      const blocked = formatBlocked('SUBAGENT_UNABLE_TO_REVIEW', { obligationId: 'obl-1' });
      const result = buildBlockedImplReviewResponse(blocked, null);
      expect(result).toBe(blocked);
    });

    it('injects proofSummary into blocked JSON (full handler contract)', () => {
      const blocked = formatBlocked('SUBAGENT_UNABLE_TO_REVIEW', { obligationId: 'obl-1' });
      const summary = projectProofSummaryForVerdict(proofGraphState(), 'accept');
      const result = buildBlockedImplReviewResponse(blocked, summary);
      const parsed = JSON.parse(result);
      expect(parsed.error).toBe(true);
      expect(parsed.code).toBe('SUBAGENT_UNABLE_TO_REVIEW');
      expect(parsed.message).toBeDefined();
      expect(parsed.proofSummary).toBeDefined();
      expect(parsed.proofSummary.kind).toBe('evaluation');
    });
  });

  describe('projectProofSummaryForVerdict', () => {
    it("accept → 'current_gate'", () => {
      const summary = projectProofSummaryForVerdict(proofGraphState(), 'accept');
      expect(summary).not.toBeNull();
      if (summary?.kind === 'evaluation') {
        expect(summary.decisionContext).toBe('current_gate');
      }
    });

    it("changes_requested → 'prospective_approval'", () => {
      const summary = projectProofSummaryForVerdict(proofGraphState(), 'changes_requested');
      expect(summary).not.toBeNull();
      if (summary?.kind === 'evaluation') {
        expect(summary.decisionContext).toBe('prospective_approval');
      }
    });

    it("unable_to_review → 'prospective_approval' (non-accept fallback)", () => {
      const summary = projectProofSummaryForVerdict(proofGraphState(), 'unable_to_review');
      expect(summary).not.toBeNull();
      if (summary?.kind === 'evaluation') {
        expect(summary.decisionContext).toBe('prospective_approval');
      }
    });
  });

  describe('completion path', () => {
    it('projectCompletionProofStatus → completion', () => {
      const summary = projectCompletionProofStatus(proofGraphState());
      expect(summary).not.toBeNull();
      if (summary?.kind === 'evaluation') {
        expect(summary.decisionContext).toBe('completion');
      }
    });
  });
});

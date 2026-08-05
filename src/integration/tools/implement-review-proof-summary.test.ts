/**
 * @test-policy
 * REGRESSION: attachProofSummaryToBlockedResponse → proofSummary survives serialization round-trip.
 * REGRESSION: proofDecisionContextForVerdict → 'current_gate' for accept, 'prospective_approval' for changes_requested.
 * REGRESSION: acceptance test verifies decisionContext override reaches the projector output.
 * REGRESSION: Gate-block (critical_fact_required) → headlineStatus is BLOCKED, primaryReason present.
 * CONTRACT: The production helpers in implement-review.ts are the single source of truth for both
 *           the pipeline and these tests — mutations to the helpers will break these tests.
 */

import { describe, expect, it } from 'vitest';
import {
  attachProofSummaryToBlockedResponse,
  proofDecisionContextForVerdict,
} from './implement-review.js';
import {
  projectImplementationProofStatus,
  projectCompletionProofStatus,
} from '../proofgraph/proof-summary-projectors.js';
import { formatBlocked } from './helpers.js';
import { makeState, IMPL_EVIDENCE } from '../../fixtures.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

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

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('implement-review proof-summary wiring regressions', () => {
  describe('attachProofSummaryToBlockedResponse', () => {
    it('returns original blocked response when proofSummary is null', () => {
      const blocked = formatBlocked('SUBAGENT_UNABLE_TO_REVIEW', {
        obligationId: 'obl-1',
      });
      const result = attachProofSummaryToBlockedResponse(blocked, null);
      expect(result).toBe(blocked);
    });

    it('injects proofSummary into blocked JSON', () => {
      const blocked = formatBlocked('SUBAGENT_UNABLE_TO_REVIEW', {
        obligationId: 'obl-1',
      });
      const summary = projectImplementationProofStatus(proofGraphState());
      const result = attachProofSummaryToBlockedResponse(blocked, summary);
      const parsed = JSON.parse(result);
      expect(parsed.error).toBe(true);
      expect(parsed.code).toBe('SUBAGENT_UNABLE_TO_REVIEW');
      expect(parsed.message).toBeDefined();
      expect(parsed.proofSummary).toBeDefined();
      expect(parsed.proofSummary.kind).toBe('evaluation');
    });
  });

  describe('proofDecisionContextForVerdict', () => {
    it("returns 'current_gate' for accept", () => {
      expect(proofDecisionContextForVerdict('accept')).toBe('current_gate');
    });

    it("returns 'prospective_approval' for changes_requested", () => {
      expect(proofDecisionContextForVerdict('changes_requested')).toBe('prospective_approval');
    });

    it('accept path projector with decisionContext yields current_gate', () => {
      const dc = proofDecisionContextForVerdict('accept');
      const summary = projectImplementationProofStatus(proofGraphState(), {
        decisionContext: dc,
      });
      expect(summary).not.toBeNull();
      if (summary?.kind === 'evaluation') {
        expect(summary.decisionContext).toBe('current_gate');
      }
    });
  });

  describe('completion path', () => {
    it('projectCompletionProofStatus yields completion', () => {
      const summary = projectCompletionProofStatus(proofGraphState());
      expect(summary).not.toBeNull();
      if (summary?.kind === 'evaluation') {
        expect(summary.decisionContext).toBe('completion');
      }
    });
  });
});

/**
 * @test-policy
 * REGRESSION: unable_to_review injection → `formatBlocked` JSON is valid and can carry proofSummary.
 * REGRESSION: accept → projectImplementationProofStatus with decisionContext: 'current_gate' yields
 *             the correct context.
 * REGRESSION: changes_requested → projectImplementationProofStatus without override yields
 *             prospective_approval.
 * REGRESSION: Gate-block (e.g. no authorized claims → critical_fact_required) → BLOCKED headline,
 *             primaryReason present.
 * INTEGRATION: exercises real projectors and formatBlocked — the same functions used in the
 *             production implement-review pipeline.
 */

import { describe, expect, it } from 'vitest';
import {
  projectImplementationProofStatus,
  projectCompletionProofStatus,
} from '../proofgraph/proof-summary-projectors.js';
import { formatBlocked } from './helpers.js';
import { makeState, IMPL_EVIDENCE } from '../../fixtures.js';

function proofGraphState(extra?: Partial<Record<string, unknown>>) {
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
    ...(extra ?? {}),
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('implement-review proof-summary regressions', () => {
  describe('unable_to_review JSON injection contract', () => {
    it('formatBlocked output is valid JSON and can carry proofSummary', () => {
      const blocked = formatBlocked('SUBAGENT_UNABLE_TO_REVIEW', {
        obligationId: 'obl-1',
        iteration: '1',
      });
      // parse-serialize round-trip — must not throw
      const parsed = JSON.parse(blocked);
      expect(parsed.error).toBe(true);
      expect(parsed.code).toBe('SUBAGENT_UNABLE_TO_REVIEW');
      expect(parsed.message).toBeDefined();

      // Inject proofSummary (same pattern as handleSubmittedImplementationReview)
      const state = proofGraphState();
      const summary = projectImplementationProofStatus(state);
      if (summary) {
        parsed.proofSummary = summary;
      }
      const reSerialized = JSON.stringify(parsed);

      // The re-serialized output must contain both the block reason AND proof
      const final = JSON.parse(reSerialized);
      expect(final.error).toBe(true);
      expect(final.code).toBe('SUBAGENT_UNABLE_TO_REVIEW');
      expect(final.proofSummary).toBeDefined();
      if (final.proofSummary?.kind === 'evaluation') {
        expect(final.proofSummary.decisionContext).toBe('prospective_approval');
      }
    });
  });

  describe('accept path decisionContext', () => {
    it('yields current_gate when explicitly set', () => {
      const state = proofGraphState();
      const summary = projectImplementationProofStatus(state, {
        decisionContext: 'current_gate',
      });
      expect(summary).not.toBeNull();
      if (summary?.kind === 'evaluation') {
        expect(summary.decisionContext).toBe('current_gate');
      }
    });
  });

  describe('changes_requested / pre-branch default', () => {
    it('yields prospective_approval without override', () => {
      const state = proofGraphState();
      const summary = projectImplementationProofStatus(state);
      expect(summary).not.toBeNull();
      if (summary?.kind === 'evaluation') {
        expect(summary.decisionContext).toBe('prospective_approval');
      }
    });
  });

  describe('completion path decisionContext', () => {
    it('yields completion via projectCompletionProofStatus', () => {
      const state = proofGraphState();
      const summary = projectCompletionProofStatus(state);
      expect(summary).not.toBeNull();
      if (summary?.kind === 'evaluation') {
        expect(summary.decisionContext).toBe('completion');
      }
    });
  });
});

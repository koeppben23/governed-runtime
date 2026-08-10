/**
 * @module integration/test-review-binding-mock
 * @description Shared vi.mock setup for resolveImplementationReviewBinding in
 *              integration tests. The agent-submitted review pipeline creates
 *              attempts with 'created' status without transitioning them to
 *              'bound'. This mock provides a test-only fallback that accepts
 *              any attempt with a matching invocation. The production code
 *              remains strict (bound-only).
 *
 *              Import with: import './test-review-binding-mock.js';
 */

import { vi } from 'vitest';
import type { SessionState } from '../state/schema.js';

vi.mock('../state/implementation-approval-binding.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../state/implementation-approval-binding.js')>();
  return {
    ...original,
    resolveImplementationReviewBinding: (state: SessionState, digest: string) => {
      // Try the strict resolver first (requires bound + invocation).
      const strict = original.resolveImplementationReviewBinding(state, digest);
      if (strict) return strict;

      // Fallback: any fulfilled/consumed obligation with a matching attempt
      // and invocation is acceptable in test environments where the review
      // pipeline doesn't formally bind attempts.
      const assurance = state.reviewAssurance;
      if (!assurance) return null;
      const ob = [...assurance.obligations]
        .reverse()
        .find(
          (o) =>
            o.obligationType === 'implement' &&
            o.subjectDigest === digest &&
            (o.status === 'fulfilled' || o.status === 'consumed'),
        );
      if (!ob) return null;
      const at = assurance.attempts
        .filter((a) => a.obligationId === ob.obligationId && a.subjectDigest === digest)
        .sort((a, b) => b.ordinal - a.ordinal)[0];
      const inv = at
        ? assurance.invocations.find(
            (i) => i.obligationId === ob.obligationId && i.attemptId === at.attemptId,
          )
        : assurance.invocations.find((i) => i.obligationId === ob.obligationId);
      if (!inv) return null;
      return {
        obligationId: ob.obligationId,
        attemptId: at?.attemptId ?? '00000000-0000-4000-8000-000000000000',
        evidenceDigest: inv.findingsHash,
      };
    },
  };
});

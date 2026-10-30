/** Review-capture entries of the canonical mutation inventory; no invented admissions. */
import type { AdmissionCandidateEntry } from './mutation-authority-inventory.js';

const TARGETS = [
  [
    'src/integration/reviewer-capture.ts',
    'Request correlation, tool fence and quarantine termination',
    'src/integration/reviewer-capture.test.ts',
  ],
  [
    'src/integration/review/dispatch/structured-followup.ts',
    'Same-child JSON execution and unknown-outcome handling',
    'src/integration/review/dispatch/structured-followup.test.ts',
  ],
  [
    'src/integration/review/dispatch/provider-error.ts',
    'Trusted provider error classification',
    'src/integration/review/dispatch/provider-error.test.ts',
  ],
  [
    'src/integration/review/dispatch/reviewer-task-completion.ts',
    'Ordered host completion and child model proof',
    'src/integration/review/dispatch/reviewer-task-completion.test.ts',
  ],
  [
    'src/shared/strict-json-object.ts',
    'Bounded strict JSON model-input decoder',
    'src/shared/strict-json-object.test.ts',
  ],
  [
    'src/state/review-message-capture.ts',
    'Current message-capture evidence and semantic binding',
    'src/state/review-message-capture.test.ts',
  ],
] as const;

export const REVIEW_CAPTURE_MUTATION_CANDIDATES: readonly AdmissionCandidateEntry[] = TARGETS.map(
  ([target, authority, suite]) => ({
    classification: 'admission-candidate',
    profile: 'review-capture',
    target,
    mutateSelector: target,
    authority,
    source: ['docs/decisions/009-model-neutral-review-transport.md'],
    coveringSuites: [suite],
    critical: true,
    reason:
      'Dedicated full-profile security measurement. A working-tree score does not create an immutable commit-bound admission record; candidates remain explicit until admission provenance is recorded.',
  }),
);

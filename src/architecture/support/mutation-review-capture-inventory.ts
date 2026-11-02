/** Review-capture entries of the canonical mutation inventory; no invented admissions. */
import type { AdmissionCandidateEntry } from './mutation-authority-inventory.js';

const TARGETS = [
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

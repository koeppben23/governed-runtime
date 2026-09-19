/**
 * @module integration/native-task-review-types
 * @description Shared persisted-state types for the native reviewer Task transport.
 */

import type { readState } from '../adapters/persistence.js';
import type { ReviewObligation } from '../state/evidence.js';
import type { findBindableAttempt } from './review/assurance.js';

export type PersistedState = NonNullable<Awaited<ReturnType<typeof readState>>>;

type BindableAttempt = NonNullable<ReturnType<typeof findBindableAttempt>>;

export interface NativeReviewLineage {
  readonly state: PersistedState;
  readonly obligation: ReviewObligation;
  readonly attempt: BindableAttempt;
  readonly dispatch: NonNullable<PersistedState['reviewAssurance']>['dispatches'][number];
}

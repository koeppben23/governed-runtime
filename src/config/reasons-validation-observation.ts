/**
 * @module config/reasons-validation-observation
 * @description Reason codes for the frozen repository authority and the
 *              sanctioned reviewer observation capability.
 *
 * Category file for VALIDATION reason codes — merged into the canonical
 * `VALIDATION_REASONS` array by reasons-validation.ts (no parallel registry).
 *
 * @version v1
 */

import type { BlockedReason } from './reasons-types.js';

export const OBSERVATION_VALIDATION_REASONS: readonly BlockedReason[] = [
  {
    code: 'REVIEW_IMPLEMENTATION_BASE_FREEZE_FAILED',
    category: 'state',
    messageTemplate:
      'The pre-mutation implementation base could not be frozen before entering IMPLEMENTATION: {reason}.',
    recoverySteps: [
      'Implementation reviews require an immutable frozen base commit resolved BEFORE any governed mutation',
      'Ensure the worktree is inside a git repository with at least one commit and a resolvable repository identity',
      'Re-run the transition into IMPLEMENTATION once the repository is usable',
    ],
  },
  {
    code: 'REVIEW_OBSERVATION_CAPABILITY_UNKNOWN',
    category: 'state',
    messageTemplate:
      'The observation capability is unknown or its attempt is not currently usable: {reason}.',
    recoverySteps: [
      'Use exactly the observationCapability from the canonical reviewer prompt for THIS attempt',
      'Observation capabilities are attempt-bound; a capability from another attempt can never match',
    ],
  },
  {
    code: 'REVIEW_OBSERVATION_AUTHORITY_UNAVAILABLE',
    category: 'state',
    messageTemplate:
      'Repository observation for revision {revision} has no frozen repository authority (obligation {obligationId}).',
    recoverySteps: [
      'This review obligation carries no frozen repository authority — repository evidence is unavailable',
      'Do not substitute worktree reads or recalled content for frozen observation',
    ],
  },
  {
    code: 'REVIEW_OBSERVATION_INVALID_ARGS',
    category: 'state',
    messageTemplate: 'flowguard_observe_repository arguments are invalid: {reason}.',
    recoverySteps: [
      'Provide capability (from the prompt), revision ("base" or "head"), and a repository-relative path',
      'revision is a frozen alias only — never a SHA, branch, or ref',
    ],
  },
  {
    code: 'REVIEW_OBSERVATION_PATH_INVALID',
    category: 'state',
    messageTemplate: 'Observation path {path} is not a repository-relative path.',
    recoverySteps: [
      'Use a repository-relative POSIX path without leading slashes, drive letters, or escaping segments',
    ],
  },
  {
    code: 'REVIEW_OBSERVATION_UNAVAILABLE',
    category: 'state',
    messageTemplate: 'The frozen repository object cannot be acquired for observation: {reason}.',
    recoverySteps: [
      'Immutable acquisition has no mutable fallback — worktree reads are never substituted',
      'The cited location cannot become repository evidence for this attempt',
    ],
  },
  {
    code: 'REVIEW_OBSERVATION_OVERSIZED',
    category: 'state',
    messageTemplate: 'The observed blob exceeds the repository observation size bound: {reason}.',
    recoverySteps: [
      'Oversized content is unavailable as repository evidence; it is never truncated',
      'Do not cite the location — a truncated observation can never bind',
    ],
  },
  {
    code: 'REVIEW_OBSERVATION_UNSUPPORTED_ENTRY',
    category: 'state',
    messageTemplate: 'The observed path is not materializable at the frozen revision: {reason}.',
    recoverySteps: [
      'Submodule gitlink entries are not materialized as repository observations',
      'Observe a regular blob path instead',
    ],
  },
];

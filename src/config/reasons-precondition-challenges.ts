/**
 * Reason codes: implementation challenge and independent-challenge falsification
 * preconditions.
 *
 * Category file for PRECONDITION reason codes — merged into the canonical
 * `PRECONDITION_REASONS` array by reasons-precondition.ts (no parallel
 * registry).
 *
 * @internal — do not import directly. Use reasons.ts barrel.
 */
import type { BlockedReason } from './reasons-types.js';

export const PRECONDITION_CHALLENGE_REASONS: readonly BlockedReason[] = [
  {
    code: 'IMPLEMENTATION_CHALLENGE_UNKNOWN',
    category: 'precondition',
    messageTemplate:
      'Implementation challenge {challengeId} is not present in prior implementation review findings.',
    recoverySteps: ['Use a challengeId from persisted implementation review findings.'],
  },
  {
    code: 'IMPLEMENTATION_CHALLENGE_ALREADY_RESOLVED',
    category: 'precondition',
    messageTemplate:
      'Implementation challenge {challengeId} already has advisory resolution evidence for the current implementation digest.',
    recoverySteps: [
      'Do not resubmit the same resolution; record a new resolution only after a further implementation change produces a new digest and fresh passing validation attempts.',
    ],
  },
  {
    code: 'IMPLEMENTATION_CHALLENGE_NOT_FAILED',
    category: 'precondition',
    messageTemplate:
      'Implementation challenge {challengeId} has outcome {outcome}; only a failed falsification (fail or not_verified) can be resolved.',
    recoverySteps: [
      'Record resolutions only for challenges the reviewer marked fail or not_verified.',
    ],
  },
  {
    code: 'IMPLEMENTATION_VALIDATION_ATTEMPT_UNKNOWN',
    category: 'precondition',
    messageTemplate:
      'Validation attempt {attemptId} is not present in the immutable validation-attempt ledger.',
    recoverySteps: ['Use an attemptId returned by post-implementation flowguard_run_check.'],
  },
  {
    code: 'IMPLEMENTATION_VALIDATION_ATTEMPT_DUPLICATE',
    category: 'precondition',
    messageTemplate:
      'Validation attempt {attemptId} was supplied more than once for one challenge resolution.',
    recoverySteps: ['Supply each immutable validation attempt ID exactly once.'],
  },
  {
    code: 'IMPLEMENTATION_VALIDATION_ATTEMPT_WRONG_SCOPE',
    category: 'precondition',
    messageTemplate:
      'Validation attempt {attemptId} is not a post-implementation validation attempt.',
    recoverySteps: ['Use only validation attempts with scope "implementation".'],
  },
  {
    code: 'IMPLEMENTATION_VALIDATION_ATTEMPT_DIGEST_MISMATCH',
    category: 'precondition',
    messageTemplate:
      'Validation attempt {attemptId} is bound to a different implementation digest.',
    recoverySteps: ['Use attempts executed against the current implementation digest.'],
  },
  {
    code: 'IMPLEMENTATION_VALIDATION_ATTEMPT_FAILED',
    category: 'precondition',
    messageTemplate:
      'Validation attempt {attemptId} did not pass and cannot support a challenge resolution.',
    recoverySteps: [
      'Fix the implementation and rerun the required validation check.',
      'Use a passing post-implementation validation attempt for the current implementation digest.',
    ],
  },
  {
    code: 'SUBAGENT_CHALLENGE_COUNT_INCOHERENT',
    category: 'precondition',
    messageTemplate:
      'Independent review supplied {actual} challenges but policy requires at least {required}.',
    recoverySteps: ['Submit the required number of evidence-bound challenges.'],
  },
  {
    code: 'SUBAGENT_CHALLENGE_EVIDENCE_MISSING',
    category: 'precondition',
    messageTemplate:
      'Independent review challenge of kind {kind} has invalid evidence references ({reason}).',
    recoverySteps: ['Bind each challenge to at least one canonical evidence reference.'],
  },
  {
    code: 'SUBAGENT_CHALLENGE_KIND_INCOHERENT',
    category: 'precondition',
    messageTemplate:
      'Independent review supplied challenge kind {actual}, but policy requires {required}.',
    recoverySteps: ['Submit challenges using the kind required by the frozen review obligation.'],
  },
  {
    code: 'SUBAGENT_IMPLEMENTATION_CHALLENGE_UNRESOLVED',
    category: 'precondition',
    messageTemplate: 'Implementation challenge {challengeId} remains unresolved.',
    recoverySteps: [
      'Record advisory resolution evidence using a passing post-implementation validation attempt.',
      'Obtain a subsequent independent reviewer verdict of resolved.',
    ],
  },

  {
    code: 'SUBAGENT_CHALLENGE_NOT_DISTINCT',
    category: 'precondition',
    messageTemplate:
      'Independent review supplied duplicate challenges ({reason}); each required challenge must be substantively distinct.',
    recoverySteps: [
      'Submit challenges that falsify different claims, cite different evidence, or target different locations.',
      'Do not repeat a challenge with only a new challengeId.',
    ],
  },
  {
    code: 'SUBAGENT_CHALLENGE_INSUBSTANTIAL',
    category: 'precondition',
    messageTemplate:
      'Independent review challenge has an empty required field ({field}); placeholder challenges are rejected.',
    recoverySteps: ['State a concrete scenario, claim, and locations for each required challenge.'],
  },
  {
    code: 'SUBAGENT_RESOLUTION_VERDICT_UNKNOWN',
    category: 'precondition',
    messageTemplate:
      'Resolution verdict references challenge {challengeId}, which is not an open challenge from the preceding review iteration.',
    recoverySteps: [
      'Return resolution verdicts only for the unresolved challenges of the immediately preceding iteration.',
    ],
  },
  {
    code: 'SUBAGENT_RESOLUTION_VERDICT_DUPLICATE',
    category: 'precondition',
    messageTemplate:
      'Resolution verdict for challenge {challengeId} appears more than once; each challenge takes exactly one verdict.',
    recoverySteps: ['Submit exactly one resolution verdict per open challenge.'],
  },
  {
    code: 'SUBAGENT_RESOLUTION_VERDICT_UNEXPECTED',
    category: 'precondition',
    messageTemplate:
      'Resolution verdicts were supplied ({supplied}) but no prior challenge is open for resolution.',
    recoverySteps: ['Omit challengeResolutionVerdicts when there is no open challenge to resolve.'],
  },
  {
    code: 'SUBAGENT_RESOLUTION_VERDICT_INCOHERENT',
    category: 'precondition',
    messageTemplate:
      'Resolution verdict {verdict} is incoherent with overall review verdict {overallVerdict} for challenge {challengeId}.',
    recoverySteps: [
      'When unable_to_review, omit resolution verdicts or report not_verified for known open challenges.',
    ],
  },
  {
    code: 'SUBAGENT_PRIOR_CHALLENGE_UNRESOLVED',
    category: 'precondition',
    messageTemplate:
      'Acceptance is blocked: {unaddressed} prior failing challenge(s) (e.g. {challengeId}) have no author resolution for the current implementation digest.',
    recoverySteps: [
      'Record a resolution for each prior failing challenge against the current implementation digest and a passing validation attempt.',
      'Then obtain an independent reviewer verdict; author resolutions never close a challenge on their own.',
    ],
  },
  {
    code: 'SUBAGENT_CHALLENGE_CONTRADICTED',
    category: 'precondition',
    messageTemplate:
      'A {kind} falsification succeeded (outcome {outcome}); acceptance is not allowed while the artifact is contradicted.',
    recoverySteps: [
      'Return changes_requested and record the contradiction as a blocking issue.',
      'Do not accept an artifact that a challenge has contradicted.',
    ],
  },
];

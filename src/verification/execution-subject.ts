/**
 * @module verification/execution-subject
 * @description Runtime-only Execution Subject Attestation types.
 *
 * These types define the surfaces that must be attested immediately before and
 * after a verification execution. They are NOT persisted in VerificationCandidate
 * or any other session-state schema — they are derived at execution time from
 * information available to the planner and executor.
 *
 * The invariant for governance-positive FlowGuard execution:
 *   expected subject
 *   === subject immediately before execution
 *   === subject immediately after execution
 *
 * If any surface changed: the execution result is not bindable as positive
 * proof evidence.
 *
 * Scope (this commit):
 *   - { kind: 'file', path: 'package.json' } — when check command is a repo-native
 *     package.json script
 *
 *   Implementation re-attestation is handled by the existing
 *   freezeValidationSubject / validationSubjectBlock mechanism
 *   (Phase A → Phase C lock-acquisition check). The attestation here
 *   adds execution-surface-level integrity for files the agent can
 *   modify between planning and execution without changing the
 *   implementation digest.
 *
 *   Configuration-surface attestation is incomplete: config files (vitest.config.*,
 *   jest.config.*, pytest.ini, pom.xml, build.gradle*, go.mod, etc.) are not yet
 *   covered. See KNOWN_ISSUES.md.
 *
 * @version v1
 */

/** An input file or data set whose integrity must be attested. */
export type ExecutionSubjectInput =
  { readonly kind: 'implementation' } | { readonly kind: 'file'; readonly path: string };

/** Attested surface-digest mapping computed at execution time. */
export interface ExecutionSubjectAttestation {
  /** The inputs that were attested. */
  readonly inputs: readonly ExecutionSubjectInput[];
  /** SHA-256 of the content these inputs resolved to. */
  readonly digest: string;
  /** Per-surface digests (keyed by input identity). */
  readonly surfaceDigests: ReadonlyMap<string, string>;
}

/** Result of a pre- or post-execution attestation. */
export type AttestationResult =
  | { readonly kind: 'ok'; readonly attestation: ExecutionSubjectAttestation }
  | {
      readonly kind: 'subject_changed';
      readonly component: 'implementation' | 'execution_surface';
      readonly phase: 'pre_execution' | 'post_execution';
      readonly detail: string;
    };

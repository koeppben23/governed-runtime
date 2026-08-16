/**
 * @module providers/contract
 * @description Assertion Provider Extension Contract.
 *
 * Defines the typed interfaces that a provider extension must fulfill.
 * One extension module per provider — no parallel registries, no
 * source-string heuristics, no provider switches in core code.
 *
 * @version v1
 */

import type { ProviderId, ReportFormatId } from '../state/assertion-identity.js';
import type { VerificationCandidateKind, AssertionReportSpec } from '../state/discovery-schemas.js';
import type { VerificationCandidate } from '../state/discovery-schemas.js';
import type { ExecutionSubjectInput } from '../state/discovery-schemas.js';

// ─── Planner Context ─────────────────────────────────────────────────────────

export interface PlannerContext {
  readonly rootFiles: ReadonlySet<string>;
  readonly packageManager: string;
  readonly detectedStackIds: ReadonlySet<string>;
}

// ─── Manifest ────────────────────────────────────────────────────────────────

export interface ProviderManifest {
  readonly providerId: ProviderId;
  readonly label: string;
}

// ─── Discovery — Script Signatures ───────────────────────────────────────────

export type ScriptSignature =
  | {
      readonly executionProfileId: string;
      readonly candidateKind: VerificationCandidateKind;
      readonly executable: string;
      readonly requiredArgsPrefix?: readonly string[];
    }
  | {
      readonly executionProfileId: string;
      readonly candidateKind: VerificationCandidateKind;
      readonly moduleInvocation: {
        readonly executable: string;
        readonly module: string;
      };
    };

// ─── Discovery — Runtime Requirements ────────────────────────────────────────

export interface RuntimeRequirement {
  readonly id: string;
  readonly role: 'runtime' | 'tool' | 'reporter';
  readonly probe:
    | { readonly kind: 'exec'; readonly command: string; readonly versionPattern?: string }
    | { readonly kind: 'executable_file'; readonly path: string };
}

// ─── Discovery — Detection ───────────────────────────────────────────────────

export type DetectionId = `${string}:${string}`;

// ─── Execution Profiles ──────────────────────────────────────────────────────

export interface ExecutionProfile {
  readonly profileId: string;
  readonly providerId: ProviderId;
  readonly format: ReportFormatId;
  readonly kind: VerificationCandidateKind;
  readonly priority: number;
  /** An opt-in alternate execution route for the same semantic check kind. */
  readonly alternate?: boolean;

  /**
   * Static report semantics for this profile.
   *
   * Used for repo-native script enrichment where the profile identity is already
   * confirmed by a ScriptSignature match — no discovery predicate is needed.
   */
  readonly assertionReport: AssertionReportSpec;

  /** Discovery-gated candidate with repo evidence, or null when not applicable. */
  createCandidate(ctx: PlannerContext): VerificationCandidate | null;

  /** Explicitly attest only commands known to execute this profile's full check scope. */
  attestFullCheckScope?(command: string): boolean;

  /**
   * Provider-owned verification-semantic surfaces that become part of the
   * execution subject. The planner includes these as `{ kind: 'file' }`
   * inputs alongside the implementation surface. Only files discoverable
   * through the current PlannerContext are included — the profile must filter
   * against ctx.rootFiles where semantics depend on file existence.
   *
   * Absent → no additional subject inputs beyond implementation.
   */
  resolveExecutionSubjectInputs?(ctx: PlannerContext): readonly ExecutionSubjectInput[];

  /** Profile-specific runtime requirements override provider defaults. */
  readonly runtimeRequirements?: readonly RuntimeRequirement[];

  /** Optional: produce platform-specific requirements from the created candidate's source. */
  resolveRuntimeRequirements?(candidate: VerificationCandidate): readonly RuntimeRequirement[];
}

// ─── Verification — Format Registration ──────────────────────────────────────

export interface ProviderFormatRegistration {
  readonly format: ReportFormatId;
  readonly parser: import('../verification/assertion-parsers/types.js').AssertionReportParser;
  /** Aggregate is distinct from structured assertion extraction. */
  readonly bindingCapability: 'assertion' | 'aggregate' | 'check_only';
}

// ─── Complete Extension ──────────────────────────────────────────────────────

export interface AssertionProviderExtension {
  readonly manifest: ProviderManifest;

  readonly discovery: {
    readonly detectionIds: readonly DetectionId[];
    readonly scriptSignatures?: readonly ScriptSignature[];
    readonly runtimeRequirements?: readonly RuntimeRequirement[];
    readonly executionProfiles: readonly ExecutionProfile[];
    readonly assertionReportTemplate?: AssertionReportSpec;
  };

  readonly verification: {
    readonly formats: readonly ProviderFormatRegistration[];
    readonly identityCodec?: import('../verification/assertion-parsers/types.js').AssertionIdentityCodec;
  };
}

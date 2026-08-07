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
      readonly executable: string;
      readonly requiredArgsPrefix?: readonly string[];
    }
  | {
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

  /** Liefert einen Candidate nur mit ausreichender Evidence, sonst null. */
  createCandidate(ctx: PlannerContext): VerificationCandidate | null;

  /** Profile-specific runtime requirements override provider defaults. */
  readonly runtimeRequirements?: readonly RuntimeRequirement[];
}

// ─── Verification — Format Registration ──────────────────────────────────────

export interface ProviderFormatRegistration {
  readonly format: ReportFormatId;
  readonly parser: import('../verification/assertion-parsers/types.js').AssertionReportParser;
  readonly bindingCapability: 'assertion' | 'check_only';
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

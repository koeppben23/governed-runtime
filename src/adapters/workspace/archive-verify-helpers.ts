/**
 * @module adapters/workspace/archive-verify-helpers
 * @description Pure helper predicates and resolvers for archive verification.
 *
 * Every function in this module is a deterministic computation over its
 * inputs — no I/O, no logging, no telemetry, no external state mutation.
 * They are extracted from archive-verify-chain.ts so each can be unit-tested
 * independently.
 *
 * verifyArchive in archive-verify-chain.ts remains the single orchestrating
 * authority for archive verification.
 *
 * @version v1
 */

import { isPolicyMode } from '../../state/policy-mode.js';
import type { SessionState } from '../../state/schema.js';
import {
  ARTIFACT_BINDING_EVENT,
  ARTIFACT_BINDING_SCHEMA_VERSION,
  type ArtifactBindingEntry,
} from './archive-artifact-binding.js';
import type { ChainVerificationReason } from '../../audit/integrity.js';

/**
 * Fail-closed default: when the governed policy mode cannot be resolved from
 * integrity-covered state, verification runs strict. A resolvable non-regulated
 * mode is never escalated.
 */
export const STRICT_WHEN_MODE_UNRESOLVED = true;

// ─── Artifact Binding ─────────────────────────────────────────────────────────

export function findBindingArtifacts(
  events: readonly Record<string, unknown>[],
): unknown[] | undefined {
  const binding = [...events].reverse().find((event) => event.event === ARTIFACT_BINDING_EVENT);
  const detail = binding?.detail as Record<string, unknown> | undefined;
  if (
    detail?.schemaVersion !== ARTIFACT_BINDING_SCHEMA_VERSION ||
    !Array.isArray(detail?.artifacts)
  )
    return undefined;
  return detail.artifacts as unknown[];
}

export function isArtifactBindingEntry(value: unknown): value is ArtifactBindingEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.path === 'string' &&
    entry.path.startsWith('artifacts/') &&
    typeof entry.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(entry.sha256) &&
    (entry.artifactType === null || typeof entry.artifactType === 'string')
  );
}

// ─── Audit Chain Predicates ────────────────────────────────────────────────────

export function hasTimestampEvidence(event: Record<string, unknown>): boolean {
  const evidence = event.timestampEvidence;
  return typeof evidence === 'object' && evidence !== null;
}

export function isCurrentChainIntegrityFailure(reason: ChainVerificationReason | null): boolean {
  return reason === 'CHAIN_BREAK' || reason === 'LEGACY_EVENTS_NOT_ALLOWED_IN_STRICT_MODE';
}

export function isAuditFormatFailure(reason: ChainVerificationReason | null): boolean {
  return (
    reason === 'LEGACY_AUDIT_CHAIN_NOT_VERIFIABLE_WITH_V2' ||
    reason === 'UNSUPPORTED_AUDIT_FORMAT_VERSION'
  );
}

// ─── Policy Mode ──────────────────────────────────────────────────────────────

export function resolveStrictMode(state: SessionState | null): boolean {
  const mode = state?.policySnapshot?.mode;
  if (!isPolicyMode(mode)) {
    return STRICT_WHEN_MODE_UNRESOLVED;
  }
  return mode === 'regulated';
}

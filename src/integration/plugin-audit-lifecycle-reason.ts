/**
 * @module integration/plugin-audit-lifecycle-reason
 * @description Lifecycle-reason string construction for audit lifecycle events.
 *
 * Extracted from plugin-audit.ts to keep that handler under the file-size
 * budget. Pure functions — no I/O, no closure dependencies. The only public
 * entry point is `buildLifecycleDetail`; the per-field resolvers stay private
 * to this module.
 *
 * @version v1
 */

import type { SessionState, Phase } from '../state/schema.js';
import type { AuditContext } from './plugin-audit-context.js';

export function buildLifecycleDetail(
  ctx: AuditContext,
  lifecycleAction: string,
  state: SessionState | null,
  policy: { mode: string; requireHumanGates: boolean },
): {
  action: 'session_created' | 'session_completed' | 'session_aborted';
  finalPhase: Phase;
  reason?: string;
} {
  const finalPhase =
    ctx.transitions.length > 0
      ? ctx.transitions[ctx.transitions.length - 1]!.to
      : (ctx.phase as Phase);
  const reason =
    lifecycleAction === 'session_created' ? buildLifecycleReason(ctx, state, policy) : undefined;
  return {
    action: lifecycleAction as 'session_created' | 'session_completed' | 'session_aborted',
    finalPhase,
    ...(reason ? { reason } : {}),
  };
}

function buildLifecycleReason(
  ctx: AuditContext,
  state: SessionState | null,
  policy: { mode: string; requireHumanGates: boolean },
): string {
  const parsed =
    typeof ctx.parsed?.policyResolution === 'object'
      ? (ctx.parsed.policyResolution as Record<string, unknown>)
      : null;
  return lifecycleReasonFields(parsed, state, policy)
    .map(([key, value]) => `${key}:${value}`)
    .join(';');
}

function lifecycleReasonFields(
  parsed: Record<string, unknown> | null,
  state: SessionState | null,
  policy: { mode: string; requireHumanGates: boolean },
): Array<[string, string]> {
  return [
    ['requested_mode', lifecycleRequestedMode(parsed, state, policy)],
    ['effective_mode', lifecycleEffectiveMode(parsed, state, policy)],
    ['source', lifecycleSource(parsed, state)],
    ['effective_gate_behavior', lifecycleGateBehavior(parsed, state, policy)],
    ['reason', lifecycleReasonValue(parsed, state)],
    ['resolution_reason', lifecycleResolutionReason(parsed, state)],
    ['central_minimum_mode', lifecycleCentralMinimumMode(parsed, state)],
    ['central_policy_digest', lifecycleCentralPolicyDigest(parsed, state)],
  ];
}

function lifecycleRequestedMode(
  parsed: Record<string, unknown> | null,
  state: SessionState | null,
  policy: { mode: string },
): string {
  return String(parsed?.requestedMode ?? state?.policySnapshot.requestedMode ?? policy.mode);
}

function lifecycleEffectiveMode(
  parsed: Record<string, unknown> | null,
  state: SessionState | null,
  policy: { mode: string },
): string {
  return String(parsed?.effectiveMode ?? state?.policySnapshot.mode ?? policy.mode);
}

function lifecycleSource(
  parsed: Record<string, unknown> | null,
  state: SessionState | null,
): string {
  return String(parsed?.source ?? state?.policySnapshot.source ?? 'unknown');
}

function lifecycleGateBehavior(
  parsed: Record<string, unknown> | null,
  state: SessionState | null,
  policy: { requireHumanGates: boolean },
): string {
  return String(
    parsed?.effectiveGateBehavior ??
      state?.policySnapshot.effectiveGateBehavior ??
      (policy.requireHumanGates ? 'human_gated' : 'auto_approve'),
  );
}

function lifecycleReasonValue(
  parsed: Record<string, unknown> | null,
  state: SessionState | null,
): string {
  return String(parsed?.reason ?? state?.policySnapshot.degradedReason ?? 'none');
}

function lifecycleResolutionReason(
  parsed: Record<string, unknown> | null,
  state: SessionState | null,
): string {
  return String(parsed?.resolutionReason ?? state?.policySnapshot.resolutionReason ?? 'none');
}

function lifecycleCentralMinimumMode(
  parsed: Record<string, unknown> | null,
  state: SessionState | null,
): string {
  return String(parsed?.centralMinimumMode ?? state?.policySnapshot.centralMinimumMode ?? 'none');
}

function lifecycleCentralPolicyDigest(
  parsed: Record<string, unknown> | null,
  state: SessionState | null,
): string {
  return String(parsed?.centralPolicyDigest ?? state?.policySnapshot.policyDigest ?? 'none');
}

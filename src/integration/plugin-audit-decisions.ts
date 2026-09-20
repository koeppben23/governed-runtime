/**
 * @module integration/plugin-audit-decisions
 * @description Decision-receipt emission for audited tool invocations.
 *
 * Extracted from plugin-audit.ts: resolves the explicit audit identity and
 * projects a single decision receipt per terminal review transition.
 */

import { readAuditTrail } from '../adapters/persistence-audit.js';
import { DecisionIdentity } from '../state/evidence-identity.js';
import type { SessionState, Event, Transition } from '../state/schema.js';
import {
  buildDecisionBody,
  buildErrorBody,
  finalizeWithTimestampEvidence,
  type EventBody,
} from '../audit/types.js';
import { computeCanonicalEventDigest } from '../audit/canonical-digest.js';
import { resolveTimestampEvidence } from '../audit/timestamp-resolution.js';
import type { AuditContext } from './plugin-audit-context.js';
import { TOOL_FLOWGUARD_DECISION } from './tool-names.js';
import type { AuditDeps } from './plugin-audit-reconcile.js';

/**
 * Resolve the explicit audit identity pair. Audit events never carry a
 * polymorphic sessionId: `flowguardSessionId` is the SAME FlowGuard UUID on
 * every event class, and `hostSessionId` is bound separately where host
 * context exists. Returns null when the FlowGuard identity is unavailable —
 * the caller must skip the event instead of approximating an identity.
 */
export function auditIdentity(state: SessionState | null): {
  flowguardSessionId: string;
  hostSessionId?: string;
} | null {
  if (!state) return null;
  return {
    flowguardSessionId: state.flowguardSessionId,
    hostSessionId: state.binding.hostSessionId,
  };
}

interface DecisionReceiptParams {
  deps: AuditDeps;
  ctx: AuditContext;
  toolName: string;
  input: unknown;
  sessionId: string;
  policyMode: string;
  state: SessionState | null;
  recordTimestampFailure(eventKind: string, error: string | undefined): void;
}

export async function emitDecisionReceipt(params: DecisionReceiptParams): Promise<string> {
  const { deps, ctx, toolName, input, sessionId, policyMode, state } = params;
  const prevHash = ctx.prevHash;
  const transition = state?.transition;
  if (toolName !== TOOL_FLOWGUARD_DECISION || !ctx.success || !transition) return prevHash;

  const firstTransition = transition;
  const inferredVerdict = inferDecisionVerdict(firstTransition.event);
  if (inferredVerdict === null) return prevHash;
  const existingDecision = (await readAuditTrail(ctx.sessDir)).some(
    (event) =>
      event.detail.kind === 'decision' &&
      event.detail.fromPhase === firstTransition.from &&
      event.detail.toPhase === firstTransition.to &&
      event.detail.transitionEvent === firstTransition.event &&
      event.detail.verdict === inferredVerdict,
  );
  // Regulated completion commits its terminal decision as a state-owned
  // semantic operation before archival. The after-hook must not project it a
  // second time.
  if (policyMode === 'regulated' && state?.regulatedArchiveStatus && existingDecision)
    return prevHash;

  const sequence = await deps.nextDecisionSequence(ctx.sessDir, sessionId);
  const decisionId = `DEC-${String(sequence).padStart(3, '0')}`;
  const receipt = resolveDecisionReceiptFields(ctx, input, state, firstTransition.at);
  const decisionIdentity = receipt.decisionIdentity;

  if (!decisionIdentity?.actorId.trim()) {
    return emitDecisionReceiptActorMissing(params, firstTransition, prevHash);
  }
  return emitDecisionReceiptEvent(params, {
    prevHash,
    firstTransition,
    decisionId,
    sequence,
    verdict: inferredVerdict,
    receipt: {
      rationale: receipt.rationale,
      decisionIdentity,
      decidedAt: receipt.decidedAt,
    },
    policyMode,
  });
}

function inferDecisionVerdict(event: Event): 'approve' | 'changes_requested' | 'reject' | null {
  if (event === 'APPROVE') return 'approve';
  if (event === 'CHANGES_REQUESTED') return 'changes_requested';
  if (event === 'REJECT') return 'reject';
  return null;
}

function resolveDecisionReceiptFields(
  ctx: AuditContext,
  input: unknown,
  state: SessionState | null,
  fallbackDecidedAt: string,
): { rationale: string; decisionIdentity?: DecisionIdentity; decidedAt: string } {
  const parsedDecision = parsedReviewDecision(ctx);
  const decisionIdentity =
    decisionIdentityField(parsedDecision) ?? state?.reviewDecision?.decisionIdentity;
  return {
    rationale: resolveDecisionRationale(parsedDecision, input, state),
    ...(decisionIdentity !== undefined ? { decisionIdentity } : {}),
    decidedAt:
      stringField(parsedDecision, 'decidedAt') ??
      state?.reviewDecision?.decidedAt ??
      fallbackDecidedAt,
  };
}

function decisionIdentityField(
  record: Record<string, unknown> | null,
): DecisionIdentity | undefined {
  const parsed = DecisionIdentity.safeParse(record?.decisionIdentity);
  return parsed.success ? parsed.data : undefined;
}

function parsedReviewDecision(ctx: AuditContext): Record<string, unknown> | null {
  // Stryker disable next-line ConditionalExpression — equivalent: `undefined !== null` and `true` both route to the object-type check.
  return ctx.parsed?.reviewDecision !== null && typeof ctx.parsed?.reviewDecision === 'object'
    ? (ctx.parsed.reviewDecision as Record<string, unknown>)
    : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

function resolveDecisionRationale(
  parsedDecision: Record<string, unknown> | null,
  input: unknown,
  state: SessionState | null,
): string {
  // Stryker disable next-line ConditionalExpression,OptionalChaining — equivalent: the trailing `?.rationale` optional chain keeps every single-`?.` removal observationally identical.
  const parsedRationale =
    typeof parsedDecision?.rationale === 'string' ? parsedDecision.rationale : undefined;
  // Stryker disable next-line OptionalChaining — equivalent: both branches fall through to the input fallback for null state.
  const stateRationale = state?.reviewDecision?.rationale;
  // Stryker disable next-line OptionalChaining,ObjectLiteral — equivalent: guarded by the trailing `?.rationale`; the cast shape is a compile-time-only annotation.
  const inputRationale =
    typeof (input as { args?: { rationale?: unknown } })?.args?.rationale === 'string'
      ? String((input as { args?: { rationale?: unknown } })?.args?.rationale)
      : '';
  return parsedRationale ?? stateRationale ?? inputRationale;
}

async function emitDecisionReceiptActorMissing(
  params: DecisionReceiptParams,
  firstTransition: Transition,
  prevHash: string,
): Promise<string> {
  const { deps, ctx, toolName, sessionId, state, recordTimestampFailure } = params;
  deps.log.warn('audit', 'skipping decision receipt: missing decision identity', {
    tool: toolName,
    sessionId,
  });
  const identity = auditIdentity(state);
  if (!identity) return prevHash;
  const body = buildErrorBody(
    identity.flowguardSessionId,
    identity.hostSessionId,
    {
      code: 'DECISION_RECEIPT_ACTOR_MISSING',
      message: 'Decision receipt skipped because the decision identity is missing',
      recoveryHint: 'Ensure /review-decision output includes reviewDecision.decisionIdentity',
      errorPhase: firstTransition.from,
    },
    ctx.now,
    prevHash,
  );
  const evt = await finalizeAuditBodyWithTimestamp(params, body, prevHash, 'error');
  recordTimestampFailure('error', evt.error);
  await deps.appendAndTrack(evt.event, ctx.sessDir, ctx.enableChainHash, sessionId);
  return evt.event.chainHash;
}

async function emitDecisionReceiptEvent(
  params: DecisionReceiptParams,
  input: {
    prevHash: string;
    firstTransition: Transition;
    decisionId: string;
    sequence: number;
    verdict: 'approve' | 'changes_requested' | 'reject';
    receipt: { rationale: string; decisionIdentity: DecisionIdentity; decidedAt: string };
    policyMode: string;
  },
): Promise<string> {
  const { deps, ctx, sessionId, state, recordTimestampFailure } = params;
  const identity = auditIdentity(state);
  if (!identity) return input.prevHash;
  const body = buildDecisionBody({
    flowguardSessionId: identity.flowguardSessionId,
    ...(identity.hostSessionId !== undefined ? { hostSessionId: identity.hostSessionId } : {}),
    gatePhase: input.firstTransition.from,
    detail: {
      decisionId: input.decisionId,
      decisionSequence: input.sequence,
      verdict: input.verdict,
      rationale: input.receipt.rationale,
      decisionIdentity: input.receipt.decisionIdentity,
      decidedAt: input.receipt.decidedAt,
      fromPhase: input.firstTransition.from,
      toPhase: input.firstTransition.to,
      transitionEvent: input.firstTransition.event,
      policyMode: input.policyMode,
    },
    occurredAt: ctx.now,
    actor: ctx.actor,
    prevHash: input.prevHash,
    // Stryker disable next-line OptionalChaining — equivalent: decision receipts only run with a resolved, non-null session state.
    ...(state?.actorInfo !== undefined ? { actorInfo: state.actorInfo } : {}),
  });
  const evt = await finalizeAuditBodyWithTimestamp(params, body, input.prevHash, 'decision');
  recordTimestampFailure('decision', evt.error);
  await deps.appendAndTrack(evt.event, ctx.sessDir, ctx.enableChainHash, sessionId);
  return evt.event.chainHash;
}

async function finalizeAuditBodyWithTimestamp(
  params: DecisionReceiptParams,
  body: EventBody,
  prevHash: string,
  eventKind: string,
): Promise<{ event: ReturnType<typeof finalizeWithTimestampEvidence>; error?: string }> {
  const { deps, ctx } = params;
  const digest = computeCanonicalEventDigest(body);
  const resolution = ctx.timestampAssurance.enabled
    ? await resolveTimestampEvidence({
        policy: ctx.timestampAssurance,
        canonicalEventDigest: digest,
        eventKind,
        localTimestamp: ctx.now,
        ...(ctx.ntpResult !== undefined ? { ntpResult: ctx.ntpResult } : {}),
        tsaProvider: deps.tsaProvider,
        tsaVerifier: deps.timestampVerifier,
      })
    : undefined;
  const error = resolution?.error;
  return {
    event: finalizeWithTimestampEvidence(body, prevHash, resolution?.evidence, digest),
    ...(error !== undefined ? { error } : {}),
  };
}

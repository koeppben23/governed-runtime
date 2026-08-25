/**
 * @module integration/plugin-audit-reconcile
 * @description Durable audit outbox reconciliation — state-owned transition
 *              audit operations are drained to the append-only audit trail and
 *              acknowledged monotonically (state_committed → audit_committed →
 *              reconciled).
 *
 * This module owns the AuditDeps contract and the fail-closed reconciliation
 * gate used before every governed mutation. plugin-audit.ts (the after-hook
 * runner) imports from here; this module imports nothing back, so the
 * dependency direction is one-way.
 *
 * @version v1
 */

import {
  readState,
  writeState,
  writeStateAlreadyLocked,
  PersistenceError,
} from '../adapters/persistence.js';
import { withSessionWriteLock } from '../adapters/persistence-lock.js';
import { readAuditTrail } from '../adapters/persistence-audit.js';
import type { SessionState, Transition, PendingAuditOperation } from '../state/schema.js';
import {
  buildTransitionBody,
  finalizeWithTimestampEvidence,
  type EventBody,
} from '../audit/types.js';
import { computeCanonicalEventDigest } from '../audit/canonical-digest.js';
import { resolveTimestampEvidence } from '../audit/timestamp-resolution.js';
import type { TimestampAssurancePolicy } from '../config/policy-types.js';
import type { TimestampAuthorityProvider, TimestampVerifier } from '../audit/tsa-provider.js';
import { resolveAuditContext, type AuditContext } from './plugin-audit-context.js';
import { computeStateDigest } from './tools/audit-outbox.js';

/** Closure dependencies injected from plugin.ts. */
export interface AuditDeps {
  resolveFingerprint(): Promise<string | null>;
  getSessionDir(sessionId: string): string | null;
  /**
   * Canonical worktree + sessionId → sessionDir resolution, independent of the
   * cached fingerprint mapping. Lets the bootstrap gate verify persisted
   * session state even when the cached audit mapping is unavailable.
   */
  resolveCanonicalSessionDir?(sessionId: string): Promise<string | null>;
  resolveSessionPolicy(sessDir: string): Promise<{
    policy: {
      audit: {
        emitToolCalls: boolean;
        emitTransitions: boolean;
        enableChainHash: boolean;
        timestampAssurance?: TimestampAssurancePolicy;
      };
      actorClassification: Record<string, string>;
      mode: string;
      requireHumanGates: boolean;
    };
    state: SessionState | null;
  }>;
  initChain(sessDir: string | null, sessionId: string): Promise<string>;
  invalidateChainState(sessionId: string): void;
  appendAndTrack(
    event: { chainHash?: string },
    sessDir: string,
    enableChainHash: boolean,
    sessionId: string,
  ): Promise<void>;
  nextDecisionSequence(sessDir: string, sessionId: string): Promise<number>;
  log: {
    debug(service: string, message: string, extra?: Record<string, unknown>): void;
    info(service: string, message: string, extra?: Record<string, unknown>): void;
    warn(service: string, message: string, extra?: Record<string, unknown>): void;
  };
  logError(message: string, err: unknown): void;
  cachedFingerprint: string | null;
  mode: string;
  tsaProvider?: TimestampAuthorityProvider;
  timestampVerifier?: TimestampVerifier;
}

export interface StrictTimestampTracker {
  readonly record: (eventKind: string, error: string | undefined) => void;
  readonly failure: () => { eventKind: string; reason: string } | undefined;
}

export function createStrictTimestampTracker(
  policy: TimestampAssurancePolicy,
): StrictTimestampTracker {
  let failure: { eventKind: string; reason: string } | undefined;
  return {
    record(eventKind, error) {
      if (!failure && policy.strict && error && policy.criticalEvents.includes(eventKind)) {
        failure = { eventKind, reason: error };
      }
    },
    failure: () => failure,
  };
}

/**
 * A persisted transition predates the durable audit outbox and has no
 * contemporaneous audit evidence. The operation must fail closed instead of
 * synthesizing a normal-looking historical transition event from weaker
 * state evidence.
 */
class AuditTransitionEvidenceGapError extends Error {
  readonly code = 'AUDIT_TRANSITION_EVIDENCE_GAP';

  constructor(transition: Transition) {
    super(
      `Persisted transition ${transition.from}\u2192${transition.to} (${transition.event}) ` +
        'has no durable audit evidence. The session predates the audit outbox ' +
        'contract and must not be advanced further.',
    );
    this.name = 'AuditTransitionEvidenceGapError';
  }
}

/**
 * Rebuild the transition audit event the durable outbox committed for an
 * operation. The canonical event digest excludes prevHash, so the rebuild is
 * chain-position independent and must match `operation.auditEventDigest`.
 */
function buildOperationTransitionBody(
  state: SessionState,
  operation: PendingAuditOperation,
  prevHash: string,
): EventBody {
  const t = operation.transition;
  return buildTransitionBody(
    state.id,
    t.to,
    {
      operationId: operation.operationId,
      preStateDigest: operation.preStateDigest,
      mutationDigest: operation.mutationDigest,
      postStateDigest: operation.postStateDigest,
      from: t.from,
      to: t.to,
      event: t.event,
      autoAdvanced: t.autoAdvanced,
      chainIndex: t.chainIndex,
    },
    t.at,
    prevHash,
  );
}

export async function emitTransitionAudits(input: {
  deps: AuditDeps;
  ctx: AuditContext;
  sessionId: string;
  timestampTracker: StrictTimestampTracker;
}): Promise<void> {
  const { deps, ctx, sessionId, timestampTracker } = input;
  if (!ctx.emitTransitions) return;
  const state = await readState(ctx.sessDir);
  const operations =
    state?.pendingAuditOperations.filter((operation) => operation.status !== 'reconciled') ?? [];
  if (operations.length === 0) {
    await assertNoLegacyTransitionGap(ctx.sessDir, state);
    return;
  }
  if (!state) {
    throw new PersistenceError(
      'READ_FAILED',
      'Cannot reconcile audit operations without session state',
    );
  }
  deps.log.debug('audit', 'reconciling durable transition audit operations', {
    count: operations.length,
  });
  for (const operation of operations) {
    // The operation's committed post-state authority must equal the state that
    // is actually persisted right now. This is the state↔audit binding: any
    // side-effect write that landed before reconciliation invalidates the
    // operation and must fail closed instead of being reconciled.
    if (computeStateDigest(state) !== operation.postStateDigest) {
      throw new PersistenceError(
        'SCHEMA_VALIDATION_FAILED',
        `Audit operation ${operation.operationId} postStateDigest does not match the persisted state`,
      );
    }
    const body = buildOperationTransitionBody(state, operation, ctx.prevHash);
    const expectedDigest = computeCanonicalEventDigest(body);
    if (expectedDigest !== operation.auditEventDigest) {
      throw new PersistenceError(
        'SCHEMA_VALIDATION_FAILED',
        `Audit operation ${operation.operationId} does not match its committed event digest`,
      );
    }
    const existing = await findOperationAudit(ctx.sessDir, state, operation);
    if (existing) {
      await acknowledgeAuditOperation(ctx.sessDir, operation.operationId, 'reconciled');
      continue;
    }
    await emitAuditBodyWithEvidence({
      deps,
      ctx,
      sessionId,
      body,
      eventKind: 'transition',
      localTimestamp: operation.transition.at,
      timestampTracker,
    });
    await acknowledgeAuditOperation(ctx.sessDir, operation.operationId, 'audit_committed');
    await acknowledgeAuditOperation(ctx.sessDir, operation.operationId, 'reconciled');
  }
}

/**
 * A state that predates the outbox has an empty pendingAuditOperations array.
 * Its persisted transition must still have contemporaneous audit evidence —
 * otherwise the session carries an unresolvable audit gap and mutations must
 * fail closed. No historical transition event is ever reconstructed.
 */
async function assertNoLegacyTransitionGap(
  sessDir: string,
  state: SessionState | null,
): Promise<void> {
  // Only invoked when the state has no pending audit operations at all.
  if (!state?.transition) return;
  const trail = await readAuditTrail(sessDir);
  if (trail.skipped > 0) {
    throw new PersistenceError(
      'READ_FAILED',
      'Cannot verify legacy transition audit evidence: audit trail contains malformed records',
    );
  }
  const transition = state.transition;
  const evidenceExists = trail.events.some(
    (event) =>
      event.detail.kind === 'transition' &&
      event.detail.from === transition.from &&
      event.detail.to === transition.to &&
      event.detail.event === transition.event &&
      event.timestamp === transition.at,
  );
  if (!evidenceExists) throw new AuditTransitionEvidenceGapError(transition);
}

async function findOperationAudit(
  sessDir: string,
  state: SessionState,
  operation: PendingAuditOperation,
): Promise<boolean> {
  const trail = await readAuditTrail(sessDir);
  if (trail.skipped > 0) {
    throw new PersistenceError(
      'READ_FAILED',
      `Cannot reconcile audit operation ${operation.operationId}: audit trail contains malformed records`,
    );
  }
  const event = trail.events.find(
    (candidate) =>
      candidate.id === operation.operationId &&
      candidate.detail.operationId === operation.operationId,
  );
  if (!event) return false;
  // The loop already verified digest(operation body) === operation.auditEventDigest;
  // here only the persisted event must equal that same expected digest.
  const expectedDigest = computeCanonicalEventDigest(
    buildOperationTransitionBody(state, operation, event.prevHash ?? 'genesis'),
  );
  if (computeCanonicalEventDigest(event) !== expectedDigest) {
    throw new PersistenceError(
      'SCHEMA_VALIDATION_FAILED',
      `Audit operation ${operation.operationId} does not match its committed audit event`,
    );
  }
  return true;
}

async function acknowledgeAuditOperation(
  sessDir: string,
  operationId: string,
  status: PendingAuditOperation['status'],
): Promise<void> {
  await withSessionWriteLock(sessDir, async () => {
    const state = await readState(sessDir);
    if (!state) {
      throw new PersistenceError(
        'READ_FAILED',
        `Cannot acknowledge audit operation ${operationId}: session state is unavailable`,
      );
    }
    const operation = state.pendingAuditOperations.find((item) => item.operationId === operationId);
    // The reconcile loop only acknowledges operations it just read from this
    // state; an already-reconciled operation needs no further update.
    if (!operation || operation.status === 'reconciled') return;
    const rank = { state_committed: 0, audit_committed: 1, reconciled: 2 } as const;
    const nextStatus = rank[status] > rank[operation.status] ? status : operation.status;
    await writeStateAlreadyLocked(sessDir, {
      ...state,
      pendingAuditOperations: state.pendingAuditOperations.map((item) =>
        item.operationId === operationId ? { ...item, status: nextStatus } : item,
      ),
    });
  });
}

export async function emitAuditBodyWithEvidence(input: {
  deps: AuditDeps;
  ctx: AuditContext;
  sessionId: string;
  body: EventBody;
  eventKind: string;
  localTimestamp: string;
  timestampTracker: StrictTimestampTracker;
}): Promise<void> {
  const { deps, ctx, sessionId, body, eventKind, localTimestamp, timestampTracker } = input;
  const digest = computeCanonicalEventDigest(body);
  const resolution = ctx.timestampAssurance.enabled
    ? await resolveTimestampEvidence({
        policy: ctx.timestampAssurance,
        canonicalEventDigest: digest,
        eventKind,
        localTimestamp,
        ntpResult: ctx.ntpResult,
        tsaProvider: deps.tsaProvider,
        tsaVerifier: deps.timestampVerifier,
      })
    : undefined;
  timestampTracker.record(eventKind, resolution?.error);
  const evt = finalizeWithTimestampEvidence(body, ctx.prevHash, resolution?.evidence, digest);
  ctx.prevHash = evt.chainHash!;
  await deps.appendAndTrack(evt, ctx.sessDir, ctx.enableChainHash, sessionId);
}

export async function finalizeStrictTimestampFailure(
  ctx: AuditContext,
  getFailure: StrictTimestampTracker['failure'],
): Promise<{ auditOk: boolean; block?: boolean; code?: string; reason?: string } | undefined> {
  const failure = getFailure();
  if (!failure) return undefined;
  const currentState = await readState(ctx.sessDir);
  if (currentState) {
    await writeState(ctx.sessDir, {
      ...currentState,
      error: {
        code: 'TSA_TIMESTAMP_ASSURANCE_FAILED',
        message: `Strict timestamp assurance failed for ${failure.eventKind}: ${failure.reason}`,
        recoveryHint:
          'Fix TSA connectivity, trust anchors, or timestamp token validity; or disable audit.timestampAssurance.strict to recover to Slice 1 behavior.',
        occurredAt: ctx.now,
      },
    });
  }
  return {
    auditOk: false,
    block: true,
    code: 'TSA_TIMESTAMP_ASSURANCE_FAILED',
    reason: failure.reason,
  };
}

/** Reconcile state-owned transition audit operations before a new mutation. */
export async function reconcilePendingAuditOperations(
  deps: AuditDeps,
  sessionId: string,
  toolName: string,
): Promise<{ auditOk: boolean; block?: boolean; code?: string; reason?: string } | undefined> {
  try {
    const resolved = await resolveAuditContext(deps, 'flowguard_reconcile', {}, sessionId);
    if (!resolved) {
      // Only a genuine bootstrap may tolerate a missing audit session
      // authority: the very first flowguard_hydrate creates the session and
      // its outbox. Every other FlowGuard mutation fails closed.
      if (toolName === 'flowguard_hydrate' && !(await hasPersistedSessionState(deps, sessionId))) {
        return undefined;
      }
      return {
        auditOk: false,
        block: true,
        code: 'AUDIT_SESSION_AUTHORITY_UNAVAILABLE',
        reason:
          'FlowGuard cannot reconcile durable audit operations because no ' +
          'authoritative audit session mapping exists. Re-run /hydrate or ' +
          'restore the session state.',
      };
    }
    const tracker = createStrictTimestampTracker(resolved.ctx.timestampAssurance);
    await emitTransitionAudits({ deps, ctx: resolved.ctx, sessionId, timestampTracker: tracker });
    return await finalizeStrictTimestampFailure(resolved.ctx, tracker.failure);
  } catch (err) {
    deps.logError('Failed to reconcile durable audit operations', err);
    if (err instanceof AuditTransitionEvidenceGapError) {
      return {
        auditOk: false,
        block: true,
        code: err.code,
        reason: err.message,
      };
    }
    return {
      auditOk: false,
      block: true,
      code: 'AUDIT_PERSISTENCE_FAILED',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

async function hasPersistedSessionState(deps: AuditDeps, sessionId: string): Promise<boolean> {
  const mapped = deps.getSessionDir(sessionId);
  const canonical = (await deps.resolveCanonicalSessionDir?.(sessionId)) ?? null;
  const sessDir = mapped ?? canonical;
  if (!sessDir) return false;
  return (await readState(sessDir)) !== null;
}

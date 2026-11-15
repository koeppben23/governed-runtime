/** Native event consumption and scope fencing, shared by the V2 composition. */
import type { Plugin } from '@opencode/plugin';
import type { OpenCodeEvent } from '@opencode/client';
import { serializeError } from '../logging/error-serialize.js';
import { buildEnforcementError } from './blocked-result.js';
import type { OpenCodeGovernance, ActiveGovernanceScope } from './opencode-governance.js';
import type { OpenCodeHostAdapter } from './opencode-host-adapter.js';
import { projectOpenCodeEvent } from './opencode-host-adapter.js';
import { resolveGovernanceActivation } from '../adapters/governance-activation.js';
import { handlePluginEvent } from './plugin-afterhooks.js';
import { cleanupSessionRuntime, type FlowGuardPluginRuntime } from './plugin-shared.js';
import { recordValidationProgress, type PresentationStore } from './plugin-presentation.js';
import type { SessionState } from '../state/schema.js';
import type { NativeReviewStateAuthority } from './review/dispatch/native-review-dispatch.js';
import { reviewerAwaitTarget } from './review/dispatch/native-review-dispatch.js';
import type { NativeReviewInitialController } from './review/dispatch/native-review-initial.js';
import { awaitInitialReviewerCompletion } from './review/dispatch/native-review-initial.js';

type EventRuntime = { readonly runtime: FlowGuardPluginRuntime };
type ScopedEventRuntime = EventRuntime & { readonly scope: ActiveGovernanceScope };
export interface EventDispatchDeps {
  readonly presentation?: PresentationStore;
  readonly runtimes: ReadonlyMap<string, Promise<EventRuntime>>;
  readonly sessionRoots: Map<string, string>;
  /** Retire an admitted session's event-route only after verified deletion. */
  readonly forgetFenceSession?: (sessionId: string) => void;
  readonly governance: OpenCodeGovernance;
  readonly adapter: OpenCodeHostAdapter;
  readonly invoke: <T>(
    sessionId: string,
    action: (entry: ScopedEventRuntime) => Promise<T>,
  ) => Promise<T | undefined>;
}

/** ACTIVE-scope routing and host-specific wakeup admission, not result evidence. */
export async function dispatchEvent(event: OpenCodeEvent, deps: EventDispatchDeps): Promise<void> {
  const projected = projectOpenCodeEvent(event);
  if (!projected) return;
  const { adapter, invoke } = deps;
  if (event.type === 'session.deleted') {
    await dispatchDeletedSession(projected, deps);
    return;
  }
  if (
    !(await adapter.ownsSessionEvent(
      projected.sessionId,
      event.type === 'session.execution.succeeded' || event.type === 'session.idle',
    ))
  )
    return;
  await invoke(projected.sessionId, async (entry) => {
    if (event.type === 'session.execution.succeeded') {
      if (projected.sessionId !== entry.scope.root.sessionId) return;
      if (!(await adapter.claimSuccessfulExecutionWakeup(event))) return;
    }
    const presentation = deps.presentation;
    await handlePluginEvent(
      entry.runtime,
      projected.event,
      entry.scope.root.sessionId,
      presentation === undefined
        ? undefined
        : (progress) =>
            recordValidationProgress(presentation, entry.scope.root.sessionId, progress),
    );
  });
}

/** Serializes retirement for one session across concurrent delete notifications. */
const retiringSessions = new Set<string>();

/** A verified deletion is the sole retirement boundary for in-memory routing.
 * Persisted BLOCKED authority is never discarded by native notifications. */
async function dispatchDeletedSession(
  projected: NonNullable<ReturnType<typeof projectOpenCodeEvent>>,
  deps: EventDispatchDeps,
): Promise<void> {
  const { adapter, governance, runtimes, sessionRoots } = deps;
  const sessionId = projected.sessionId;
  // Deleted sessions are no longer queryable. Only previously admitted sessions
  // own ephemeral metadata, and unknown notifications never authorize cleanup.
  // A concurrent duplicate must not run the handler twice; keep the admission
  // entry until retirement actually completes so failures remain retryable.
  if (retiringSessions.has(sessionId) || !sessionRoots.has(sessionId)) return;
  retiringSessions.add(sessionId);
  try {
    adapter.forgetSession(sessionId);
    const authority = await resolveGovernanceActivation(governance.store, sessionId);
    if (authority.kind === 'blocked') throw buildEnforcementError(authority.code, authority.reason);
    const root = sessionRoots.get(sessionId);
    const entry = root === undefined ? undefined : runtimes.get(root);
    if (entry) {
      const runtime = (await entry).runtime;
      if (authority.kind === 'active' && authority.record.rootSessionId === sessionId) {
        // The root event handler owns its canonical audit and ephemeral cleanup.
        await handlePluginEvent(runtime, projected.event, sessionId);
      } else {
        // Delegated and inactive sessions have no root event handler, but their
        // transient workspace/diagnostic state must still be released.
        cleanupSessionRuntime(runtime, sessionId);
      }
    }
    sessionRoots.delete(sessionId);
    deps.forgetFenceSession?.(sessionId);
  } finally {
    retiringSessions.delete(sessionId);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createEventFence(governance: OpenCodeGovernance, adapter: OpenCodeHostAdapter) {
  const roots = new Map<string, string>();
  const failed = new Set<string>();
  let streamFailed = false;
  return {
    assert(scope: ActiveGovernanceScope) {
      roots.set(scope.sessionId, scope.root.sessionId);
      if (streamFailed || failed.has(scope.root.sessionId))
        throw buildEnforcementError(
          'PLUGIN_ENFORCEMENT_UNAVAILABLE',
          'The ACTIVE scope lost required event observation.',
        );
    },
    /** Forget a verifiably deleted session's routing hint, never its root's
     * failure latch. Unknown late native failures remain fail-closed. */
    forgetSession(sessionId: string) {
      roots.delete(sessionId);
    },
    failed(error: unknown, event?: OpenCodeEvent) {
      const data: unknown = event?.data;
      const sessionId =
        record(data) && typeof data.sessionID === 'string' ? data.sessionID : undefined;
      const root = sessionId === undefined ? undefined : (roots.get(sessionId) ?? sessionId);
      if (root === undefined) streamFailed = true;
      else failed.add(root);
      governance.failPending('Native event observation failed.', root);
      adapter.log('error', 'V2 event stream unavailable', serializeError(error));
    },
  };
}

export interface EventLoopDeps extends EventDispatchDeps {
  readonly ctx: Plugin.Context;
  readonly signal: AbortSignal;
  readonly presentation: PresentationStore;
  readonly failed: (error: unknown, event?: OpenCodeEvent) => void;
  readonly operations: Set<Promise<unknown>>;
}

/**
 * Subscribe once to the native stream. Presentation is cleared for a deleted
 * session before any workflow cleanup, and a status record never becomes a
 * governance operation.
 */
export function startEventLoop(deps: EventLoopDeps): Promise<void> {
  return consumeEvents(
    deps.ctx,
    deps.signal,
    (event) => {
      if (event.type === 'session.deleted') deps.presentation.clear(event.data.sessionID);
      return deps.governance.observeProgress(event) ?? dispatchEvent(event, deps);
    },
    deps.failed,
    deps.operations,
  );
}

/** A hard ceiling avoids unbounded host-event fan-out and heap retention. */
const MAX_IN_FLIGHT_NATIVE_EVENT_HANDLERS = 256;

async function consumeEvents(
  ctx: Plugin.Context,
  signal: AbortSignal,
  consume: (event: OpenCodeEvent) => Promise<void>,
  failed: (error: unknown, event?: OpenCodeEvent) => void,
  operations: Set<Promise<unknown>>,
): Promise<void> {
  let inFlight = 0;
  let observationLost = false;
  try {
    for await (const event of ctx.event.subscribe({ signal })) {
      if (signal.aborted) break;
      // Never await a handler here: a handler may require a later host event.
      // Saturation cannot silently drop evidence. Revoke admission globally,
      // continue draining the source without retaining further event bodies.
      if (observationLost) continue;
      if (inFlight >= MAX_IN_FLIGHT_NATIVE_EVENT_HANDLERS) {
        observationLost = true;
        failed(
          buildEnforcementError(
            'PLUGIN_ENFORCEMENT_UNAVAILABLE',
            'Native event handler capacity was exceeded; event observation is incomplete.',
          ),
        );
        continue;
      }
      // Observe progress synchronously before advancing the stream. In particular,
      // reviewer enrollment cannot wait behind a queue of host-dependent handlers.
      const operation = consume(event);
      inFlight += 1;
      operations.add(operation);
      void operation
        .catch((error) => {
          if (!signal.aborted && !observationLost) failed(error, event);
        })
        .finally(() => {
          inFlight -= 1;
          operations.delete(operation);
        });
    }
    if (!signal.aborted && !observationLost)
      failed(
        buildEnforcementError(
          'PLUGIN_ENFORCEMENT_UNAVAILABLE',
          'The V2 event stream ended unexpectedly.',
        ),
      );
  } catch (error) {
    if (!signal.aborted && !observationLost) failed(error);
  }
}

export interface ReviewerInitialAwaitInput {
  readonly ctx: Plugin.Context;
  readonly initial: NativeReviewInitialController;
  readonly event: {
    readonly sessionID: string;
    readonly messageID: string;
    readonly id: string;
    readonly result?: { readonly metadata?: Record<string, unknown> };
  };
  readonly resolve: () => Promise<{
    readonly state: SessionState;
    readonly authority: NativeReviewStateAuthority;
    readonly runtime: { readonly reviewerExecutionTimeoutMs: number };
  } | null>;
}

/**
 * A host may return the `subagent` tool before the bound reviewer child has
 * finished its initial run. Keep the authorized attempt intact and wait for
 * that exact child instead of capturing an unknown outcome prematurely.
 */
export async function awaitReviewerInitialRun(input: ReviewerInitialAwaitInput): Promise<void> {
  const resolved = await input.resolve();
  if (resolved === null) return;
  const target = reviewerAwaitTarget({
    event: input.event,
    state: resolved.state,
    authority: resolved.authority,
  });
  if (target === null) return;
  const { childSessionId } = target;
  await awaitInitialReviewerCompletion({
    childSessionId,
    initial: input.initial,
    isTerminal: async () => {
      try {
        const session = await input.ctx.session.get({ sessionID: childSessionId });
        if (session.outcome !== undefined) return true;
        const busy = session.time?.busy;
        const idle = session.time?.idle;
        // An old idle timestamp is not terminal when the child started a newer
        // step; wait for that step instead of capturing it prematurely.
        return idle !== undefined && (busy === undefined || busy <= idle);
      } catch {
        return true;
      }
    },
    wait: () =>
      input.ctx.session.wait(
        { sessionID: childSessionId },
        { signal: AbortSignal.timeout(resolved.runtime.reviewerExecutionTimeoutMs) },
      ),
  });
}

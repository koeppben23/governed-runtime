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
import type { FlowGuardPluginRuntime } from './plugin-shared.js';
import { recordValidationProgress, type PresentationStore } from './plugin-presentation.js';

type EventRuntime = { readonly runtime: FlowGuardPluginRuntime };
type ScopedEventRuntime = EventRuntime & { readonly scope: ActiveGovernanceScope };
export interface EventDispatchDeps {
  readonly presentation?: PresentationStore;
  readonly runtimes: ReadonlyMap<string, Promise<EventRuntime>>;
  readonly sessionRoots: Map<string, string>;
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
  const { adapter, governance, runtimes, sessionRoots, invoke } = deps;
  if (event.type === 'session.deleted') {
    // Deleted sessions cannot be looked up. Only a runtime that previously
    // admitted this session owns its in-memory cleanup.
    if (!sessionRoots.has(projected.sessionId)) return;
    adapter.forgetSession(projected.sessionId);
    const authority = await resolveGovernanceActivation(governance.store, projected.sessionId);
    if (authority.kind === 'blocked') throw buildEnforcementError(authority.code, authority.reason);
    if (authority.kind !== 'active') return;
    const root = sessionRoots.get(projected.sessionId);
    const entry = root === undefined ? undefined : runtimes.get(root);
    if (entry && authority.record.rootSessionId === projected.sessionId)
      await handlePluginEvent((await entry).runtime, projected.event, projected.sessionId);
    sessionRoots.delete(projected.sessionId);
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

async function consumeEvents(
  ctx: Plugin.Context,
  signal: AbortSignal,
  consume: (event: OpenCodeEvent) => Promise<void>,
  failed: (error: unknown, event?: OpenCodeEvent) => void,
  operations: Set<Promise<unknown>>,
): Promise<void> {
  try {
    for await (const event of ctx.event.subscribe({ signal })) {
      // Never make the source await a handler whose host I/O can publish events.
      const operation = consume(event);
      operations.add(operation);
      void operation
        .catch((error) => {
          if (!signal.aborted) failed(error, event);
        })
        .finally(() => operations.delete(operation));
    }
    if (!signal.aborted)
      failed(
        buildEnforcementError(
          'PLUGIN_ENFORCEMENT_UNAVAILABLE',
          'The V2 event stream ended unexpectedly.',
        ),
      );
  } catch (error) {
    if (!signal.aborted) failed(error);
  }
}

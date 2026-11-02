/** Native event consumption and scope fencing, shared by the V2 composition. */
import type { Plugin } from '@opencode/plugin';
import type { OpenCodeEvent } from '@opencode/client';
import { serializeError } from '../logging/error-serialize.js';
import { buildEnforcementError } from './blocked-result.js';
import type { OpenCodeGovernance, ActiveGovernanceScope } from './opencode-governance.js';
import type { OpenCodeHostAdapter } from './opencode-host-adapter.js';

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

export async function consumeEvents(
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

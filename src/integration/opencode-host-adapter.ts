/** OpenCode V2 mechanics. No SDK request/response envelope enters governance. */
import type { Plugin } from '@opencode/plugin';
import type { OpenCodeEvent } from '@opencode/client';
import type { HostAdapter, HostSession } from '../adapters/host-adapter.js';
import type { OrchestratorClient } from './review/types.js';
import type { PluginEvent } from './plugin-events.js';
import { encodeHostCallId } from '../state/host-identity.js';

class HostAdapterInitError extends Error {
  readonly code = 'HOST_ADAPTER_INIT_FAILED';
}

function hasMethods(domain: unknown, methods: readonly string[]): boolean {
  if (domain === null || typeof domain !== 'object') return false;
  return methods.every((method) => typeof Reflect.get(domain, method) === 'function');
}

export class OpenCodeHostAdapter implements HostAdapter, OrchestratorClient {
  constructor(
    readonly context: Plugin.Context,
    private readonly signal: AbortSignal,
  ) {}

  async initialize(): Promise<void> {
    const ctx = this.context;
    const available = [
      hasMethods(ctx.session, ['get', 'context', 'prompt', 'wait', 'hook']),
      hasMethods(ctx.tool, ['hook', 'transform']),
      hasMethods(ctx.event, ['subscribe']),
      hasMethods(ctx.storage, ['get', 'set', 'scan']),
    ];
    if (available.includes(false)) {
      throw new HostAdapterInitError('The native OpenCode V2 plugin context is incomplete.');
    }
  }

  async shutdown(): Promise<void> {
    /* Registrations are owned by plugin setup/cleanup. */
  }

  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void {
    console[level](`[FlowGuard] ${message}`, ...(data === undefined ? [] : [data]));
  }

  async getSession(sessionId: string): Promise<HostSession> {
    const session = await this.context.session.get(
      { sessionID: sessionId },
      { signal: this.signal },
    );
    if (session.id !== sessionId) {
      throw new HostAdapterInitError(
        'The host returned another session for an exact session lookup.',
      );
    }
    return {
      sessionId: session.id,
      directory: session.location.directory,
      ...(session.parentID === undefined ? {} : { parentSessionId: session.parentID }),
      ...(session.agent === undefined ? {} : { agent: session.agent }),
    };
  }

  async readHistory(sessionId: string): Promise<unknown> {
    // Preserve native bytes/identities. In particular, never synthesize a V1
    // assistant parentID from an inbox admission or the latest response.
    return this.context.session.context({ sessionID: sessionId }, { signal: this.signal });
  }
}

/** Project notifications to existing application events, never to completion evidence. */
export function projectOpenCodeEvent(event: OpenCodeEvent): {
  readonly sessionId: string;
  readonly event: PluginEvent;
} | null {
  if (event.type === 'session.tool.failed') {
    return {
      sessionId: event.data.sessionID,
      event: {
        type: event.type,
        data: {
          ...event.data,
          hostEventId: event.id,
          hostCallId: encodeHostCallId(
            event.data.sessionID,
            event.data.assistantMessageID,
            event.data.id,
          ),
        },
      },
    };
  }
  if (
    event.type === 'session.deleted' ||
    event.type === 'session.idle' ||
    event.type === 'session.execution.failed'
  ) {
    return {
      sessionId: event.data.sessionID,
      event: { type: event.type, data: { ...event.data, hostEventId: event.id } },
    };
  }
  return null;
}

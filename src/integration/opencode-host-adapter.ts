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
  private readonly successSequences = new Map<string, number>();
  constructor(
    readonly context: Plugin.Context,
    private readonly signal: AbortSignal,
  ) {}

  async initialize(): Promise<void> {
    const ctx = this.context;
    const available = [
      hasMethods(ctx.session, ['get', 'context', 'prompt', 'wait', 'interrupt', 'hook']),
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

  private async readSession(sessionId: string) {
    const session = await this.context.session.get(
      { sessionID: sessionId },
      { signal: this.signal },
    );
    if (session.id !== sessionId) {
      throw new HostAdapterInitError(
        'The host returned another session for an exact session lookup.',
      );
    }
    return session;
  }

  async getSession(sessionId: string): Promise<HostSession> {
    const session = await this.readSession(sessionId);
    return {
      sessionId: session.id,
      directory: session.location.directory,
      ...(session.parentID === undefined ? {} : { parentSessionId: session.parentID }),
      ...(session.agent === undefined ? {} : { agent: session.agent }),
    };
  }

  /** A notification is only a wakeup, never check evidence. Claim before the
   * read/runner so concurrent delivery and replay after backoff cannot retry it.
   * A fresh native read must still describe this exact successful terminal run;
   * idle/outcome alone can belong to an earlier execution while another runs. */
  async claimSuccessfulExecutionWakeup(
    event: Extract<OpenCodeEvent, { type: 'session.execution.succeeded' }>,
  ): Promise<boolean> {
    const sessionId = event.data.sessionID;
    if (event.durable.aggregateID !== sessionId) return false;
    const previous = this.successSequences.get(sessionId) ?? -1;
    if (event.durable.seq <= previous) return false;
    this.successSequences.set(sessionId, event.durable.seq);
    const session = await this.readSession(sessionId);
    return (
      session.outcome === 'succeeded' &&
      session.time.idle === event.created &&
      session.time.busy !== undefined &&
      session.time.busy <= session.time.idle
    );
  }

  forgetSession(sessionId: string): void {
    this.successSequences.delete(sessionId);
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
  if (event.type === 'session.execution.succeeded') {
    return {
      sessionId: event.data.sessionID,
      event: {
        type: event.type,
        data: { ...event.data, hostEventId: event.id, hostCreatedAt: event.created },
      },
    };
  }
  return null;
}

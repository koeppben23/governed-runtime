/** OpenCode V2 mechanics. No SDK request/response envelope enters governance. */
import type { Plugin } from '@opencode/plugin';
import type { OpenCodeEvent } from '@opencode/client';
import type {
  HostAdapter,
  HostCapabilities,
  HostToolEvent,
  BlockDecision,
  CapabilityValidationResult,
} from '../adapters/host-adapter.js';
import type { OrchestratorClient } from './review/types.js';
import type { PluginEvent } from './plugin-events.js';
import { buildEnforcementError } from './blocked-result.js';

export class HostAdapterInitError extends Error {
  readonly code = 'HOST_ADAPTER_INIT_FAILED';
}

export class HostCapabilityMismatchError extends Error {
  readonly code = 'HOST_CAPABILITY_MISMATCH';
  constructor(mismatches: ReadonlyArray<{ readonly capability: string }>) {
    super(
      `OpenCode host capability mismatch: ${mismatches.map((item) => item.capability).join(', ')}`,
    );
  }
}

export class HostReviewProofUnavailableError extends Error {
  readonly code = 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN';
}

function hasMethods(domain: unknown, methods: readonly string[]): boolean {
  if (domain === null || typeof domain !== 'object') return false;
  return methods.every((method) => typeof Reflect.get(domain, method) === 'function');
}

export class OpenCodeHostAdapter implements HostAdapter, OrchestratorClient {
  readonly platform = 'opencode' as const;
  readonly enforcementLevel = 'synchronous' as const;
  readonly capabilities: HostCapabilities = {
    preToolBlock: true,
    argMutation: true,
    outputReplacement: true,
    contextInjection: true,
    compactionInjection: true,
    // A native subagent capability is not a validated review transport.
    reviewTransports: [],
  };

  constructor(
    readonly context: Plugin.Context,
    private readonly signal: AbortSignal,
  ) {}

  getWorkingDirectory(): string {
    return this.context.location.directory;
  }
  getWorktree(): string {
    return this.context.location.directory;
  }

  async initialize(): Promise<void> {
    const ctx = this.context;
    const available = [
      hasMethods(ctx.agent, ['list']),
      hasMethods(ctx.session, ['get', 'context', 'interrupt', 'hook']),
      hasMethods(ctx.tool, ['hook', 'transform']),
      hasMethods(ctx.event, ['subscribe']),
    ];
    if (available.includes(false)) {
      throw new HostAdapterInitError('The native OpenCode V2 plugin context is incomplete.');
    }
  }

  async validateCapabilities(): Promise<CapabilityValidationResult> {
    return {
      valid: true,
      mismatches: [],
      runtimeVerified: [],
      contractAttested: [
        'preToolBlock',
        'argMutation',
        'outputReplacement',
        'contextInjection',
        'compactionInjection',
      ],
    };
  }

  async shutdown(): Promise<void> {
    /* Registrations are owned by plugin setup/cleanup. */
  }

  deliverBlockDecision(_event: HostToolEvent, decision: BlockDecision): never {
    throw buildEnforcementError(decision.code, decision.reason);
  }

  isReviewerSupported(): boolean {
    return false;
  }

  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void {
    console[level](`[FlowGuard] ${message}`, ...(data === undefined ? [] : [data]));
  }

  async listAgents(sessionId: string): Promise<readonly { readonly id: string }[]> {
    const session = await this.getSession(sessionId);
    const agents = await this.context.agent.list(
      { location: { directory: session.directory } },
      { signal: this.signal },
    );
    return agents.data.map((agent) => ({ id: agent.id }));
  }

  async getSession(sessionId: string): ReturnType<OrchestratorClient['getSession']> {
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
    };
  }

  async readHistory(sessionId: string): Promise<unknown> {
    // Preserve native bytes/identities. In particular, never synthesize a V1
    // assistant parentID from an inbox admission or the latest response.
    return this.context.session.context({ sessionID: sessionId }, { signal: this.signal });
  }

  async interrupt(sessionId: string): Promise<boolean> {
    const result = await this.context.session.interrupt(
      { sessionID: sessionId, resume: false },
      { signal: this.signal },
    );
    return result.interrupted === true;
  }

  async quiescence(_sessionId: string): Promise<'unknown'> {
    // wait(), idle notifications and session outcome alone are not a proven
    // joint quiescence/terminal-history observation for reviewer recovery.
    return 'unknown';
  }

  async reviewerCall(_parentSessionId: string, _childSessionId: string): Promise<never> {
    throw new HostReviewProofUnavailableError(
      'The pinned V2 reviewer release-to-child proof is NOT_VERIFIED.',
    );
  }

  async executeReviewerPrompt(
    _input: Parameters<OrchestratorClient['executeReviewerPrompt']>[0],
  ): Promise<never> {
    throw new HostReviewProofUnavailableError(
      'V2 inbox admission is not serialization completion. Same-child request/terminal/capture proof is NOT_VERIFIED.',
    );
  }
}

/** Project notifications to existing application events, never to completion evidence. */
export function projectOpenCodeEvent(event: OpenCodeEvent): {
  readonly sessionId: string;
  readonly event: PluginEvent;
} | null {
  if (
    event.type === 'session.deleted' ||
    event.type === 'session.idle' ||
    event.type === 'session.execution.failed' ||
    event.type === 'session.tool.failed'
  ) {
    return {
      sessionId: event.data.sessionID,
      event: { type: event.type, data: { ...event.data, hostEventId: event.id } },
    };
  }
  return null;
}

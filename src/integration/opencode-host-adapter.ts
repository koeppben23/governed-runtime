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
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { z } from 'zod';

class HostAdapterInitError extends Error {
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
    // One concrete native subagent transport with a proven terminal capture
    // window. Historical Task evidence keeps its own generation.
    reviewTransports: [
      {
        kind: 'native_subagent_message_json',
        validatedResult: true,
        parentVisible: true,
        transcriptNavigable: true,
        isolatedAgentIdentity: true,
        permissionIsolation: true,
        assurance: 'host_message_validated',
      },
    ],
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
      hasMethods(ctx.session, ['get', 'context', 'prompt', 'wait', 'hook']),
      hasMethods(ctx.tool, ['hook', 'transform']),
      hasMethods(ctx.event, ['subscribe']),
      hasMethods(ctx.storage, ['get', 'set', 'scan']),
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
    return true;
  }

  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void {
    console[level](`[FlowGuard] ${message}`, ...(data === undefined ? [] : [data]));
  }

  async getSession(sessionId: string): Promise<{
    readonly sessionId: string;
    readonly parentSessionId?: string;
    readonly directory: string;
    readonly agent?: string;
  }> {
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
          hostCallId: nativeHostCallId(
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

/**
 * OpenCode 2.2.4 passes the provider's tool-call ID verbatim as the native call
 * identity; it is unique only within one host-generated assistant message of one
 * session. Governance call identities therefore bind all three host values.
 */
export function nativeHostCallId(sessionId: string, messageId: string, callId: string): string {
  if (!sessionId || !messageId || !callId)
    throw buildEnforcementError(
      'PLUGIN_ENFORCEMENT_UNAVAILABLE',
      'A native tool call requires host session, assistant-message and call identities.',
    );
  return canonicalJsonStringify({ callId, messageId, sessionId });
}

const NativeCallIdentity = z.strictObject({
  sessionId: z.string().min(1),
  messageId: z.string().min(1),
  callId: z.string().min(1),
});

/** Read an exact current identity to select native history. Never normalize an
 * old/raw ID or rewrite a persisted episode into the current tuple contract. */
export function readNativeHostCallIdentity(
  value: string,
): z.infer<typeof NativeCallIdentity> | null {
  try {
    const parsed = NativeCallIdentity.safeParse(JSON.parse(value));
    if (!parsed.success) return null;
    const { sessionId, messageId, callId } = parsed.data;
    return nativeHostCallId(sessionId, messageId, callId) === value ? parsed.data : null;
  } catch {
    return null;
  }
}

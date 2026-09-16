/**
 * @module integration/opencode-host-adapter
 * @description OpenCode platform adapter — concrete implementation of HostAdapter (HAI).
 *
 * Independent review has exactly one productive OpenCode transport:
 * `native_task_structured_followup`. OpenCode's native Task owns the visible,
 * navigable, permission-isolated reviewer child; FlowGuard then requests
 * schema-constrained serialization in that SAME child session. A direct
 * session.create/session.prompt child is intentionally not advertised because
 * OpenCode does not surface it as a native subagent in the parent UI.
 *
 * @see https://github.com/koeppben23/governed-runtime/issues/242
 * @version v5
 */

import type {
  HostAdapter,
  HostCapabilities,
  HostReviewTransportCapability,
  HostToolEvent,
  BlockDecision,
  ToolResultMutation,
  CapabilityValidationResult,
  EnforcementLevel,
} from '../adapters/host-adapter.js';
import {
  REQUIRED_INDEPENDENT_REVIEW_TRANSPORT,
  reviewTransportSatisfies,
} from '../adapters/host-adapter.js';
import type { OrchestratorClient } from './review/types.js';
import { buildEnforcementError } from './plugin-helpers.js';

export interface OpenCodeAdapterConfig {
  readonly client: OrchestratorClient;
  readonly directory: string;
  readonly worktree: string;
}

export class HostAdapterInitError extends Error {
  readonly code = 'HOST_ADAPTER_INIT_FAILED' as const;

  constructor(message: string) {
    super(message);
    this.name = 'HostAdapterInitError';
  }
}

export class HostCapabilityMismatchError extends Error {
  readonly code = 'HOST_CAPABILITY_MISMATCH' as const;

  constructor(mismatches: ReadonlyArray<{ readonly capability: string }>) {
    const names = mismatches.map((mismatch) => mismatch.capability).join(', ');
    super(`[FlowGuard] OpenCode host capability mismatch: ${names || 'unknown'}`);
    this.name = 'HostCapabilityMismatchError';
  }
}

const NATIVE_TASK_STRUCTURED_REVIEW_TRANSPORT: HostReviewTransportCapability = {
  kind: 'native_task_structured_followup',
  structuredOutput: true,
  parentVisible: true,
  transcriptNavigable: true,
  isolatedAgentIdentity: true,
  // OpenCode's native Task derives child permissions from the parent and the
  // selected subagent, and applies additional task/primary-tool denies.
  permissionIsolation: true,
  assurance: 'structured_high',
};

export class OpenCodeHostAdapter implements HostAdapter {
  readonly platform = 'opencode' as const;

  readonly capabilities: HostCapabilities = {
    preToolBlock: true,
    argMutation: true,
    outputReplacement: true,
    contextInjection: true,
    reviewTransports: [NATIVE_TASK_STRUCTURED_REVIEW_TRANSPORT],
    compactionInjection: true,
  };

  readonly enforcementLevel: EnforcementLevel = 'synchronous';

  private readonly client: OrchestratorClient;
  private readonly directoryPath: string;
  private readonly worktreePath: string;

  constructor(config: OpenCodeAdapterConfig) {
    this.client = config.client;
    this.directoryPath = config.directory;
    this.worktreePath = config.worktree;
  }

  getWorkingDirectory(): string {
    return this.directoryPath;
  }

  getWorktree(): string {
    return this.worktreePath;
  }

  async initialize(): Promise<void> {
    // Native Task creation is host-owned and therefore absent from the client
    // API used here. FlowGuard only needs the agent registry and same-child
    // session.prompt for the structured serialization half of the transport.
    if (
      typeof this.client?.app?.agents !== 'function' ||
      typeof this.client?.session?.prompt !== 'function'
    ) {
      throw new HostAdapterInitError(
        '[FlowGuard] OpenCode adapter initialization failed: SDK client missing ' +
          'app.agents or session.prompt. Cannot guarantee native reviewer structured serialization.',
      );
    }
  }

  /**
   * Boot validation is contract-attested only. The native Task lifecycle is
   * runtime-observed at the before/after hook boundary and exact child metadata
   * is required before evidence can bind.
   */
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
        'reviewTransports.native_task_structured_followup',
        'compactionInjection',
      ],
    };
  }

  async shutdown(): Promise<void> {
    // OpenCode plugin lifecycle is SDK-managed.
  }

  deliverBlockDecision(_event: HostToolEvent, decision: BlockDecision): void {
    throw buildEnforcementError(decision.code, decision.reason);
  }

  deliverArgMutation(_event: HostToolEvent, _args: Record<string, unknown>): void {
    // OpenCode argument mutation is performed directly on the hook output ref.
  }

  mutateToolResult(_event: HostToolEvent, _mutation: ToolResultMutation): void {
    // OpenCode result mutation is performed directly on the hook output ref.
  }

  isReviewerSupported(): boolean {
    return this.capabilities.reviewTransports.some((transport) =>
      reviewTransportSatisfies(transport, REQUIRED_INDEPENDENT_REVIEW_TRANSPORT),
    );
  }

  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void {
    if (this.client.tui?.showToast && (level === 'warn' || level === 'error')) {
      this.client.tui
        .showToast({
          body: {
            message: `[FlowGuard] ${message}`,
            variant: level === 'error' ? 'error' : 'info',
          },
        })
        .catch(() => {
          /* diagnostic-only */
        });
    }
    void data;
  }

  injectCompactionContext(_context: string): void {
    // OpenCode compaction context is injected directly by the hook handler.
  }
}

export function createOpenCodeHostAdapter(config: OpenCodeAdapterConfig): HostAdapter {
  return new OpenCodeHostAdapter(config);
}

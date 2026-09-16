/**
 * @module integration/opencode-host-adapter
 * @description OpenCode platform adapter — concrete implementation of HostAdapter (HAI).
 *
 * Review capabilities are declared per concrete transport. OpenCode's SDK
 * session.create + session.prompt path provides schema-constrained structured
 * review in an isolated child session, but the parent TUI does not materialize
 * that direct child as a native Task/subagent. FlowGuard therefore reports the
 * capability honestly and fails closed when product policy requires a visible
 * independent reviewer.
 *
 * @see https://github.com/koeppben23/governed-runtime/issues/242
 * @version v4
 */

import type {
  HostAdapter,
  HostCapabilities,
  HostReviewTransportCapability,
  HostToolEvent,
  BlockDecision,
  ToolResultMutation,
  ReviewerSpawnConfig,
  HostReviewerResult,
  CapabilityValidationResult,
  EnforcementLevel,
  ReviewTransportRequirements,
} from '../adapters/host-adapter.js';
import {
  REQUIRED_INDEPENDENT_REVIEW_TRANSPORT,
  reviewTransportSatisfies,
} from '../adapters/host-adapter.js';
import type { OrchestratorClient } from './review/types.js';
import { invokeReviewer } from './review/orchestrator.js';
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

const SDK_STRUCTURED_REVIEW_TRANSPORT: HostReviewTransportCapability = {
  kind: 'sdk_structured_session',
  structuredOutput: true,
  parentVisible: false,
  transcriptNavigable: false,
  isolatedAgentIdentity: true,
  // session.create in the pinned SDK surface cannot bind a permission profile.
  permissionIsolation: false,
  assurance: 'structured_high',
};

function effectiveRequirements(config: ReviewerSpawnConfig): ReviewTransportRequirements {
  const requested = config.transportRequirements;
  if (!requested) return REQUIRED_INDEPENDENT_REVIEW_TRANSPORT;

  // A call site may tighten the canonical product contract but must not weaken
  // it. Product requirements remain the lower bound.
  return {
    structuredOutput:
      REQUIRED_INDEPENDENT_REVIEW_TRANSPORT.structuredOutput || requested.structuredOutput,
    parentVisible: REQUIRED_INDEPENDENT_REVIEW_TRANSPORT.parentVisible || requested.parentVisible,
    transcriptNavigable:
      REQUIRED_INDEPENDENT_REVIEW_TRANSPORT.transcriptNavigable || requested.transcriptNavigable,
    isolatedAgentIdentity:
      REQUIRED_INDEPENDENT_REVIEW_TRANSPORT.isolatedAgentIdentity ||
      requested.isolatedAgentIdentity,
    permissionIsolation:
      REQUIRED_INDEPENDENT_REVIEW_TRANSPORT.permissionIsolation || requested.permissionIsolation,
  };
}

export class OpenCodeHostAdapter implements HostAdapter {
  readonly platform = 'opencode' as const;

  readonly capabilities: HostCapabilities = {
    preToolBlock: true,
    argMutation: true,
    outputReplacement: true,
    contextInjection: true,
    reviewTransports: [SDK_STRUCTURED_REVIEW_TRANSPORT],
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
    if (
      typeof this.client?.session?.create !== 'function' ||
      typeof this.client?.session?.prompt !== 'function'
    ) {
      throw new HostAdapterInitError(
        '[FlowGuard] OpenCode adapter initialization failed: SDK client missing ' +
          'session.create or session.prompt methods. Cannot guarantee reviewer capability.',
      );
    }
  }

  /**
   * Boot validation is contract-attested only. Reviewer registry and transport
   * usability are verified on the actual review path to avoid re-entrant host I/O.
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
        'reviewTransports.sdk_structured_session',
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

  async spawnReviewer(config: ReviewerSpawnConfig): Promise<HostReviewerResult | null> {
    const requirements = effectiveRequirements(config);
    const transport = this.capabilities.reviewTransports.find((candidate) =>
      reviewTransportSatisfies(candidate, requirements),
    );

    // Critical epistemic gate: do not execute a real-but-invisible child and
    // then present its verdict as satisfying a visible independent-review
    // contract. The block occurs before session.create and before dispatch
    // authorization, so no hidden reviewer is released.
    if (!transport) {
      return {
        blocked: true,
        code: 'VISIBLE_REVIEW_TRANSPORT_UNAVAILABLE',
        reason:
          'OpenCode exposes no single review transport that is both schema-structured and parent-visible',
        reviewInvocation: {
          host: this.platform,
          requirements,
          availableTransports: this.capabilities.reviewTransports,
        },
      };
    }

    const options: Record<string, unknown> = {
      _authorizeDispatch: config.authorizeDispatch,
      _abandonDispatch: config.abandonDispatch,
    };
    if (config.maxTransportRetries !== undefined) {
      options.maxTransportRetries = config.maxTransportRetries;
    }
    if (config.baseDelayMs !== undefined) {
      options.baseDelayMs = config.baseDelayMs;
    }
    if (config.onAttemptFailed !== undefined) {
      options._onAttemptFailed = config.onAttemptFailed;
    }
    if (config.onAttemptSucceeded !== undefined) {
      options._onAttemptSucceeded = config.onAttemptSucceeded;
    }

    const result = await invokeReviewer(
      this.client,
      config.prompt,
      config.parentSessionId,
      options,
    );
    if (result === null) return null;
    if (result.blocked) return result;

    return {
      ...result,
      reviewTransport: transport.kind,
      hostVisible: transport.parentVisible,
      transcriptNavigable: transport.transcriptNavigable,
    };
  }

  isReviewerSupported(): boolean {
    return this.capabilities.reviewTransports.length > 0;
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

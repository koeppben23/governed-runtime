/**
 * @module integration/plugin-shared
 * @description Shared types and helpers for the FlowGuard plugin — used by
 *              both plugin.ts (before-hook enforcement) and
 *              plugin-afterhooks.ts (after-hook processing).
 *
 * Shared plugin runtime types and trace helpers used by both before-hook
 * and after-hook modules.
 *
 * @version v1
 */

import { randomUUID } from 'node:crypto';
import { createPluginLogger } from './plugin-logging.js';
import { runWithAdapterLoggerAsync } from '../logging/adapter-logger.js';
import { createWorkspace } from './plugin-workspace.js';
import type { RiskEnforcementDeps } from './plugin-risk.js';
import type { DiscoveryHealthEnforcementDeps } from './plugin-discovery-health.js';
import type { OrchestratorDeps } from './plugin-orchestrator.js';
import type { AuditDeps } from './plugin-audit.js';
import type { ToolHookBeforeInput, ToolHookAfterInput } from './types.js';

type PluginLogger = Awaited<ReturnType<typeof createPluginLogger>>['log'];
type PluginWorkspaceRuntime = ReturnType<typeof createWorkspace>;

export const FG_PREFIX = 'flowguard_';
const TRACE_REGISTRY_LIMIT = 1000;

/** Limits tool use until the host observes the next explicit user command. */
export type ActiveCommandScope = 'check';

/**
 * Session IDs whose /check command is inside a reviewer-requested repair
 * continuation. The persisted `implementationRework` marker is cleared by the
 * first re-record (`flowguard_implement` sets it to null), so the continuation
 * cannot hang on that marker; this command-scope-local latch keeps the repair
 * surface unlocked through IMPLEMENTATION → IMPL_VALIDATION → IMPLEMENTATION
 * until the review loop's terminal verdict.
 */
export interface FlowGuardPluginRuntime {
  readonly ws: PluginWorkspaceRuntime;
  readonly log: PluginLogger;
  readonly adapterLog: Parameters<typeof runWithAdapterLoggerAsync>[0];
  readonly riskDeps: RiskEnforcementDeps;
  readonly discoveryHealthDeps: DiscoveryHealthEnforcementDeps;
  readonly orchestratorDeps: OrchestratorDeps;
  readonly auditDeps: AuditDeps;
  readonly toolTraceIds: Map<string, string>;
  readonly activeCommandScopes: Map<string, ActiveCommandScope>;
  readonly checkReworkContinuations: Set<string>;
  readonly setCurrentSessionId: (sessionId: string) => void;
  readonly logError: (message: string, err: unknown) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function fallbackToolTraceKey(
  input: Partial<ToolHookBeforeInput & ToolHookAfterInput>,
): string | null {
  if (typeof input.sessionID !== 'string' || typeof input.tool !== 'string') return null;
  return `${input.sessionID}:${input.tool}`;
}

export function getToolTraceId(
  runtime: FlowGuardPluginRuntime,
  input: unknown,
  phase: 'before' | 'after',
): string {
  const hookInput = isRecord(input)
    ? (input as Partial<ToolHookBeforeInput & ToolHookAfterInput>)
    : {};
  if (typeof hookInput.callID === 'string' && hookInput.callID.length > 0) {
    return hookInput.callID;
  }

  const key = fallbackToolTraceKey(hookInput);
  if (!key) return randomUUID();

  if (phase === 'after') {
    const existing = runtime.toolTraceIds.get(key);
    if (existing) runtime.toolTraceIds.delete(key);
    return existing ?? randomUUID();
  }

  const traceId = randomUUID();
  if (runtime.toolTraceIds.size >= TRACE_REGISTRY_LIMIT) runtime.toolTraceIds.clear();
  runtime.toolTraceIds.set(key, traceId);
  return traceId;
}

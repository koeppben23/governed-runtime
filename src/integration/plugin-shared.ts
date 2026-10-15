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

const TRACE_REGISTRY_LIMIT = 1000;
/** Upper bound for in-flight latency starts; the oldest start is evicted first. */
const LATENCY_REGISTRY_LIMIT = 1000;
/** Separator that cannot occur in a host session id or call id. */
const LATENCY_KEY_SEPARATOR = '\u0000';

/** Limits tool use until the host observes the next explicit user command. */
export type ActiveCommandScope = 'check';

/**
 * Session IDs whose /check command is inside a reviewer-requested repair
 * continuation. The persisted `implementationRework` marker is retained across
 * re-records and closed only on the full validation pass into IMPL_REVIEW; the
 * command-scope-local latch additionally keeps the repair surface unlocked
 * through IMPLEMENTATION → IMPL_VALIDATION → IMPLEMENTATION until the review
 * loop's terminal verdict even if the marker were absent.
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
  /**
   * Diagnostic-only tool latency starts keyed by session and call id (see
   * {@link recordToolLatencyStart}). Never consulted by enforcement.
   */
  readonly toolLatencyStarts: Map<string, number>;
  readonly activeCommandScopes: Map<string, ActiveCommandScope>;
  readonly checkReworkContinuations: Set<string>;
  readonly logError: (message: string, err: unknown) => void;
}

/**
 * Remove all session-scoped runtime ephemera for a terminated session.
 *
 * Single cleanup authority for host session termination: persists nothing,
 * drops enforcement/chain state plus the in-memory maps held by the plugin
 * runtime (command scopes, rework continuations, tool trace correlation,
 * tool latency starts).
 */
export function cleanupSessionRuntime(runtime: FlowGuardPluginRuntime, sessionId: string): void {
  runtime.ws.invalidateChainState(sessionId);
  runtime.activeCommandScopes.delete(sessionId);
  runtime.checkReworkContinuations.delete(sessionId);
  const traceKeyPrefix = `${sessionId}:`;
  for (const key of runtime.toolTraceIds.keys()) {
    if (key.startsWith(traceKeyPrefix)) runtime.toolTraceIds.delete(key);
  }
  const latencyKeyPrefix = `${sessionId}${LATENCY_KEY_SEPARATOR}`;
  for (const key of runtime.toolLatencyStarts.keys()) {
    if (key.startsWith(latencyKeyPrefix)) runtime.toolLatencyStarts.delete(key);
  }
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

// ─── Diagnostic tool latency (never enforcement) ─────────────────────────────

/** Why a tool latency could not be measured. A missing measurement is never 0. */
type ToolLatencyUnavailable =
  'call_id_missing' | 'session_id_missing' | 'start_not_observed';

export type ToolLatencyObservation =
  { readonly beforeToAfterMs: number } | { readonly durationUnavailable: ToolLatencyUnavailable };

/**
 * Correlation key: exactly one host call in exactly one session. Without a
 * call id there is NO key - concurrent calls of the same tool in one session
 * must never be attributed to each other.
 */
function toolLatencyKey(input: unknown): string | ToolLatencyUnavailable {
  const hookInput = isRecord(input) ? (input as Partial<ToolHookBeforeInput>) : {};
  if (typeof hookInput.callID !== 'string' || hookInput.callID.length === 0) {
    return 'call_id_missing';
  }
  if (typeof hookInput.sessionID !== 'string' || hookInput.sessionID.length === 0) {
    return 'session_id_missing';
  }
  return `${hookInput.sessionID}${LATENCY_KEY_SEPARATOR}${hookInput.callID}`;
}

function isLatencyKey(key: string | ToolLatencyUnavailable): boolean {
  return key.includes(LATENCY_KEY_SEPARATOR);
}

/**
 * Record the end of a successfully completed FlowGuard before-hook. Callers
 * invoke this only after every before-hook rule passed, so a blocked call never
 * leaves a start behind. Diagnostics never change hook behavior: any failure
 * here is swallowed.
 */
export function recordToolLatencyStart(runtime: FlowGuardPluginRuntime, input: unknown): void {
  try {
    const key = toolLatencyKey(input);
    if (!isLatencyKey(key)) return;
    runtime.toolLatencyStarts.delete(key);
    if (runtime.toolLatencyStarts.size >= LATENCY_REGISTRY_LIMIT) {
      const oldest = runtime.toolLatencyStarts.keys().next();
      if (oldest.done !== true) runtime.toolLatencyStarts.delete(oldest.value);
    }
    runtime.toolLatencyStarts.set(key, performance.now());
  } catch {
    // Diagnostic-only: a failed latency start must never affect the tool call.
  }
}

/**
 * Consume the latency start for this exact call: the elapsed time from the end
 * of the FlowGuard before-hook to the entry of the after-hook (host execution
 * plus host overhead, NOT pure tool time). An absent start is reported as
 * unavailable, never as a zero duration.
 */
export function consumeToolLatency(
  runtime: FlowGuardPluginRuntime,
  input: unknown,
): ToolLatencyObservation {
  const key = toolLatencyKey(input);
  if (!isLatencyKey(key)) return { durationUnavailable: key as ToolLatencyUnavailable };
  const start = runtime.toolLatencyStarts.get(key);
  runtime.toolLatencyStarts.delete(key);
  if (start === undefined) return { durationUnavailable: 'start_not_observed' };
  const elapsed = performance.now() - start;
  return Number.isFinite(elapsed) && elapsed >= 0
    ? { beforeToAfterMs: Number(elapsed.toFixed(3)) }
    : { durationUnavailable: 'start_not_observed' };
}

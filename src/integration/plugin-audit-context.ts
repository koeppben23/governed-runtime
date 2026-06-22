/**
 * @module integration/plugin-audit-context
 * @description Audit context resolution — read-only. Resolves the session,
 *              policy, chain state, and NTP timestamp context needed for
 *              audit event emission.
 *
 * Extracted from plugin-audit.ts. Imports no sibling modules — leaf.
 *
 * @version v1
 */

import type { SessionState, Phase, Event } from '../state/schema.js';
import { parseToolResult } from './plugin-helpers.js';
import { checkNtpClock, type NtpCheckResult } from '../audit/ntp-check.js';
import type { TimestampAssurancePolicy } from '../config/policy-types.js';

/** Subset of plugin-audit AuditDeps needed for context resolution. */
interface AuditContextDeps {
  resolveFingerprint(): Promise<string | null>;
  getSessionDir(sessionId: string): string | null;
  resolveSessionPolicy(sessDir: string): Promise<{
    policy: {
      audit: {
        emitToolCalls: boolean;
        emitTransitions: boolean;
        enableChainHash: boolean;
        timestampAssurance?: TimestampAssurancePolicy;
      };
      actorClassification: Record<string, string>;
      mode: string;
      requireHumanGates: boolean;
    };
    state: SessionState | null;
  }>;
  initChain(sessDir: string | null, sessionId: string): Promise<string>;
  invalidateChainState(sessionId: string): void;
  log: {
    debug(service: string, message: string, extra?: Record<string, unknown>): void;
  };
}

// ─── Internal types ───────────────────────────────────────────────────────────

export interface AuditContext {
  sessDir: string;
  emitToolCalls: boolean;
  emitTransitions: boolean;
  enableChainHash: boolean;
  actor: string;
  now: string;
  prevHash: string;
  phase: string;
  transitions: Array<{ from: Phase; to: Phase; event: Event; at: string }>;
  success: boolean;
  errorMessage: string | undefined;
  parsed: ReturnType<typeof parseToolResult>;
  timestampAssurance: TimestampAssurancePolicy;
  ntpResult?: NtpCheckResult;
}

// ─── Context Resolution ──────────────────────────────────────────────────────

export async function resolveAuditContext(
  deps: AuditContextDeps,
  toolName: string,
  output: unknown,
  sessionId: string,
): Promise<AuditContextResolution | null> {
  await deps.resolveFingerprint();
  const sessDir = deps.getSessionDir(sessionId);
  if (!sessDir) return null;

  const { policy, state } = await deps.resolveSessionPolicy(sessDir);
  const { emitToolCalls, emitTransitions, enableChainHash } = policy.audit;
  const effectiveMode = policy.mode;

  deps.log.debug('audit', 'processing tool call', {
    tool: toolName,
    emitToolCalls,
    emitTransitions,
    enableChainHash,
  });

  const actor = policy.actorClassification[toolName] ?? 'system';
  const now = new Date().toISOString();

  if (state?.archiveStatus) deps.invalidateChainState(sessionId);
  const prevHash = await deps.initChain(sessDir, sessionId);
  const parsedOutput = parseAuditOutput(output);
  const resolvedTsa = resolveTimestampAssurancePolicy(policy.audit.timestampAssurance);
  const ntpResult = await resolveAuditNtpResult(resolvedTsa);

  return {
    ctx: {
      sessDir,
      emitToolCalls,
      emitTransitions,
      enableChainHash,
      actor,
      now,
      prevHash,
      phase: parsedOutput.phase,
      transitions: parsedOutput.transitions,
      success: parsedOutput.success,
      errorMessage: parsedOutput.errorMessage,
      parsed: parsedOutput.parsed,
      timestampAssurance: resolvedTsa,
      ntpResult,
    },
    policy,
    state,
    policyResolved: true,
    effectiveMode,
  };
}

export interface AuditContextResolution {
  ctx: AuditContext;
  policy: {
    audit: { emitToolCalls: boolean; emitTransitions: boolean; enableChainHash: boolean };
    actorClassification: Record<string, string>;
    mode: string;
    requireHumanGates: boolean;
  };
  state: SessionState | null;
  policyResolved: boolean;
  effectiveMode: string;
}

// ─── Private Helpers ──────────────────────────────────────────────────────────

function parseAuditOutput(
  output: unknown,
): Pick<AuditContext, 'phase' | 'transitions' | 'success' | 'errorMessage' | 'parsed'> {
  const parsed = parseToolResult(extractToolOutputValue(output));
  const metadataTransitions = extractMetadataTransitions(output);
  return {
    phase: typeof parsed?.phase === 'string' ? parsed.phase : 'unknown',
    transitions:
      metadataTransitions.length > 0 ? metadataTransitions : extractParsedTransitions(parsed),
    success: parsed?.error !== true,
    errorMessage: typeof parsed?.errorMessage === 'string' ? parsed.errorMessage : undefined,
    parsed,
  };
}

function extractToolOutputValue(output: unknown): unknown {
  return typeof output === 'object' && output !== null && 'output' in output
    ? (output as { output?: unknown }).output
    : output;
}

function extractMetadataTransitions(output: unknown): AuditContext['transitions'] {
  const metadata =
    typeof output === 'object' && output !== null
      ? ((output as Record<string, unknown>).metadata as Record<string, unknown> | undefined)
      : undefined;
  return Array.isArray(metadata?.transitions)
    ? (metadata.transitions as AuditContext['transitions'])
    : [];
}

function extractParsedTransitions(
  parsed: ReturnType<typeof parseToolResult>,
): AuditContext['transitions'] {
  const rawTransitions = (parsed?._audit as { transitions?: unknown } | undefined)?.transitions;
  return Array.isArray(rawTransitions) ? (rawTransitions as AuditContext['transitions']) : [];
}

function resolveTimestampAssurancePolicy(
  configured: TimestampAssurancePolicy | undefined,
): TimestampAssurancePolicy {
  return (
    configured ?? {
      enabled: false,
      mode: 'local_only' as const,
      strict: false,
      criticalEvents: [],
      ntpDriftThresholdMs: 30000,
      tsaTimeoutMs: 10000,
    }
  );
}

async function resolveAuditNtpResult(
  policy: TimestampAssurancePolicy,
): Promise<NtpCheckResult | undefined> {
  return policy.enabled && policy.mode !== 'local_only'
    ? checkNtpClock(policy.ntpServers, policy.tsaTimeoutMs, policy.ntpDriftThresholdMs)
    : undefined;
}

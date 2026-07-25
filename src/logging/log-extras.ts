/**
 * @module logging/log-extras
 * @description Typed log helper functions per service domain.
 *
 * These are optional compile-time wrappers around FlowGuardLogger.
 * They provide type-checked extra fields for common services without
 * changing the FlowGuardLogger interface. Use them for new log calls;
 * existing calls continue to work with the raw logger.
 *
 * No Index-signature — each interface is intentionally narrow to
 * prevent accidental leakage of sensitive data into log extras.
 *
 * @version v1
 */

import type { FlowGuardLogger } from './logger.js';
import type { SerializedError } from './error-serialize.js';

// ── Audit ────────────────────────────────────────────────────────────────

export interface AuditLogExtra {
  tool?: string;
  phase?: string;
  error?: SerializedError;
  prevHashPrefix?: string;
  nextHashPrefix?: string;
}

export function logAudit(
  log: FlowGuardLogger,
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  extra?: AuditLogExtra,
): void {
  log[level]('audit', message, extra as Record<string, unknown> | undefined);
}

// ── Enforcement ───────────────────────────────────────────────────────────

export interface EnforcementLogExtra {
  tool?: string;
  code?: string;
  subagentType?: string;
  phase?: string;
  allowed?: boolean;
}

export function logEnforcement(
  log: FlowGuardLogger,
  level: 'warn' | 'error',
  message: string,
  extra?: EnforcementLogExtra,
): void {
  log[level]('enforcement', message, extra as Record<string, unknown> | undefined);
}

/** Debug-level enforcement diagnostics (e.g. gate evaluation). */
export function logEnforcementDebug(
  log: FlowGuardLogger,
  message: string,
  extra?: EnforcementLogExtra,
): void {
  log.debug('enforcement', message, extra as Record<string, unknown> | undefined);
}

// ── Hook ──────────────────────────────────────────────────────────────────

export interface HookLogExtra {
  tool: string;
}

export function logHook(log: FlowGuardLogger, message: string, extra: HookLogExtra): void {
  log.info('hook', message, extra as unknown as Record<string, unknown>);
}

// ── Orchestrator ──────────────────────────────────────────────────────────

export interface OrchestratorLogExtra {
  tool?: string;
  step?: string;
  iteration?: number;
  error?: SerializedError;
  /** Parent session that owns the spawned reviewer child session. */
  parentSessionId?: string;
  /** Spawned reviewer child session id, for parent→child correlation. */
  childSessionId?: string;
  /** Wall-clock duration of the instrumented step in milliseconds. */
  durationMs?: number;
  /** Structured reason/outcome code for the step (diagnostic only). */
  code?: string;
}

export function logOrchestrator(
  log: FlowGuardLogger,
  level: 'debug' | 'info' | 'warn',
  message: string,
  extra?: OrchestratorLogExtra,
): void {
  log[level]('orchestrator', message, extra as Record<string, unknown> | undefined);
}

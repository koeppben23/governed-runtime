/**
 * @module integration/plugin-risk
 * @description Risk classification enforcement extracted from plugin.ts (FG-REL-045).
 *
 * @version v1
 */

import type { SessionAuthorityResolution } from '../adapters/session-authority.js';
import type { SessionState } from '../state/schema.js';
import { PersistenceError, readState } from '../adapters/persistence.js';
import { changedFiles } from '../adapters/git.js';
import { strictBlockedOutput, buildEnforcementError } from './blocked-result.js';

import {
  enforceTicketDeclarationGate,
  isRiskClassificationAllowed,
  ticketDeclarationGate,
  type DeniedRiskClassificationDecision,
  type RiskClassificationDecision,
} from './phase-tool-gate.js';
import {
  extractPathsFromBashCommand,
  isBashScopeProvablyKnown,
  isPatchScopeProvablyKnown,
  targetPathsForRisk,
} from './risk-path-extraction.js';
import { appendReviewAuditEvent } from './review/evidence/audit-events.js';
import { mutateStateWithAuditOperations } from './audit-outbox.js';

export {
  extractPathsFromBashCommand,
  extractPathsFromPatch,
  isBashScopeProvablyKnown,
  isPatchScopeProvablyKnown,
  targetPathsForRisk,
} from './risk-path-extraction.js';

// ─── Mutation scope ──────────────────────────────────────────────────────────

/**
 * Whether the mutation's target scope cannot be resolved before execution.
 * Unknown scope is never interpreted as low risk: the provisional class is
 * floored at STANDARD by the risk authority.
 */
function riskScopeUnknown(toolName: string, args: Record<string, unknown>): boolean {
  if (toolName === 'write' || toolName === 'edit') return typeof args.filePath !== 'string';
  if (toolName === 'apply_patch') {
    const patch = typeof args.patchText === 'string' ? args.patchText : args.diff;
    if (typeof patch !== 'string') return true;
    return !isPatchScopeProvablyKnown(patch);
  }
  if (toolName === 'bash') {
    if (typeof args.command !== 'string') return true;
    if (!isBashScopeProvablyKnown(args.command)) return true;
    return extractPathsFromBashCommand(args.command).length === 0;
  }
  return true;
}

export interface RiskEnforcementDeps {
  resolveSessionAuthority(sessionId: string): Promise<SessionAuthorityResolution>;
  getWorktreeRoot(): string | undefined;
}

export async function currentChangedFilesForRisk(
  getWorktreeRoot: () => string | undefined,
): Promise<string[]> {
  const auditWorktree = getWorktreeRoot();
  if (!auditWorktree) {
    throw buildEnforcementError(
      'RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE',
      'Cannot verify risk classification because the worktree is unavailable.',
    );
  }
  try {
    return await changedFiles(auditWorktree);
  } catch (err) {
    throw buildEnforcementError(
      'RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE',
      `Cannot verify risk classification evidence: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function evidenceUnavailableRiskDecision(
  state: SessionState,
  reason: string,
): DeniedRiskClassificationDecision {
  return {
    allowed: false,
    code: 'RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE',
    reason,
    decisionId: `RISK-${new Date().toISOString().replace(/[^0-9]/g, '')}-evidence-unavailable`,
    minimumTaskClass: 'HIGH-RISK',
    effectiveTaskClass: 'HIGH-RISK',
    declaredTaskClass: null,
    declarationKind: state.ticket?.riskDeclaration.kind ?? 'absent',
    ticketDigest: state.ticket?.digest ?? null,
    ...(state.claimedTaskClass !== undefined ? { escalatedTaskClass: state.claimedTaskClass } : {}),
    provisional: state.implementation === null,
    unknownScope: true,
    touchedSurfaces: ['risk-classification-evidence'],
    riskTriggers: ['ceremony_only'],
    changedFiles: [],
  };
}

function isTicketDeclarationCode(code: string): boolean {
  return code.startsWith('TICKET_RISK_DECLARATION_');
}

export async function persistRiskDecisionBlock(
  sessDir: string,
  decision: DeniedRiskClassificationDecision,
  code: string,
  message: string,
): Promise<void> {
  const blockedAt = new Date().toISOString();
  const updated = await mutateStateWithAuditOperations(sessDir, (current) => {
    if (current.riskGate?.status === 'blocked') return { next: current };
    const next: SessionState = {
      ...current,
      riskGate: {
        status: 'blocked',
        code,
        message,
        blockedAt,
        lastDecisionId: decision.decisionId,
      },
    };
    return {
      next,
      semanticIntents: [
        {
          phase: next.phase,
          event: 'risk:classification_checked',
          occurredAt: blockedAt,
          detail: riskDecisionAuditDetail(next, decision, 'blocked', code),
        },
      ],
    };
  });
  if (updated === null) {
    throw new PersistenceError('READ_FAILED', `no persisted session state at ${sessDir}`);
  }
}

export async function appendRiskDecisionAudit(
  sessDir: string,
  state: SessionState,
  decision: RiskClassificationDecision,
  result: 'allowed' | 'blocked',
  reasonCode: string,
): Promise<void> {
  await appendReviewAuditEvent(
    sessDir,
    state.binding.hostSessionId,
    state.phase,
    'risk:classification_checked',
    riskDecisionAuditDetail(state, decision, result, reasonCode),
  );
}

function riskDecisionAuditDetail(
  state: SessionState,
  decision: RiskClassificationDecision,
  result: 'allowed' | 'blocked',
  reasonCode: string,
): Record<string, unknown> {
  return {
    decisionId: decision.decisionId,
    decision: result,
    reasonCode,
    minimumTaskClass: decision.minimumTaskClass,
    effectiveTaskClass: decision.effectiveTaskClass,
    declaredTaskClass: decision.declaredTaskClass,
    declarationKind: decision.declarationKind,
    ticketDigest: decision.ticketDigest,
    escalatedTaskClass: decision.escalatedTaskClass ?? null,
    provisional: decision.provisional,
    unknownScope: decision.unknownScope,
    touchedSurfaces: decision.touchedSurfaces,
    changedFilesSummary: decision.changedFiles,
    policyMode: state.policySnapshot.mode,
    enforceRiskClassification: state.policySnapshot.enforceRiskClassification,
    riskGateStatus: result === 'blocked' ? 'blocked' : (state.riskGate?.status ?? 'clear'),
  };
}

function throwRiskBlocked(
  decision: DeniedRiskClassificationDecision,
  state: SessionState,
  toolName: string,
): never {
  const { code, reason } = decision;
  throw buildEnforcementError(code, reason, {
    sessionId: state.binding.hostSessionId,
    tool: toolName,
    effectiveTaskClass: decision.effectiveTaskClass,
    minimumTaskClass: decision.minimumTaskClass,
    declaredTaskClass: decision.declaredTaskClass ?? 'none',
    touchedSurface: decision.touchedSurfaces[0] ?? 'none',
    decisionId: decision.decisionId,
  });
}

async function persistAndThrowRiskBlock(
  sessDir: string,
  state: SessionState,
  decision: DeniedRiskClassificationDecision,
  toolName: string,
): Promise<never> {
  const { code, reason } = decision;
  if (isTicketDeclarationCode(code)) {
    try {
      await appendRiskDecisionAudit(sessDir, state, decision, 'blocked', code);
    } catch (err) {
      throw buildEnforcementError(
        'AUDIT_PERSISTENCE_FAILED',
        err instanceof Error ? err.message : String(err),
      );
    }
    throwRiskBlocked(decision, state, toolName);
  }
  if (state.riskGate?.status !== 'blocked') {
    try {
      await persistRiskDecisionBlock(sessDir, decision, code, reason);
    } catch (err) {
      throw buildEnforcementError(
        'AUDIT_PERSISTENCE_FAILED',
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  throwRiskBlocked(decision, state, toolName);
}

export async function enforceRiskClassificationBefore(
  deps: RiskEnforcementDeps,
  sessDir: string,
  state: SessionState,
  toolName: string,
  args: Record<string, unknown>,
): Promise<void> {
  // Ticket-declaration gate: pre-execution, independent of the risk-enforcement
  // policy flag. An invalid or inconsistent declaration blocks every
  // risk-relevant mutation before it runs; re-capturing the ticket clears it.
  await enforceTicketDeclarationGate(sessDir, state, toolName);

  if (state.policySnapshot.enforceRiskClassification !== true) return;
  let files: string[];
  try {
    files = await currentChangedFilesForRisk(() => deps.getWorktreeRoot());
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const decision = evidenceUnavailableRiskDecision(state, reason);
    if (state.riskGate?.status !== 'blocked') {
      try {
        await persistRiskDecisionBlock(
          sessDir,
          decision,
          'RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE',
          reason,
        );
      } catch (persistErr) {
        throw buildEnforcementError(
          'AUDIT_PERSISTENCE_FAILED',
          persistErr instanceof Error ? persistErr.message : String(persistErr),
        );
      }
    }
    throwRiskBlocked(decision, state, toolName);
  }
  const decision = isRiskClassificationAllowed({
    state,
    changedFiles: files,
    targetPaths: targetPathsForRisk(toolName, args, () => deps.getWorktreeRoot()),
    mode: 'provisional',
    unknownScope: riskScopeUnknown(toolName, args),
    now: new Date().toISOString(),
  });
  if (decision.allowed) {
    try {
      await appendRiskDecisionAudit(
        sessDir,
        state,
        decision,
        'allowed',
        'RISK_CLASSIFICATION_ALLOWED',
      );
    } catch (err) {
      throw buildEnforcementError(
        'AUDIT_PERSISTENCE_FAILED',
        err instanceof Error ? err.message : String(err),
      );
    }
    return;
  }
  await persistAndThrowRiskBlock(sessDir, state, decision, toolName);
}

async function handleEvidenceUnavailableBash(
  sessDir: string,
  state: SessionState,
  reason: string,
  output: { output?: unknown },
): Promise<void> {
  const decision = evidenceUnavailableRiskDecision(state, reason);
  try {
    if (state.riskGate?.status !== 'blocked') {
      await persistRiskDecisionBlock(
        sessDir,
        decision,
        'RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE',
        reason,
      );
    }
  } catch (persistErr) {
    output.output = strictBlockedOutput('AUDIT_PERSISTENCE_FAILED', {
      reason: persistErr instanceof Error ? persistErr.message : String(persistErr),
    });
    return;
  }
  output.output = strictBlockedOutput('RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE', { reason });
}

export async function enforceRiskClassificationAfterBash(
  deps: RiskEnforcementDeps,
  sessionId: string,
  output: { output?: unknown },
): Promise<void> {
  const resolution = await deps.resolveSessionAuthority(sessionId);
  if (resolution.status !== 'resolved') {
    // A bash call is governed by the Before-hook boundary, which requires a
    // resolvable FlowGuard session. Lost context after release is an invariant
    // violation, so it fails closed instead of silently skipping the gate.
    output.output = strictBlockedOutput('PLUGIN_ENFORCEMENT_UNAVAILABLE', {
      reason:
        'Post-bash risk classification has no resolvable FlowGuard session context for a governed mutation.',
      ...(resolution.status === 'unavailable' ? { causeCode: resolution.code } : {}),
    });
    return;
  }
  const sessDir = resolution.sessDir;
  const stateResult = await readRiskStateForBash(sessDir, output);
  if (stateResult.kind === 'unavailable') return;
  if (stateResult.kind === 'missing') {
    output.output = strictBlockedOutput('PLUGIN_ENFORCEMENT_UNAVAILABLE', {
      reason:
        'Post-bash risk classification found no persisted session state for an authorized mutation.',
    });
    return;
  }
  const state = stateResult.state;
  const declarationBlockedOutput = ticketDeclarationBlockedOutput(state, sessionId);
  if (declarationBlockedOutput !== null) {
    output.output = declarationBlockedOutput;
    return;
  }
  if (state.policySnapshot.enforceRiskClassification !== true) return;
  const files = await readRiskChangedFilesForBash(deps, sessDir, state, output);
  if (!files) return;
  const decision = isRiskClassificationAllowed({
    state,
    changedFiles: files,
    mode: 'final',
    now: new Date().toISOString(),
  });
  if (decision.allowed) return appendAllowedRiskDecisionForBash(sessDir, state, decision, output);
  await blockRiskDecisionAfterBash(sessDir, state, decision, sessionId, output);
}

type RiskStateResolution =
  | { readonly kind: 'state'; readonly state: SessionState }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unavailable' };

async function readRiskStateForBash(
  sessDir: string,
  output: { output?: unknown },
): Promise<RiskStateResolution> {
  try {
    const state = await readState(sessDir);
    return state ? { kind: 'state', state } : { kind: 'missing' };
  } catch (err) {
    output.output = strictBlockedOutput('RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE', {
      reason: err instanceof Error ? err.message : String(err),
    });
    return { kind: 'unavailable' };
  }
}

async function readRiskChangedFilesForBash(
  deps: RiskEnforcementDeps,
  sessDir: string,
  state: SessionState,
  output: { output?: unknown },
): Promise<string[] | null> {
  try {
    return await currentChangedFilesForRisk(() => deps.getWorktreeRoot());
  } catch (err) {
    await handleEvidenceUnavailableBash(
      sessDir,
      state,
      err instanceof Error ? err.message : String(err),
      output,
    );
    return null;
  }
}

async function appendAllowedRiskDecisionForBash(
  sessDir: string,
  state: SessionState,
  decision: ReturnType<typeof isRiskClassificationAllowed>,
  output: { output?: unknown },
): Promise<void> {
  try {
    await appendRiskDecisionAudit(
      sessDir,
      state,
      decision,
      'allowed',
      'RISK_CLASSIFICATION_ALLOWED',
    );
  } catch (err) {
    output.output = strictBlockedOutput('AUDIT_PERSISTENCE_FAILED', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

function ticketDeclarationBlockedOutput(
  state: SessionState,
  sessionId: string,
): ReturnType<typeof strictBlockedOutput> | null {
  const gate = ticketDeclarationGate(state);
  if (gate.status !== 'blocked') return null;
  return strictBlockedOutput(gate.code, {
    reason: gate.reason,
    sessionId,
    ticketDigest: state.ticket?.digest ?? 'none',
    declarationKind: state.ticket?.riskDeclaration.kind ?? 'absent',
  });
}

async function blockRiskDecisionAfterBash(
  sessDir: string,
  state: SessionState,
  decision: DeniedRiskClassificationDecision,
  sessionId: string,
  output: { output?: unknown },
): Promise<void> {
  const { code, reason } = decision;
  if (isTicketDeclarationCode(code)) {
    try {
      await appendRiskDecisionAudit(sessDir, state, decision, 'blocked', code);
    } catch (err) {
      output.output = strictBlockedOutput('AUDIT_PERSISTENCE_FAILED', {
        reason: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    output.output = strictBlockedOutput(code, {
      reason,
      sessionId,
      effectiveTaskClass: decision.effectiveTaskClass,
      declaredTaskClass: decision.declaredTaskClass ?? 'none',
      ticketDigest: decision.ticketDigest ?? 'none',
      decisionId: decision.decisionId,
    });
    return;
  }
  try {
    if (state.riskGate?.status !== 'blocked')
      await persistRiskDecisionBlock(sessDir, decision, code, reason);
    output.output = strictBlockedOutput(code, {
      reason,
      sessionId,
      effectiveTaskClass: decision.effectiveTaskClass,
      minimumTaskClass: decision.minimumTaskClass,
      declaredTaskClass: decision.declaredTaskClass ?? 'none',
      touchedSurface: decision.touchedSurfaces[0] ?? 'none',
      decisionId: decision.decisionId,
    });
  } catch (err) {
    output.output = strictBlockedOutput('AUDIT_PERSISTENCE_FAILED', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

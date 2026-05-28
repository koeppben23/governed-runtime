/**
 * @module integration/plugin-risk
 * @description Risk classification enforcement extracted from plugin.ts (FG-REL-045).
 *
 * @version v1
 */

import * as path from 'node:path';
import { existsSync } from 'node:fs';

import type { SessionState } from '../state/schema.js';
import { writeState, readState } from '../adapters/persistence.js';
import { changedFiles } from '../adapters/git.js';
import { strictBlockedOutput, buildEnforcementError } from './plugin-helpers.js';
import { isRiskClassificationAllowed, type RiskClassificationDecision } from './phase-tool-gate.js';
import { appendReviewAuditEvent } from './review/audit-events.js';

export interface RiskEnforcementDeps {
  getSessionDir(sessionId: string): string | null;
  getWorktreeRoot(): string | undefined;
}

export function targetPathsForRisk(
  toolName: string,
  args: Record<string, unknown>,
  getWorktreeRoot: () => string | undefined,
): string[] {
  if ((toolName === 'write' || toolName === 'edit') && typeof args.filePath === 'string') {
    return [resolveRelativePath(args.filePath, getWorktreeRoot)];
  }
  if (toolName === 'apply_patch' && typeof args.diff === 'string') {
    return extractPathsFromPatch(args.diff);
  }
  if (toolName === 'bash' && typeof args.command === 'string') {
    return extractPathsFromBashCommand(args.command);
  }
  return [];
}

// ─── Path Resolution Helper ──────────────────────────────────────────────────

function resolveRelativePath(filePath: string, getWorktreeRoot: () => string | undefined): string {
  const worktreeRoot = getWorktreeRoot() ? path.resolve(getWorktreeRoot()!) : null;
  const resolved = path.resolve(filePath);
  if (worktreeRoot && resolved.startsWith(`${worktreeRoot}${path.sep}`)) {
    // Normalize to forward slashes for platform-independent audit output.
    return path.relative(worktreeRoot, resolved).replace(/\\/g, '/');
  }
  return filePath;
}

// ─── apply_patch Path Extraction ─────────────────────────────────────────────

/**
 * Extract target file paths from a unified diff string.
 * Parses `--- a/path` and `+++ b/path` headers, filters `/dev/null`.
 *
 * @internal
 */
export function extractPathsFromPatch(diff: string): string[] {
  const paths = new Set<string>();

  // Guard against excessive input that could cause ReDoS.
  if (diff.length > 1024 * 1024) return [];

  const headerPattern = /^(?:---|\+\+\+)[ \t]+(?:[ab]\/)?([^\n\r]+)$/gm;
  let match: RegExpExecArray | null;

  while ((match = headerPattern.exec(diff)) !== null) {
    const filePath = (match[1] ?? '').trim();
    if (filePath && filePath !== '/dev/null' && filePath !== 'dev/null') {
      // Normalize slashes for platform-independent output.
      paths.add(filePath.replace(/\\/g, '/'));
    }
  }

  return [...paths];
}

// ─── bash Command Path Extraction ────────────────────────────────────────────

/**
 * Best-effort extraction of file paths from bash command strings.
 * Handles common patterns: redirects, tee, rm, mv, cp, sed -i, chmod, git checkout --.
 *
 * Returns [] for unparseable commands (fail-safe: unknown ≠ "no risk").
 *
 * @internal
 */
export function extractPathsFromBashCommand(cmd: string): string[] {
  // Guard against excessive input that could cause ReDoS.
  if (cmd.length > 1024 * 1024) return [];

  const paths = new Set<string>();

  // 1. Redirect targets: >, >>, 2>, 2>>
  const redirectPattern = /(?:^|[^<])(?:2?>?>|>)\s*["']?([^\s"'|;&><]+)["']?/g;
  let match: RegExpExecArray | null;
  while ((match = redirectPattern.exec(cmd)) !== null) {
    const target = match[1] ?? '';
    if (target && !target.startsWith('/dev/')) {
      paths.add(target);
    }
  }

  // 2. tee targets: | tee [-a] <file>
  const teePattern = /\|\s*tee\s+(?:-a\s+)?["']?([^\s"'|;&><]+)["']?/g;
  while ((match = teePattern.exec(cmd)) !== null) {
    const target = match[1] ?? '';
    if (target) paths.add(target);
  }

  // 3. rm targets: rm [-rf] <files...>
  const rmPattern = /\brm\s+(?:-[rRfiv]+\s+)*([^\n;&|]+)/g;
  while ((match = rmPattern.exec(cmd)) !== null) {
    const argStr = (match[1] ?? '').trim();
    for (const arg of splitUnquotedArgs(argStr)) {
      if (!arg.startsWith('-')) paths.add(arg);
    }
  }

  // 4. mv/cp targets: mv/cp <src...> <dest>
  const mvCpPattern = /\b(?:mv|cp)\s+(?:-[a-zA-Z]+\s+)*([^\n;&|]+)/g;
  while ((match = mvCpPattern.exec(cmd)) !== null) {
    const argStr = (match[1] ?? '').trim();
    const args = splitUnquotedArgs(argStr);
    // All paths are potentially affected (source and destination)
    for (const arg of args) {
      if (!arg.startsWith('-')) paths.add(arg);
    }
  }

  // 5. sed -i: sed -i[suffix] <expr> <file...>
  const sedPattern = /\bsed\s+(?:-[^i\s]*)?-i[^\s]*\s+(?:'[^']*'|"[^"]*"|[^\s]+)\s+([^\n;&|]+)/g;
  while ((match = sedPattern.exec(cmd)) !== null) {
    const argStr = (match[1] ?? '').trim();
    for (const arg of splitUnquotedArgs(argStr)) {
      if (!arg.startsWith('-')) paths.add(arg);
    }
  }

  // 6. chmod: chmod <mode> <file...>
  const chmodPattern =
    /\bchmod\s+(?:-[Rfvch]\s+)*(?:[0-7]{3,4}|[ugoa]?[+\-=/][rwxXst]+)\s+([^\n;&|]+)/g;
  while ((match = chmodPattern.exec(cmd)) !== null) {
    const argStr = (match[1] ?? '').trim();
    for (const arg of splitUnquotedArgs(argStr)) {
      if (!arg.startsWith('-')) paths.add(arg);
    }
  }

  // 7. git checkout -- <file...>
  const gitCheckoutPattern = /\bgit\s+checkout\s+(?:[^\s]+\s+)?--\s+([^\s;&|]+)/g;
  while ((match = gitCheckoutPattern.exec(cmd)) !== null) {
    const argStr = (match[1] ?? '').trim();
    for (const arg of splitUnquotedArgs(argStr)) {
      if (!arg.startsWith('-')) paths.add(arg);
    }
  }

  return [...paths].map((p) => p.replace(/\\/g, '/'));
}

/**
 * Split a string into arguments, respecting single/double quotes.
 * @internal
 */
function splitUnquotedArgs(input: string): string[] {
  const args: string[] = [];
  const pattern = /(?:"([^"]*)")|(?:'([^']*)')|([^\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(input)) !== null) {
    const arg = m[1] ?? m[2] ?? m[3] ?? '';
    if (arg) args.push(arg);
  }
  return args;
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
): RiskClassificationDecision {
  return {
    allowed: false,
    code: 'RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE',
    reason,
    decisionId: `RISK-${new Date().toISOString().replace(/[^0-9]/g, '')}-evidence-unavailable`,
    claimedTaskClass: state.claimedTaskClass,
    minimumTaskClass: 'HIGH-RISK',
    touchedSurfaces: ['risk-classification-evidence'],
    changedFiles: [],
  };
}

export async function persistRiskDecisionBlock(
  sessDir: string,
  state: SessionState,
  decision: RiskClassificationDecision,
  code: string,
  message: string,
): Promise<void> {
  const blockedAt = new Date().toISOString();
  const nextState: SessionState = {
    ...state,
    riskGate: {
      status: 'blocked',
      code,
      message,
      blockedAt,
      lastDecisionId: decision.decisionId,
    },
  };
  await writeState(sessDir, nextState);
  await appendRiskDecisionAudit(sessDir, state, decision, 'blocked', code);
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
    state.binding.sessionId,
    state.phase,
    'risk:classification_checked',
    {
      decisionId: decision.decisionId,
      decision: result,
      reasonCode,
      claimedTaskClass: decision.claimedTaskClass ?? null,
      minimumTaskClass: decision.minimumTaskClass,
      touchedSurfaces: decision.touchedSurfaces,
      changedFilesSummary: decision.changedFiles,
      policyMode: state.policySnapshot.mode,
      enforceRiskClassification: state.policySnapshot.enforceRiskClassification,
      allowRiskDowngradeOverride: state.policySnapshot.allowRiskDowngradeOverride,
      riskGateStatus: result === 'blocked' ? 'blocked' : (state.riskGate?.status ?? 'clear'),
    },
  );
}

export async function enforceRiskClassificationBefore(
  deps: RiskEnforcementDeps,
  sessDir: string,
  state: SessionState,
  toolName: string,
  args: Record<string, unknown>,
): Promise<void> {
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
          state,
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
    throw buildEnforcementError('RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE', reason, {
      sessionId: state.binding.sessionId,
      tool: toolName,
      decisionId: decision.decisionId,
    });
  }
  const decision = isRiskClassificationAllowed({
    state,
    changedFiles: files,
    targetPaths: targetPathsForRisk(toolName, args, () => deps.getWorktreeRoot()),
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
  const code = decision.code ?? 'RISK_CLASSIFICATION_MISMATCH';
  const reason = decision.reason ?? 'Risk classification gate blocked this mutating tool.';
  if (state.riskGate?.status !== 'blocked') {
    try {
      await persistRiskDecisionBlock(sessDir, state, decision, code, reason);
    } catch (err) {
      throw buildEnforcementError(
        'AUDIT_PERSISTENCE_FAILED',
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  throw buildEnforcementError(code, reason, {
    sessionId: state.binding.sessionId,
    tool: toolName,
    claimedTaskClass: decision.claimedTaskClass ?? 'missing',
    minimumTaskClass: decision.minimumTaskClass,
    touchedSurface: decision.touchedSurfaces[0] ?? 'none',
    decisionId: decision.decisionId,
  });
}

export async function enforceRiskClassificationAfterBash(
  deps: RiskEnforcementDeps,
  sessionId: string,
  output: { output?: unknown },
): Promise<void> {
  const sessDir = deps.getSessionDir(sessionId);
  if (!sessDir || !existsSync(sessDir)) return;
  let state: SessionState | null;
  try {
    state = await readState(sessDir);
  } catch (err) {
    output.output = strictBlockedOutput('RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE', {
      reason: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (!state || state.policySnapshot.enforceRiskClassification !== true) return;
  let files: string[];
  try {
    files = await currentChangedFilesForRisk(() => deps.getWorktreeRoot());
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const decision = evidenceUnavailableRiskDecision(state, reason);
    try {
      if (state.riskGate?.status !== 'blocked') {
        await persistRiskDecisionBlock(
          sessDir,
          state,
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
    return;
  }
  const decision = isRiskClassificationAllowed({
    state,
    changedFiles: files,
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
      output.output = strictBlockedOutput('AUDIT_PERSISTENCE_FAILED', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }
  const code = decision.code ?? 'RISK_CLASSIFICATION_MISMATCH';
  const reason = decision.reason ?? 'Risk classification gate blocked after bash mutation.';
  try {
    if (state.riskGate?.status !== 'blocked') {
      await persistRiskDecisionBlock(sessDir, state, decision, code, reason);
    }
    output.output = strictBlockedOutput(code, {
      reason,
      sessionId,
      claimedTaskClass: decision.claimedTaskClass ?? 'missing',
      minimumTaskClass: decision.minimumTaskClass,
      touchedSurface: decision.touchedSurfaces[0] ?? 'none',
      decisionId: decision.decisionId,
    });
  } catch (err) {
    output.output = strictBlockedOutput('AUDIT_PERSISTENCE_FAILED', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * @module integration/services/decision-finalization
 * @description Post-rail finalization for the decision tool.
 *
 * Orchestrates two side effects after executeReviewDecision():
 * 1. MADR artifact writing — when architecture flow completes (ARCH_COMPLETE).
 * 2. Regulated completion — P26 audit emit → archive → verify chain
 *    when EVIDENCE_REVIEW + APPROVE → COMPLETE in regulated mode.
 *
 * Returns the (potentially modified) RailResult for the caller to persist.
 *
 * @version v1
 */

import type { RailResult } from '../../rails/types.js';
import { writeMadrArtifact } from '../artifacts/madr-writer.js';
import { executeRegulatedCompletion } from './regulated-completion.js';

/**
 * Finalize a decision rail result: write MADR artifact if needed,
 * execute regulated completion if applicable.
 *
 * @param sessDir - Session directory path
 * @param fingerprint - Workspace fingerprint
 * @param sessionID - Session identifier
 * @param priorPhase - The phase BEFORE the decision was applied
 * @param verdict - The verdict that was applied ('approve', 'changes_requested', 'reject')
 * @param result - The rail result from executeReviewDecision
 * @returns The (potentially modified) RailResult — caller must persist via persistAndFormat
 */
export async function finalizeDecision(
  sessDir: string,
  fingerprint: string,
  sessionID: string,
  priorPhase: string,
  verdict: string,
  result: RailResult,
): Promise<RailResult> {
  // ── MADR artifact for architecture completion ──
  if (result.kind === 'ok' && result.state.phase === 'ARCH_COMPLETE' && result.state.architecture) {
    await writeMadrArtifact(sessDir, result.state.architecture);
  }

  // ── P26: Regulated clean completion requires archive + verification ──
  // Scope: EVIDENCE_REVIEW + APPROVE → COMPLETE in regulated mode.
  // Pre-condition guard: only triggers for the exact clean completion path.
  // Excludes abort, non-regulated, and future rails that may also produce COMPLETE.
  if (
    result.kind === 'ok' &&
    priorPhase === 'EVIDENCE_REVIEW' &&
    verdict === 'approve' &&
    result.state.phase === 'COMPLETE' &&
    result.state.policySnapshot.mode === 'regulated' &&
    !result.state.error
  ) {
    const finalState = await executeRegulatedCompletion(
      sessDir,
      fingerprint,
      sessionID,
      result.state,
    );
    return { ...result, state: finalState };
  }

  return result;
}

/**
 * @module integration/plugin-compaction
 * @description OpenCode session compaction hook for the FlowGuard plugin.
 *
 * When OpenCode compacts a session (summarizing history to free token budget),
 * critical FlowGuard state context is injected into the compaction summary.
 * This ensures the model retains governance awareness after compaction.
 *
 * @see https://opencode.ai/docs/plugins (experimental.session.compacting)
 * @version v1
 */

import { readState } from '../adapters/persistence.js';
import { PHASE_LABELS } from '../presentation/phase-labels.js';
import { renderCompactionMandatesSummary } from '../templates/mandates-renderer.js';

/**
 * Dependencies for the compaction hook.
 */
export interface CompactionDeps {
  getSessionDir(sessionId: string): string | null;
  log: {
    info(service: string, message: string, extra?: Record<string, unknown>): void;
    warn(service: string, message: string, extra?: Record<string, unknown>): void;
  };
}

/**
 * Build FlowGuard context string for session compaction.
 *
 * Injects minimal but critical governance state so the model knows:
 * - Current workflow phase
 * - Active review obligations (if any)
 * - Policy mode in effect
 *
 * Does NOT inject full state (token budget concern). Only the minimum
 * needed for the model to resume governed behavior after compaction.
 *
 * @returns Context string to append to compaction summary, or null if unavailable.
 */
export async function buildCompactionContext(
  deps: CompactionDeps,
  sessionId: string,
): Promise<string | null> {
  try {
    const sessDir = deps.getSessionDir(sessionId);
    if (!sessDir) return null;

    const state = await readState(sessDir);
    if (!state) return null;

    const phaseLabel = PHASE_LABELS[state.phase] ?? state.phase;
    const mode = state.policySnapshot?.mode ?? 'unknown';
    const obligations = state.reviewAssurance?.obligations ?? [];
    const pendingObligations = obligations.filter(
      (o: { status?: string }) => o.status === 'pending',
    );

    const lines: string[] = [
      '## FlowGuard Governance State (preserved across compaction)',
      '',
      `- **Phase**: ${phaseLabel} (${state.phase})`,
      `- **Policy mode**: ${mode}`,
      `- **Session ID**: ${state.id ?? sessionId}`,
    ];

    if (state.ticket?.text) {
      const ticketPreview =
        state.ticket.text.length > 200
          ? state.ticket.text.slice(0, 200) + '...'
          : state.ticket.text;
      lines.push(`- **Ticket**: ${ticketPreview}`);
    }

    if (pendingObligations.length > 0) {
      lines.push(`- **Pending review obligations**: ${pendingObligations.length}`);
      lines.push('  - WARNING: Do not skip pending reviews. Use FlowGuard tools to complete them.');
    }

    if (state.plan?.current?.body) {
      lines.push('- **Plan**: Active (approved plan exists in session state)');
    }

    const mandatesSummary = renderCompactionMandatesSummary(state.phase);
    if (mandatesSummary) {
      lines.push('');
      lines.push('## FlowGuard Diagnostic Mandates Summary');
      lines.push('');
      lines.push(mandatesSummary);
    }

    lines.push('');
    lines.push(
      'Use `/status` or `flowguard_status` to get full current state and phase-relevant mandates.',
    );
    lines.push(
      'Full mandates render fallback is prompt-safety only; it does not authorize mutating runtime behavior.',
    );

    return lines.join('\n');
  } catch (err) {
    deps.log.warn('compaction', 'failed to build compaction context', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

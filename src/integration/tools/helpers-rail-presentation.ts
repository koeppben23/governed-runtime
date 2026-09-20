/**
 * @module integration/tools/helpers-rail-presentation
 * @description Rail-result formatting and persistence presentation helpers.
 *
 * Extracted from `helpers.ts` along the rail-result presentation boundary:
 * formatting a RailResult for LLM consumption, deriving the user-facing
 * next-action presentation, and persisting + formatting an "ok" RailResult.
 *
 * @version v1
 */

import type { EvalResult } from '../../machine/evaluate.js';
import { resolveWorkflowDirective } from '../../machine/workflow-directive.js';
import { TERMINAL } from '../../machine/topology.js';
import type { RailResult } from '../../rails/types.js';
import { getAdapterLogger, getLogTraceFields } from '../../logging/adapter-logger.js';
import {
  PHASE_LABELS,
  renderMarkdown,
  buildEvidenceApprovalCompletionDocument,
  type FindingRelationPresentation,
  type PresentationConclusion,
  type PresentationDocument,
} from '../../presentation/index.js';
import type { ReviewFindings } from '../../state/evidence.js';
import type { SessionState } from '../../state/schema.js';
import { buildBlockedPresentation } from '../blocked-result.js';
import { buildRailConclusion } from './rail-conclusion.js';
import { projectStatusActionFromCommand } from '../status/status-conclusion.js';
import { getReviewLoopProgress } from '../review/review-loop-progress.js';
import { projectCompletionProofStatus } from '../proofgraph/proof-summary-projectors.js';
import { emitPresentationTelemetry } from './presentation-telemetry.js';
import { headlineFields } from '../blocked-result.js';
import { writeStateWithArtifactsAndAuditOperations, type ToolResult } from './helpers.js';

// ─── Rail-result presentation ─────────────────────────────────────────────────

/**
 * Render the rail-surface Next-Action conclusion to Markdown for display.
 *
 * Builds a conclusion-only compact-card PresentationDocument (no sections) and
 * renders it through the shared renderer, so the mutating-tool next action is
 * displayed identically to /status, /why, and /finish. Additive only — this is
 * the user-facing display; the structured `directive` and `_audit.transitions`
 * remain the machine-readable routing fields.
 */
function buildNextActionPresentation(
  state: SessionState,
  evalResult: EvalResult,
): { markdown: string } {
  const conclusion = buildRailConclusion(state, evalResult);
  const document: PresentationDocument = {
    kind: 'compact_card',
    density: 'compact',
    form: presentationFormForConclusion(conclusion),
    sections: [],
    conclusion,
  };
  const markdown = renderMarkdown(document);
  emitPresentationTelemetry(document, state.phase, state.id);
  return { markdown };
}

function presentationFormForConclusion(
  conclusion: PresentationConclusion,
): 'success' | 'decision' | 'review_pending' | 'terminal' {
  if (conclusion.kind === 'decision_required') return 'decision';
  if (conclusion.kind === 'review_pending') return 'review_pending';
  if (conclusion.kind === 'terminal') return 'terminal';
  return 'success';
}

export interface RailPresentationOptions {
  readonly evidenceApprovalCompletion?: boolean;
}

/** Format a RailResult for LLM consumption. Audit transitions in metadata channel. */
export function formatRailResult(
  result: RailResult,
  options: RailPresentationOptions = {},
): ToolResult {
  if (result.kind === 'blocked') {
    getAdapterLogger().warn('machine', 'tool_blocked', {
      code: result.code,
      ...(result.overflow ? { overflowLimit: result.overflow.limit } : {}),
      ...getLogTraceFields(),
    });
    // Unify the blocked surface with the rest of the presentation layer: when a
    // structured diagnostic is available, also render it through the shared
    // renderer so the display path matches /status, /why, /finish, and /help.
    const blockedPresentation = buildBlockedPresentation(result.code, result.reason, {
      reason: result.reason,
    });
    return JSON.stringify({
      error: true,
      code: result.code,
      message: result.reason,
      recovery: result.recovery,
      quickFix: result.quickFix,
      ...headlineFields(result.code),
      ...blockedPresentation,
      // #428: surface structured overflow context so the plugin boundary can
      // detect and log the fail-closed overflow without parsing the message.
      ...(result.overflow ? { autoAdvanceOverflow: result.overflow } : {}),
    });
  }
  const directive = resolveWorkflowDirective(result.state);
  const aborted = result.state.error?.code === 'ABORTED';
  const reviewDecision = result.state.reviewDecision;
  const archiveStatus = result.state.regulatedArchiveStatus;
  const reviewLoop = getReviewLoopProgress(result.state);
  const presentation = options.evidenceApprovalCompletion
    ? buildEvidenceApprovalCompletionPresentation(result.state)
    : buildNextActionPresentation(result.state, result.evalResult);
  const json = JSON.stringify({
    phase: result.state.phase,
    phaseLabel: PHASE_LABELS[result.state.phase],
    status: 'ok',
    directive,
    // Render the user-facing next action through the shared renderer so mutating
    // tools display it identically to /status, /why, and /finish. The
    // machine-readable `directive` field above is the routing authority.
    presentation,
    // Governance integrity: mark an aborted terminal session explicitly so it is
    // never presented as an indistinguishable clean completion. Distinct from the
    // blocked-result `error: true` convention (this is a successful tool call that
    // reports a terminated session). Omitted for clean states.
    ...(aborted ? { aborted: true } : {}),
    ...(reviewDecision
      ? {
          reviewDecision: {
            verdict: reviewDecision.verdict,
            rationale: reviewDecision.rationale,
            decisionIdentity: reviewDecision.decisionIdentity,
            decidedAt: reviewDecision.decidedAt,
          },
        }
      : {}),
    ...(archiveStatus ? { archiveStatus } : {}),
    ...(reviewLoop ? { reviewLoop } : {}),
  });
  return { output: json, metadata: { transitions: result.transitions } };
}

function buildEvidenceApprovalCompletionPresentation(state: SessionState): { markdown: string } {
  const latestFindings = state.implReviewFindings?.at(-1);
  const document = buildEvidenceApprovalCompletionDocument({
    proofSummary: projectCompletionProofStatus(state),
    exportAction: projectStatusActionFromCommand('/export', 'recommended'),
    ...(latestFindings?.missingVerification !== undefined
      ? { missingVerification: latestFindings.missingVerification }
      : {}),
  });
  const markdown = renderMarkdown(document);
  emitPresentationTelemetry(document, state.phase, state.id);
  return { markdown };
}

type ReviewFindingRelation = ReviewFindings['blockingIssues'][number]['relation'];

export function toPresentationFindingRelation(
  relation: ReviewFindingRelation,
): FindingRelationPresentation {
  return {
    subjectAnchors: relation.subjectAnchors.map((anchor) => {
      if (anchor.kind === 'repository_location') {
        return {
          kind: 'repository_location' as const,
          location: {
            path: anchor.location.path,
            revision: anchor.location.revision,
            ...(anchor.location.line !== undefined ? { line: anchor.location.line } : {}),
            ...(anchor.location.endLine !== undefined ? { endLine: anchor.location.endLine } : {}),
          },
        };
      }
      if (anchor.kind === 'artifact_section') {
        return {
          kind: 'artifact_section' as const,
          artifactKind: anchor.artifactKind,
          sectionPath: anchor.sectionPath.map(({ headingText }) => ({ headingText })),
        };
      }
      if (anchor.kind === 'content') {
        return {
          kind: 'content' as const,
          subjectDigest: anchor.subjectDigest,
          ...(anchor.range !== undefined
            ? {
                range: {
                  startLine: anchor.range.startLine,
                  ...(anchor.range.endLine !== undefined ? { endLine: anchor.range.endLine } : {}),
                },
              }
            : {}),
        };
      }
      return {
        kind: 'implementation' as const,
        implementationDigest: anchor.implementationDigest,
      };
    }),
    evidenceLocations: relation.evidenceLocations.map((location) => ({
      path: location.path,
      revision: location.revision,
      ...(location.line !== undefined ? { line: location.line } : {}),
      ...(location.endLine !== undefined ? { endLine: location.endLine } : {}),
    })),
  };
}

// ─── Persist + format ─────────────────────────────────────────────────────────

/**
 * Persist a RailResult if it's an "ok" result. Returns the formatted JSON.
 * Rails don't persist — the caller (this tool layer) does it atomically.
 */
export async function persistAndFormat(
  sessDir: string,
  result: RailResult,
  options: RailPresentationOptions = {},
): Promise<ToolResult> {
  if (result.kind === 'ok') {
    if (result.transitions.length > 0) {
      getAdapterLogger().info('machine', 'transitions_applied', {
        sessionId: result.state.binding.hostSessionId,
        stateId: result.state.id,
        path: result.transitions.map((t) => `${t.from}\u2192${t.to}`),
        count: result.transitions.length,
        ...getLogTraceFields(),
      });
    }
    await writeStateWithArtifactsAndAuditOperations(sessDir, result.state, result.transitions);
    logPersistedLifecycle(result);
  }
  return formatRailResult(result, options);
}

function logPersistedLifecycle(result: Extract<RailResult, { kind: 'ok' }>): void {
  if (result.transitions.length === 0) return;
  const sessionId = result.state.binding.hostSessionId;
  const phase = result.state.phase;
  const log = getAdapterLogger();

  if (isPersistedAbort(result)) {
    log.info('machine', 'session_aborted', {
      sessionId,
      phase,
      ...getLogTraceFields(),
    });
    return;
  }

  if (TERMINAL.has(phase)) {
    log.info('machine', 'session_completed', {
      sessionId,
      phase,
      ...getLogTraceFields(),
    });
  }
}

function isPersistedAbort(result: Extract<RailResult, { kind: 'ok' }>): boolean {
  return (
    result.state.error?.code === 'ABORTED' && result.transitions.some((t) => t.event === 'ABORT')
  );
}

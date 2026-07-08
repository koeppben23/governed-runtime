/**
 * @module integration/tools/architecture-submit
 * @description Mode A — ADR submission flow.
 *
 * @version v1
 */

import type { ArchitectureArgs, ArchitectureSession } from './architecture-shared.js';
import { buildArchitectureReviewInstruction } from './architecture-shared.js';
import { formatBlocked, appendNextAction, writeStateWithArtifacts } from './helpers.js';
import type { SessionState } from '../../state/schema.js';
import { executeArchitecture } from '../../rails/architecture.js';
import {
  createReviewObligation,
  appendReviewObligation,
  reviewObligationResponseFields,
} from '../review/assurance.js';

// ═══════════════════════════════════════════════════════════════════════════
// Mode A: ADR Submission
// ═══════════════════════════════════════════════════════════════════════════

export async function handleAdrSubmission(
  args: ArchitectureArgs,
  session: ArchitectureSession,
): Promise<string> {
  const { sessDir, state, policy, ctx } = session;
  if (!args.title) return formatBlocked('EMPTY_ADR_TITLE');
  if (!args.adrText) return formatBlocked('EMPTY_ADR_TEXT');

  const result = executeArchitecture(state, { title: args.title, adrText: args.adrText }, ctx);

  if (result.kind === 'blocked') {
    return JSON.stringify({
      error: true,
      code: result.code,
      message: result.reason,
      recovery: result.recovery,
      quickFix: result.quickFix,
    });
  }

  const subagentEnabled = policy.selfReview?.subagentEnabled ?? false;
  const archPlanVersion = 1;
  const nextObligation = subagentEnabled
    ? createReviewObligation({
        obligationType: 'architecture',
        iteration: 0,
        planVersion: archPlanVersion,
        now: ctx.now(),
      })
    : null;
  const augmentedState: SessionState = nextObligation
    ? {
        ...result.state,
        reviewAssurance: appendReviewObligation(result.state.reviewAssurance, nextObligation),
      }
    : result.state;

  await writeStateWithArtifacts(sessDir, augmentedState);

  const instruction = buildArchitectureReviewInstruction({
    policy: session.policy,
    subagentEnabled,
    obligation: nextObligation,
    iteration: 0,
    planVersion: archPlanVersion,
    subjectLabel: 'full ADR text, ADR title, and ticket text',
  });
  const modeAResponse: Record<string, unknown> = {
    phase: augmentedState.phase,
    status: `ADR ${augmentedState.architecture!.id} submitted: ${args.title}`,
    adrId: augmentedState.architecture!.id,
    adrDigest: augmentedState.architecture!.digest,
    selfReviewIteration: 0,
    maxSelfReviewIterations: policy.maxSelfReviewIterations,
    reviewMode: subagentEnabled ? 'subagent' : 'self',
    ...reviewObligationResponseFields(nextObligation),
    next: instruction.next,
    ...(instruction.reviewInvocation ? { reviewInvocation: instruction.reviewInvocation } : {}),
    _audit: { transitions: result.transitions },
  };

  return appendNextAction(JSON.stringify(modeAResponse), augmentedState);
}

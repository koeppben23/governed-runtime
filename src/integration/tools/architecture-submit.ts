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
  resolveFrozenReviewProfile,
} from '../review/assurance.js';
import { readDiscovery } from '../../adapters/persistence-discovery.js';
import { discoveryRiskPaths } from '../discovery-risk-paths.js';

// ═══════════════════════════════════════════════════════════════════════════
// Mode A: ADR Submission
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Challenge classification for an ADR.
 *
 * An ADR carries no diff of its own, so `targetPaths`/branch/PR evidence is not
 * naturally available — the historical resolver returned `unavailable` here and
 * hard-blocked the entire architecture flow whenever a `challengePolicy` was
 * active (team/team-ci/regulated). This derives the classification from canonical
 * session evidence instead and NEVER dead-ends:
 *
 *  - changedFiles = author `targetPaths` (optional override) ∪ the repository's
 *    detected risk surfaces (`discoveryRiskPaths`), a deterministic, persisted
 *    source. The challenge COUNT is then floored by the author's `claimedTaskClass`
 *    inside `createReviewObligation` (max(computed, claimed)).
 *  - When no evidence exists (no targetPaths, no detected surfaces), the set is
 *    empty → TRIVIAL → count 0. That is a genuine "no detected risk" signal, not a
 *    block. In enforced modes the separate risk gate still requires a claim before
 *    the tool runs.
 */
async function resolveArchitectureChallengeClassification(
  state: SessionState,
  wsDir: string,
  subagentEnabled: boolean,
  targetPaths?: string[],
): Promise<{ kind: 'not_required' } | { kind: 'available'; changedFiles: readonly string[] }> {
  if (!subagentEnabled) return { kind: 'not_required' };
  if (!state.policySnapshot?.challengePolicy) return { kind: 'not_required' };
  const discovery = await readDiscovery(wsDir);
  const changedFiles = [...new Set([...(targetPaths ?? []), ...discoveryRiskPaths(discovery)])];
  return { kind: 'available', changedFiles };
}

interface ArchObligationContext {
  readonly state: SessionState;
  readonly wsDir: string;
  readonly subagentEnabled: boolean;
  readonly targetPaths: string[] | undefined;
  readonly archPlanVersion: number;
  readonly now: string;
  readonly policySnapshot: NonNullable<SessionState['policySnapshot']>;
}

async function classifyAndCreateArchObligation(
  ctx: ArchObligationContext,
): Promise<{ state: SessionState; obligation: ReturnType<typeof createReviewObligation> | null }> {
  const classification = await resolveArchitectureChallengeClassification(
    ctx.state,
    ctx.wsDir,
    ctx.subagentEnabled,
    ctx.targetPaths,
  );
  const resolvedTargetPaths =
    classification.kind === 'available' ? [...classification.changedFiles] : undefined;
  const metadata: Record<string, unknown> = {};
  if (resolvedTargetPaths && resolvedTargetPaths.length > 0) {
    metadata.targetPaths = resolvedTargetPaths;
  }
  const obligation = ctx.subagentEnabled
    ? createReviewObligation({
        obligationType: 'architecture',
        iteration: 0,
        planVersion: ctx.archPlanVersion,
        now: ctx.now,
        reviewProfile: resolveFrozenReviewProfile(ctx.policySnapshot),
        profileSource: 'policy_default',
        policySnapshot: ctx.policySnapshot,
        changedFiles: resolvedTargetPaths,
        claimedTaskClass: ctx.state.claimedTaskClass,
        metadata,
      })
    : null;
  const augmentedState = obligation
    ? {
        ...ctx.state,
        reviewAssurance: appendReviewObligation(ctx.state.reviewAssurance, obligation),
      }
    : ctx.state;
  return { state: augmentedState, obligation };
}

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
  const now = ctx.now();
  const classification = await classifyAndCreateArchObligation({
    state: result.state,
    wsDir: session.wsDir,
    subagentEnabled,
    targetPaths: args.targetPaths,
    archPlanVersion,
    now,
    policySnapshot: result.state.policySnapshot,
  });
  const { state: augmentedState, obligation: nextObligation } = classification;

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

/**
 * @module integration/tools/implement-shared
 * @description Shared types and helpers for implement-record and implement-review.
 *
 * @version v1
 */

import type { ToolContext } from './helpers.js';
import { formatBlocked } from './helpers.js';
import type { SessionState } from '../../state/schema.js';
import type { RailContext } from '../../rails/types.js';
import type { FlowGuardPolicy } from '../../config/policy.js';
import type { ReviewFindings } from '../../state/evidence.js';
import type { resolveCeremonyProfile } from '../phase-tool-gate.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Shared Types / Helpers
// ═══════════════════════════════════════════════════════════════════════════════

export function nextImplementationReviewIteration(state: SessionState): number {
  let latest = state.implReview?.iteration ?? 0;
  for (const findings of state.implReviewFindings ?? []) {
    latest = Math.max(latest, findings.iteration);
  }
  return latest + 1;
}

export type ImplementArgs = {
  reviewVerdict?: 'accept' | 'changes_requested';
  reviewFindings?: ReviewFindings;
  reviewerUnavailable?: boolean;
};

export type ImplementRuntime = {
  args: ImplementArgs;
  context: ToolContext;
  worktree: string;
  sessDir: string;
  state: SessionState;
  policy: FlowGuardPolicy;
  ctx: RailContext;
  maxImplReviewIterations: number;
  subagentEnabled: boolean;
  fallbackToSelf: boolean;
  strictEnforcement: boolean;
};

export type ImplementationCeremony = ReturnType<typeof resolveCeremonyProfile>;

export type ImplementFlags = {
  hasVerdict: boolean;
  hasFindings: boolean;
  isRecordImpl: boolean;
};

export function classifyImplementArgs(args: ImplementArgs): ImplementFlags {
  const hasVerdict = typeof args.reviewVerdict === 'string' && args.reviewVerdict.length > 0;
  return {
    hasVerdict,
    hasFindings: args.reviewFindings != null && typeof args.reviewFindings === 'object',
    isRecordImpl: !hasVerdict,
  };
}

export function buildImplementRuntime(input: {
  args: ImplementArgs;
  context: ToolContext;
  worktree: string;
  sessDir: string;
  state: SessionState;
  policy: FlowGuardPolicy;
  ctx: RailContext;
}): ImplementRuntime {
  return {
    ...input,
    maxImplReviewIterations: input.policy.maxImplReviewIterations,
    subagentEnabled: input.policy.selfReview?.subagentEnabled ?? false,
    fallbackToSelf: input.policy.selfReview?.fallbackToSelf ?? false,
    strictEnforcement: input.policy.selfReview?.strictEnforcement ?? false,
  };
}

export function validateImplementSequence(
  args: ImplementArgs,
  state: SessionState,
  hasVerdict: boolean,
  hasFindings: boolean,
): string | null {
  if (hasFindings && !hasVerdict) return formatBlocked('INVALID_IMPLEMENT_TOOL_SEQUENCE');
  if (hasVerdict && !state.implementation) return formatBlocked('IMPLEMENTATION_EVIDENCE_REQUIRED');
  if (hasVerdict && state.phase !== 'IMPL_REVIEW') {
    return formatBlocked('IMPLEMENT_REVIEW_LOOP_REQUIRED', { phase: state.phase });
  }
  return null;
}

/**
 * @module integration/review/orchestration-mode
 * @description Projection-only reviewer orchestration mode resolver.
 *
 * This module does not approve, block, mutate state, bind evidence, or consume
 * obligations. It only projects the transport mode that should be described to
 * the agent from the existing platform and policy inputs.
 */

import type { ReviewInvocationPolicy } from '../../config/policy-types.js';

export type ReviewOrchestrationMode =
  | 'host_task_sync'
  | 'external_instruction_pending'
  | 'manual_attested_required'
  | 'unsupported_blocked';

export type ReviewHostPlatform = 'opencode' | 'claude-code' | 'codex' | 'unknown';

export interface ReviewOrchestrationModeInput {
  readonly platform: ReviewHostPlatform;
  readonly reviewInvocationPolicy?: ReviewInvocationPolicy;
  readonly nativeReviewerAvailable?: boolean;
  readonly manualAttestedAllowed?: boolean;
}

export function normalizeReviewHostPlatform(value: unknown): ReviewHostPlatform {
  if (value === 'opencode' || value === 'claude-code' || value === 'codex') return value;
  return 'unknown';
}

export function resolveReviewOrchestrationMode(
  input: ReviewOrchestrationModeInput,
): ReviewOrchestrationMode {
  if (input.platform === 'opencode') return 'host_task_sync';

  if (input.platform === 'claude-code' || input.platform === 'codex') {
    if (input.reviewInvocationPolicy === 'host_task_required') {
      return input.manualAttestedAllowed === true
        ? 'manual_attested_required'
        : 'unsupported_blocked';
    }
    if (input.nativeReviewerAvailable === false) {
      return input.manualAttestedAllowed === true
        ? 'manual_attested_required'
        : 'unsupported_blocked';
    }
    return 'external_instruction_pending';
  }

  if (input.manualAttestedAllowed === true) return 'manual_attested_required';
  return 'unsupported_blocked';
}

export function resolveRuntimeReviewPlatform(
  env: NodeJS.ProcessEnv = process.env,
): ReviewHostPlatform {
  const explicit = env.FLOWGUARD_HOST_PLATFORM ?? env.FLOWGUARD_PLATFORM;
  return explicit === undefined ? 'opencode' : normalizeReviewHostPlatform(explicit);
}

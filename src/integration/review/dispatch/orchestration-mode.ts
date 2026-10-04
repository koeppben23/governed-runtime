/**
 * @module integration/review/orchestration-mode
 * @description Projection-only reviewer orchestration mode resolver.
 *
 * This module does not approve, block, mutate state, bind evidence, or consume
 * obligations. It only projects the transport mode that should be described to
 * the agent from the existing host input.
 */

export type ReviewOrchestrationMode =
  'host_structured' | 'external_instruction_pending' | 'unsupported_blocked';

export type ReviewHostPlatform = 'opencode' | 'claude-code' | 'codex' | 'unknown';

export interface ReviewOrchestrationModeInput {
  readonly platform: ReviewHostPlatform;
  readonly nativeReviewerAvailable?: boolean;
}

export function normalizeReviewHostPlatform(value: unknown): ReviewHostPlatform {
  if (value === 'opencode' || value === 'claude-code' || value === 'codex') return value;
  return 'unknown';
}

export function resolveReviewOrchestrationMode(
  input: ReviewOrchestrationModeInput,
): ReviewOrchestrationMode {
  if (input.platform === 'opencode') return 'host_structured';

  if (input.platform === 'claude-code' || input.platform === 'codex') {
    if (input.nativeReviewerAvailable === false) {
      return 'unsupported_blocked';
    }
    return 'external_instruction_pending';
  }

  return 'unsupported_blocked';
}

export function resolveRuntimeReviewPlatform(
  env: NodeJS.ProcessEnv = process.env,
): ReviewHostPlatform {
  const explicit = env.FLOWGUARD_HOST_PLATFORM ?? env.FLOWGUARD_PLATFORM;
  return explicit === undefined ? 'opencode' : normalizeReviewHostPlatform(explicit);
}

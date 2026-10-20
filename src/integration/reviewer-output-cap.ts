/**
 * @module integration/reviewer-output-cap
 * @description OpenCode `chat.params` hook that applies the configured output
 *              cap to the independent reviewer only.
 *
 * OpenCode computes `maxOutputTokens` before invoking `chat.params`; the hook's
 * mutable output is then passed to the provider. The hook therefore changes
 * only the reviewer request's output ceiling and leaves the parent, model,
 * variant, reasoning options, and all other parameters untouched.
 *
 * The configuration is read once at plugin startup. A malformed configuration,
 * an unknown model limit, or a model limit below the configured cap fails the
 * reviewer request closed. The failure is retained in a bounded in-memory map
 * so the native Task after-hook can surface a terminal, actionable block
 * instead of re-arming the same unusable configuration.
 */

import type { Hooks } from '@opencode-ai/plugin';

import type { FlowGuardConfig } from '../config/flowguard-config.js';
import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';
import type { ReviewerOutputCapErrorCode, ReviewerOutputCapFailure } from './review/types.js';

/** Stable failure evidence consumed by the native Task after-hook. */
export type { ReviewerOutputCapErrorCode, ReviewerOutputCapFailure };

export class ReviewerOutputCapError extends Error {
  readonly code: ReviewerOutputCapErrorCode;

  constructor(code: ReviewerOutputCapErrorCode, message: string) {
    super(message);
    this.name = 'ReviewerOutputCapError';
    this.code = code;
  }
}

export interface ReviewerOutputCapLogger {
  info(service: string, message: string, extra?: Record<string, unknown>): void;
  error(service: string, message: string, extra?: Record<string, unknown>): void;
}

export interface ReviewerOutputCapDeps {
  /** Fully resolved repo-or-global FlowGuard configuration. */
  readonly config: Pick<FlowGuardConfig, 'reviewer'>;
  /** Original config-read failure retained alongside the logging fallback. */
  readonly configReadError?: unknown;
  readonly log: ReviewerOutputCapLogger;
  /** Bounded diagnostic map keyed by the reviewer child session. */
  readonly failures?: Map<string, ReviewerOutputCapFailure>;
}

type ChatParamsHook = NonNullable<Hooks['chat.params']>;
type ChatParamsInput = Parameters<ChatParamsHook>[0];
type ChatParamsOutput = Parameters<ChatParamsHook>[1];

function outputLimitOf(model: ChatParamsInput['model']): number | null {
  const limit = (model as unknown as { limit?: { output?: unknown } }).limit?.output;
  return typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? limit : null;
}

function modelLabelOf(model: ChatParamsInput['model']): string {
  const value = model as unknown as { id?: unknown; name?: unknown; providerID?: unknown };
  const provider = typeof value.providerID === 'string' ? value.providerID : 'unknown';
  const id =
    typeof value.id === 'string'
      ? value.id
      : typeof value.name === 'string'
        ? value.name
        : 'unknown';
  return provider === 'unknown' ? id : `${provider}/${id}`;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'unknown configuration read error';
}

function rememberFailure(
  failures: Map<string, ReviewerOutputCapFailure> | undefined,
  sessionID: string,
  failure: ReviewerOutputCapFailure,
): void {
  if (!failures) return;
  if (failures.size >= 100) {
    const oldest = failures.keys().next().value;
    if (oldest !== undefined) failures.delete(oldest);
  }
  failures.set(sessionID, failure);
}

function rejectOutputCap(
  deps: ReviewerOutputCapDeps,
  input: ChatParamsInput,
  failure: ReviewerOutputCapFailure,
): never {
  rememberFailure(deps.failures, input.sessionID, failure);
  deps.log.error('review', 'reviewer output cap rejected', {
    sessionID: input.sessionID,
    agent: input.agent,
    model: failure.model,
    modelLimit: failure.modelLimit,
    configured: failure.configured,
    code: failure.code,
    reason: failure.reason,
  });
  throw new ReviewerOutputCapError(failure.code, failure.reason);
}

/**
 * Build the `chat.params` hook. The hook is inert for every non-reviewer agent.
 */
export function createReviewerOutputCapHook(deps: ReviewerOutputCapDeps): ChatParamsHook {
  return async (input: ChatParamsInput, output: ChatParamsOutput): Promise<void> => {
    if (input.agent !== REVIEWER_SUBAGENT_TYPE) return;

    const model = modelLabelOf(input.model);
    const modelLimit = outputLimitOf(input.model);
    const configured = deps.config.reviewer.outputTokenMax;

    const reject = (code: ReviewerOutputCapErrorCode, reason: string): never =>
      rejectOutputCap(deps, input, { code, reason, model, modelLimit, configured });

    if (deps.configReadError !== undefined) {
      reject(
        'REVIEWER_OUTPUT_CAP_CONFIG_UNREADABLE',
        `FlowGuard configuration could not be read: ${describeError(deps.configReadError)}. ` +
          'The reviewer output cap cannot be applied safely.',
      );
    }
    if (!Number.isInteger(configured) || configured < 1) {
      reject(
        'REVIEWER_OUTPUT_CAP_CONFIG_INVALID',
        `reviewer.outputTokenMax must be a positive integer; got ${String(configured)}.`,
      );
    }
    if (modelLimit === null) {
      return reject(
        'REVIEWER_OUTPUT_CAP_MODEL_LIMIT_UNKNOWN',
        `The host did not report an output-token limit for reviewer model ${model}. ` +
          `The configured reviewer.outputTokenMax=${configured} cannot be validated.`,
      );
    }
    if (modelLimit < configured) {
      reject(
        'REVIEWER_OUTPUT_CAP_MODEL_LIMIT_TOO_SMALL',
        `Reviewer model ${model} supports ${modelLimit} output tokens, below the configured ` +
          `reviewer.outputTokenMax=${configured}. Lower reviewer.outputTokenMax or choose a ` +
          'model that supports the configured cap.',
      );
    }

    const previous = output.maxOutputTokens;
    output.maxOutputTokens = configured;
    deps.log.info('review', 'reviewer output cap applied', {
      sessionID: input.sessionID,
      agent: input.agent,
      model,
      modelLimit,
      configured,
      previous,
      effective: output.maxOutputTokens,
    });
  };
}

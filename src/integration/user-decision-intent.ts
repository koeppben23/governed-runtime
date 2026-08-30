import type { ReviewVerdict } from '../state/evidence.js';

export type UserDecisionCommand =
  | '/approve'
  | '/request-changes'
  | '/reject'
  | '/review-decision'
  | '/extend-implementation-review';

export interface UserDecisionIntent {
  readonly sessionId: string;
  readonly command: UserDecisionCommand;
  readonly expectedVerdict: ReviewVerdict;
  readonly additionalIterations?: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly consumed: false;
}

export type UserDecisionIntentRejection = 'missing' | 'expired' | 'verdict_mismatch';

export type UserDecisionIntentConsumeResult =
  | { readonly ok: true; readonly intent: UserDecisionIntent }
  | { readonly ok: false; readonly reason: UserDecisionIntentRejection };

const DEFAULT_TTL_MS = 30_000;
const intents = new Map<string, UserDecisionIntent>();

function nowDate(nowMs = Date.now()): Date {
  return new Date(nowMs);
}

function normalizeCommand(command: string): string {
  const trimmed = command.trim();
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function firstToken(input: string): string {
  return input.trim().split(/\s+/)[0] ?? '';
}

export function parseUserDecisionCommand(input: {
  readonly command: string;
  readonly arguments: string;
}): { readonly command: UserDecisionCommand; readonly expectedVerdict: ReviewVerdict } | null {
  const command = normalizeCommand(input.command);
  if (command === '/approve') return { command, expectedVerdict: 'approve' };
  if (command === '/request-changes') return { command, expectedVerdict: 'changes_requested' };
  if (command === '/reject') return { command, expectedVerdict: 'reject' };
  if (command !== '/review-decision') return null;

  const verdict = firstToken(input.arguments);
  if (verdict === 'approve' || verdict === 'changes_requested' || verdict === 'reject') {
    return { command, expectedVerdict: verdict };
  }
  return null;
}

export function recordUserDecisionIntent(input: {
  readonly sessionId: string;
  readonly command: UserDecisionCommand;
  readonly expectedVerdict: ReviewVerdict;
  readonly nowMs?: number;
  readonly ttlMs?: number;
}): UserDecisionIntent {
  const createdAtMs = input.nowMs ?? Date.now();
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  const intent: UserDecisionIntent = {
    sessionId: input.sessionId,
    command: input.command,
    expectedVerdict: input.expectedVerdict,
    createdAt: nowDate(createdAtMs).toISOString(),
    expiresAt: nowDate(createdAtMs + ttlMs).toISOString(),
    consumed: false,
  };
  intents.set(input.sessionId, intent);
  return intent;
}

export function recordUserDecisionIntentFromCommand(input: {
  readonly sessionId: string;
  readonly command: string;
  readonly arguments: string;
  readonly nowMs?: number;
  readonly ttlMs?: number;
}): UserDecisionIntent | null {
  if (normalizeCommand(input.command) === '/extend-implementation-review') {
    const additionalIterations = Number(firstToken(input.arguments));
    if (
      !Number.isFinite(additionalIterations) ||
      !Number.isInteger(additionalIterations) ||
      additionalIterations <= 0
    ) {
      return null;
    }
    const createdAtMs = input.nowMs ?? Date.now();
    const intent: UserDecisionIntent = {
      sessionId: input.sessionId,
      command: '/extend-implementation-review',
      // This sentinel is never accepted by decision tools; extension consumption
      // additionally binds the captured iteration count below.
      expectedVerdict: 'reject',
      additionalIterations,
      createdAt: nowDate(createdAtMs).toISOString(),
      expiresAt: nowDate(createdAtMs + (input.ttlMs ?? DEFAULT_TTL_MS)).toISOString(),
      consumed: false,
    };
    intents.set(input.sessionId, intent);
    return intent;
  }
  const parsed = parseUserDecisionCommand(input);
  if (!parsed) return null;
  return recordUserDecisionIntent({
    sessionId: input.sessionId,
    command: parsed.command,
    expectedVerdict: parsed.expectedVerdict,
    nowMs: input.nowMs,
    ttlMs: input.ttlMs,
  });
}

export function consumeImplementationReviewExtensionIntent(input: {
  readonly sessionId: string;
  readonly additionalIterations: number;
  readonly nowMs?: number;
}): UserDecisionIntentConsumeResult {
  const intent = intents.get(input.sessionId);
  if (!intent) return { ok: false, reason: 'missing' };
  intents.delete(input.sessionId);
  if (Date.parse(intent.expiresAt) <= (input.nowMs ?? Date.now()))
    return { ok: false, reason: 'expired' };
  if (
    intent.command !== '/extend-implementation-review' ||
    intent.additionalIterations !== input.additionalIterations
  ) {
    return { ok: false, reason: 'verdict_mismatch' };
  }
  return { ok: true, intent };
}

/**
 * Non-destructive gate check for a recorded user-decision intent.
 *
 * Unlike {@link consumeUserDecisionIntent}, a *valid* intent is left in place so
 * a decision call that fails at a later, independent stage (schema validation,
 * actor assurance, etc.) can be retried without the user re-issuing the command.
 * The valid intent is only removed once the decision is actually processed — see
 * {@link consumeUserDecisionIntent}, which the decision tool calls on success.
 *
 * Anti-replay is preserved for the terminal rejection reasons: an `expired` or
 * `verdict_mismatch` intent IS deleted here so a stale or wrong-verdict command
 * can never become an implicit approval cache for a later tool call. A `missing`
 * intent has nothing to delete.
 */
export function peekUserDecisionIntent(input: {
  readonly sessionId: string;
  readonly verdict: ReviewVerdict;
  readonly nowMs?: number;
}): UserDecisionIntentConsumeResult {
  const intent = intents.get(input.sessionId);
  if (!intent) return { ok: false, reason: 'missing' };

  const nowMs = input.nowMs ?? Date.now();
  if (Date.parse(intent.expiresAt) <= nowMs) {
    intents.delete(input.sessionId);
    return { ok: false, reason: 'expired' };
  }
  if (intent.expectedVerdict !== input.verdict) {
    intents.delete(input.sessionId);
    return { ok: false, reason: 'verdict_mismatch' };
  }
  return { ok: true, intent };
}

export function consumeUserDecisionIntent(input: {
  readonly sessionId: string;
  readonly verdict: ReviewVerdict;
  readonly nowMs?: number;
}): UserDecisionIntentConsumeResult {
  const intent = intents.get(input.sessionId);
  if (!intent) return { ok: false, reason: 'missing' };

  // Consume/delete on every observed attempt so stale or mismatched approvals
  // cannot become an implicit approval cache for a later tool call.
  intents.delete(input.sessionId);

  const nowMs = input.nowMs ?? Date.now();
  if (Date.parse(intent.expiresAt) <= nowMs) return { ok: false, reason: 'expired' };
  if (intent.expectedVerdict !== input.verdict) return { ok: false, reason: 'verdict_mismatch' };
  return { ok: true, intent };
}

export function clearUserDecisionIntents(): void {
  intents.clear();
}

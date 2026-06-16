import type { ReviewVerdict } from '../state/evidence.js';

export type UserDecisionCommand = '/approve' | '/request-changes' | '/reject' | '/review-decision';

export interface UserDecisionIntent {
  readonly sessionId: string;
  readonly command: UserDecisionCommand;
  readonly expectedVerdict: ReviewVerdict;
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

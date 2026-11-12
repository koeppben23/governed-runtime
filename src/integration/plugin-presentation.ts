/**
 * @module integration/plugin-presentation
 * @description Ephemeral baseline progress between /approve and /implement.
 * Presentation is never audit evidence, workflow state, model
 * context or approval authority. It intentionally has no durable storage: a
 * plugin reload loses it, and the UI falls back to canonical read-only state.
 */
import { randomUUID } from 'node:crypto';
import type { AutoValidationProgressEvent } from './tools/helpers.js';
import type { SystemWorkOperation } from '../state/system-work.js';
import type { Plugin } from '@opencode/plugin';
import { resolveSessionAuthority } from '../adapters/session-authority.js';
import type { PresentationRequest, PresentationResult } from './opencode-governance-rpc.js';

export type PresentationKind = 'validation';

export interface PresentationEvent {
  readonly operation: SystemWorkOperation;
  readonly runID: string;
  readonly stage: AutoValidationProgressEvent['stage'];
  readonly id: string;
  readonly sessionID: string;
  readonly kind: PresentationKind;
  readonly message: string;
  readonly phase?: 'VALIDATION';
  readonly checks?: readonly string[];
  readonly occurredAt: string;
}

export interface PresentationInput {
  readonly operation: SystemWorkOperation;
  readonly runID: string;
  readonly stage: AutoValidationProgressEvent['stage'];
  readonly kind: PresentationKind;
  readonly message: string;
  readonly phase?: 'VALIDATION';
  readonly checks?: readonly string[];
}

export interface PresentationPage {
  readonly events: readonly PresentationEvent[];
  readonly cursor: string | null;
}

export interface PresentationStore {
  record(sessionID: string, input: PresentationInput): void;
  read(sessionID: string, after?: string): PresentationPage;
  clear(sessionID: string): void;
  subscribe(notify: (sessionID: string) => void): () => void;
}

interface SessionPresentation {
  events: PresentationEvent[];
  cursor: string | null;
}

const DEFAULT_MAX_EVENTS_PER_SESSION = 64;
const DEFAULT_MAX_SESSIONS = 128;
const DEFAULT_MAX_MESSAGE_LENGTH = 32_768;
const MAX_CHECKS = 32;
const MAX_CHECK_LENGTH = 128;

const TRUNCATION_SUFFIX = '\n\n[truncated]';

function bounded(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= TRUNCATION_SUFFIX.length) return value.slice(0, max);
  return `${value.slice(0, max - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`;
}

function boundedChecks(checks: readonly string[]): readonly string[] {
  return checks.slice(0, MAX_CHECKS).map((check) => bounded(String(check), MAX_CHECK_LENGTH));
}

function acceptsProgress(latest: PresentationEvent | undefined, input: PresentationInput): boolean {
  if (input.stage === 'starting')
    return (
      !latest ||
      input.operation.requestedAt > latest.operation.requestedAt ||
      (input.operation.requestedAt === latest.operation.requestedAt &&
        input.operation.attempt > latest.operation.attempt)
    );
  return (
    latest !== undefined &&
    latest.runID === input.runID &&
    latest.stage !== 'finished' &&
    latest.operation.requestedAt === input.operation.requestedAt &&
    latest.operation.attempt === input.operation.attempt &&
    latest.operation.retryAfter === input.operation.retryAfter
  );
}

function presentationEvent(
  sessionID: string,
  input: PresentationInput,
  maxMessageLength: number,
): PresentationEvent {
  return {
    operation: { ...input.operation },
    runID: input.runID,
    stage: input.stage,
    id: randomUUID(),
    sessionID,
    kind: input.kind,
    message: bounded(input.message, maxMessageLength),
    ...(input.phase === undefined ? {} : { phase: input.phase }),
    ...(input.checks === undefined ? {} : { checks: boundedChecks(input.checks) }),
    occurredAt: new Date().toISOString(),
  };
}

/**
 * Create a bounded in-memory presentation store.
 *
 * The store is deliberately synchronous: a host notification handler must never
 * wait for UI delivery. Callers treat a failed record as a lost presentation,
 * never as a governance failure. The store is not part of the audit chain.
 */
export function createPresentationStore(
  options: {
    readonly maxEventsPerSession?: number;
    readonly maxSessions?: number;
    readonly maxMessageLength?: number;
  } = {},
): PresentationStore {
  const maxEventsPerSession = options.maxEventsPerSession ?? DEFAULT_MAX_EVENTS_PER_SESSION;
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const maxMessageLength = options.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH;
  const sessions = new Map<string, SessionPresentation>();
  const order: string[] = [];
  const listeners = new Set<(sessionID: string) => void>();

  const touch = (sessionID: string): void => {
    const index = order.indexOf(sessionID);
    if (index >= 0) order.splice(index, 1);
    order.push(sessionID);
    while (order.length > maxSessions) {
      const oldest = order.shift();
      if (oldest !== undefined) sessions.delete(oldest);
    }
  };

  return {
    record(sessionID, input) {
      if (!sessionID) return;
      const state = sessions.get(sessionID) ?? { events: [], cursor: null };
      const latest = state.events.at(-1);
      if (!acceptsProgress(latest, input)) return;
      if (input.stage === 'starting') state.events = [];
      const event = presentationEvent(sessionID, input, maxMessageLength);
      state.events.push(event);
      if (state.events.length > maxEventsPerSession)
        state.events.splice(0, state.events.length - maxEventsPerSession);
      state.cursor = event.id;
      sessions.set(sessionID, state);
      touch(sessionID);
      for (const notify of listeners) {
        try {
          notify(sessionID);
        } catch (error) {
          console.warn(
            '[FlowGuard] Presentation notification failed; governance is unchanged.',
            error,
          );
        }
      }
    },
    read(sessionID, after) {
      const state = sessions.get(sessionID);
      if (!state) return { events: [], cursor: null };
      touch(sessionID);
      if (after === undefined) return { events: [...state.events], cursor: state.cursor };
      const index = state.events.findIndex((event) => event.id === after);
      if (index < 0) return { events: [...state.events], cursor: state.cursor };
      return { events: state.events.slice(index + 1), cursor: state.cursor };
    },
    clear(sessionID) {
      sessions.delete(sessionID);
      const index = order.indexOf(sessionID);
      if (index >= 0) order.splice(index, 1);
    },
    subscribe(notify) {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
  };
}

/** Presentation failures are diagnosed, never promoted to governance failures. */
export function recordPresentation(
  store: Pick<PresentationStore, 'record'> | undefined,
  sessionID: string,
  input: PresentationInput,
): void {
  if (store === undefined) return;
  try {
    store.record(sessionID, input);
  } catch (error) {
    console.warn('[FlowGuard] Presentation delivery failed; governance is unchanged.', error);
  }
}

/** Check admission is preparation, never proof that a subprocess has started. */
export function recordValidationProgress(
  store: PresentationStore,
  sessionID: string,
  event: AutoValidationProgressEvent,
): void {
  if (event.phase !== 'VALIDATION') return;
  const message =
    event.stage === 'finished'
      ? 'Baseline validation attempt ended; canonical results remain authoritative.'
      : event.stage === 'check_started' && event.check !== undefined
        ? `**Validation in progress** — preparing \`${event.check}\` check.`
        : event.stage === 'check_finished' && event.check !== undefined
          ? `**Validation in progress** — \`${event.check}\` returned; the canonical check result remains authoritative.`
          : `**Validation started** — preparing ${event.checks.map((check) => `\`${check}\``).join(', ')}.`;
  recordPresentation(store, sessionID, {
    operation: event.operation,
    runID: event.runID,
    stage: event.stage,
    kind: 'validation',
    message,
    phase: event.phase,
    checks: event.checks,
  });
}

/** Read only the current durable baseline generation, never an earlier run. */
export async function getPresentation(
  ctx: Pick<Plugin.Context, 'session' | 'location'>,
  presentation: PresentationStore,
  request: PresentationRequest,
): Promise<PresentationResult> {
  const empty: PresentationResult = { sessionID: request.sessionID, events: [], cursor: null };
  try {
    const session = await ctx.session.get(
      { sessionID: request.sessionID },
      { signal: AbortSignal.timeout(2_000) },
    );
    if (session.id !== request.sessionID || session.location.directory !== ctx.location.directory)
      return empty;
    const bound = await resolveSessionAuthority({
      root: ctx.location.directory,
      sessionId: request.sessionID,
    });
    if (bound.status !== 'resolved' || bound.state.phase !== 'VALIDATION' || bound.state.error)
      return empty;
    const operation = bound.state.pendingSystemWork;
    const page = presentation.read(request.sessionID, request.after);
    const events = page.events.filter(
      (event) =>
        operation !== null &&
        event.operation.requestedAt === operation.requestedAt &&
        event.operation.attempt === operation.attempt &&
        event.operation.retryAfter === operation.retryAfter,
    );
    return {
      sessionID: request.sessionID,
      events: events.map((event) => ({
        ...event,
        checks: event.checks === undefined ? undefined : [...event.checks],
      })),
      cursor: page.cursor,
    };
  } catch (error) {
    console.warn('[FlowGuard] Current baseline presentation unavailable.', error);
    return empty;
  }
}

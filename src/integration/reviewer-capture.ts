/** Synchronous, request-scoped capture fence. Never mutates host permissions. */
import { randomUUID } from 'node:crypto';
import { hashText } from '../shared/hashing.js';
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';
import {
  ReviewerModelSelection,
  type ReviewMessageCapture,
} from '../state/review-message-capture.js';
import type { OrchestratorClient } from './review/types.js';

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
}

export class ReviewerCaptureError extends Error {
  readonly code = 'REVIEWER_CAPTURE_PROVENANCE_INVALID';
}

export class ReviewerCaptureOutcomeUnknownError extends Error {
  readonly code = 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN';
}

interface Capture {
  readonly leaseId: string;
  readonly childSessionId: string;
  readonly obligationId: string;
  readonly attemptId: string;
  readonly model: ReviewerModelSelection;
  requestMessageId: string;
  requestDigest: string;
  requestObserved: boolean;
  transformObserved: boolean;
  paramsObserved: boolean;
  responseMessageId?: string;
  violation?: string;
  quarantined: boolean;
  reconciliation?: Promise<boolean>;
  idleReconciliationAttempts?: number;
  terminalReconciliationMessageId?: string;
  terminalReconciliationAttempts?: number;
}

/** Event-driven retries only; each trigger is a proven host state change. */
const MAX_RECONCILIATION_ATTEMPTS = 3;

export class ReviewerCaptureController {
  private readonly active = new Map<string, Capture>();

  begin(
    childSessionId: string,
    model: ReviewerModelSelection,
    lineage: { readonly obligationId: string; readonly attemptId: string },
  ): string {
    if (this.active.has(childSessionId) || this.active.size >= 128) {
      throw new ReviewerCaptureError('Reviewer capture is busy or its bounded fence is full.');
    }
    const leaseId = randomUUID();
    this.active.set(childSessionId, {
      leaseId,
      childSessionId,
      model,
      ...lineage,
      requestMessageId: '',
      requestDigest: '',
      requestObserved: false,
      transformObserved: false,
      paramsObserved: false,
      quarantined: false,
    });
    return leaseId;
  }

  request(childSessionId: string, text: string): string {
    const capture = this.require(childSessionId);
    this.assertSafe(childSessionId);
    capture.requestMessageId = `msg_${randomUUID().replaceAll('-', '')}`;
    capture.requestDigest = hashText(text);
    capture.requestObserved = false;
    capture.transformObserved = false;
    capture.paramsObserved = false;
    delete capture.responseMessageId;
    return capture.requestMessageId;
  }

  onMessage(input: unknown, output: unknown): void {
    const context = record(input);
    const capture = this.active.get(String(context.sessionID));
    if (!capture) return;
    const message = record(record(output).message);
    const parts = record(output).parts;
    const text = textOf(parts);
    if (
      capture.requestObserved ||
      message.id !== capture.requestMessageId ||
      message.sessionID !== capture.childSessionId ||
      message.role !== 'user' ||
      message.agent !== REVIEWER_SUBAGENT_TYPE ||
      hashText(text ?? '') !== capture.requestDigest ||
      !sameModel(record(message.model), capture.model)
    ) {
      return this.reject(capture, 'Concurrent, mutated, or uncorrelated reviewer request.');
    }
    capture.requestObserved = true;
  }

  onMessages(output: unknown): void {
    if (this.active.size === 0) return;
    const messages = record(output).messages;
    const capture = this.contextCapture(messages);
    if (!capture || !Array.isArray(messages)) return;
    const requestIndex = messages.findIndex(
      (entry: unknown) => record(record(entry).info).id === capture.requestMessageId,
    );
    if (requestIndex === -1 || !capture.requestObserved || capture.transformObserved) {
      return this.reject(capture, 'Missing request or additional serialization step.');
    }
    // v1.19.5 passes pre-step history, excluding the just-created assistant.
    if (messages.length !== requestIndex + 1) {
      return this.reject(
        capture,
        'Serialization context contains intervening actions or messages.',
      );
    }
    capture.transformObserved = true;
  }

  private contextCapture(messages: unknown): Capture | null {
    if (!Array.isArray(messages) || messages.length === 0) {
      for (const capture of this.active.values())
        capture.violation ??= 'Unattributable host context.';
      throw new ReviewerCaptureError('Host context has no provable session identity.');
    }
    const sessionIds = new Set(
      messages.map((entry: unknown) => record(record(entry).info).sessionID),
    );
    const captures = [...this.active.values()].filter((capture) =>
      sessionIds.has(capture.childSessionId),
    );
    if (captures.length === 0) return null;
    if (sessionIds.size !== 1 || captures.length !== 1) {
      for (const capture of captures) capture.violation ??= 'Mixed-session host context.';
      throw new ReviewerCaptureError('Mixed-session host context.');
    }
    return captures[0] ?? null;
  }

  onParams(input: unknown, output: unknown): void {
    const value = record(input);
    const capture = this.active.get(String(value.sessionID));
    if (!capture) return;
    const message = record(value.message);
    const model = record(value.model);
    if (
      capture.paramsObserved ||
      !capture.transformObserved ||
      value.agent !== REVIEWER_SUBAGENT_TYPE ||
      message.id !== capture.requestMessageId ||
      model.providerID !== capture.model.providerID ||
      model.id !== capture.model.modelID ||
      !sameModel(record(message.model), capture.model)
    ) {
      return this.reject(capture, 'Model request does not match the serialization selection.');
    }
    // Options are observed, never rewritten. Their final wire form is host-tested.
    if (!record(output).options || typeof record(output).options !== 'object') {
      return this.reject(capture, 'Host model options are unavailable.');
    }
    capture.paramsObserved = true;
  }

  beforeTool(input: unknown): void {
    const capture = this.active.get(String(record(input).sessionID));
    if (capture) this.reject(capture, 'Tool action attempted during reviewer serialization.');
  }

  verify(childSessionId: string, response: unknown, payloadText: string): ReviewMessageCapture {
    const capture = this.require(childSessionId);
    const info = record(record(response).info);
    // A stale/incomplete response proves neither completion of this request nor
    // host quiescence. Keep the fence even if another capture check also fails.
    if (!responseIdentityMatches(info, capture) || !hasTerminalOutcome(info)) {
      capture.quarantined = true;
      throw new ReviewerCaptureOutcomeUnknownError(
        'Reviewer response does not prove termination of the exact capture request.',
      );
    }
    this.assertSafe(childSessionId);
    if (
      !capture.requestObserved ||
      !capture.transformObserved ||
      !capture.paramsObserved ||
      !responseIdentityMatches(info, capture) ||
      !completedResponse(info) ||
      textOf(record(response).parts) !== payloadText
    ) {
      return this.reject(capture, 'Reviewer response lacks exact, tool-free request provenance.');
    }
    return {
      childSessionId,
      obligationId: capture.obligationId,
      attemptId: capture.attemptId,
      requestMessageId: capture.requestMessageId,
      responseMessageId: String(info.id),
      requestDigest: capture.requestDigest,
      payloadText,
      payloadDigest: hashText(payloadText),
      model: capture.model,
      assistantMessageIds: [String(info.id)],
    };
  }

  assertSafe(childSessionId: string): void {
    const capture = this.require(childSessionId);
    if (capture.violation || capture.quarantined) {
      throw new ReviewerCaptureError(capture.violation ?? 'Reviewer capture outcome is unknown.');
    }
  }

  isSafe(childSessionId: string): boolean {
    const capture = this.active.get(childSessionId);
    return capture !== undefined && !capture.violation && !capture.quarantined;
  }

  quarantine(childSessionId: string): void {
    const capture = this.active.get(childSessionId);
    if (capture) capture.quarantined = true;
  }

  isQuarantined(childSessionId: string): boolean {
    return this.active.get(childSessionId)?.quarantined === true;
  }

  /** A deterministic failure stays terminal, but the fence may only be
   * released when the host response proves the exact request's terminal
   * assistant completion. Missing, stale or non-assistant proof quarantines. */
  settleClassifiedFailure(childSessionId: string, response: unknown): void {
    const capture = this.active.get(childSessionId);
    if (!capture) return;
    const info = record(record(response).info);
    if (
      info.role !== 'assistant' ||
      !responseIdentityMatches(info, capture) ||
      !hasTerminalOutcome(info)
    ) {
      capture.quarantined = true;
    }
  }

  /** No timer/event alone unlocks a capture. Abort + stable, request-bound
   * terminal history + idle status are required, and the original lease must
   * still own the entry after every asynchronous host observation. */
  reconcileQuarantine(client: OrchestratorClient, childSessionId: string): Promise<boolean> {
    const capture = this.active.get(childSessionId);
    if (!capture?.quarantined) return Promise.resolve(false);
    if (capture.reconciliation) return capture.reconciliation;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const bounded = new Promise<boolean>((resolve) => {
      deadline = setTimeout(() => resolve(false), 1000);
      deadline.unref?.();
    });
    capture.reconciliation = Promise.race([
      this.confirmQuarantine(client, capture),
      bounded,
    ]).finally(() => {
      if (deadline) clearTimeout(deadline);
      delete capture.reconciliation;
    });
    return capture.reconciliation;
  }

  reconcileOnIdle(client: OrchestratorClient, childSessionId: string): Promise<boolean> {
    const capture = this.active.get(childSessionId);
    if (!capture?.quarantined) return Promise.resolve(false);
    // Abort itself publishes idle. A new probe must not start while one is
    // already observing the host; otherwise a later idle event retries, up to
    // the bound. Time alone never unlocks the fence.
    if (capture.reconciliation) return capture.reconciliation;
    const attempts = capture.idleReconciliationAttempts ?? 0;
    if (attempts >= MAX_RECONCILIATION_ATTEMPTS) return Promise.resolve(false);
    capture.idleReconciliationAttempts = attempts + 1;
    return this.reconcileQuarantine(client, childSessionId);
  }

  reconcileOnTerminalMessage(client: OrchestratorClient, message: unknown): Promise<boolean> {
    const info = record(message);
    const capture = this.active.get(String(info.sessionID));
    if (
      !capture?.quarantined ||
      !responseIdentityMatches(info, capture) ||
      !hasTerminalOutcome(info)
    )
      return Promise.resolve(false);
    if (capture.reconciliation) return capture.reconciliation;
    const messageId = String(info.id);
    if (capture.terminalReconciliationMessageId === messageId) return Promise.resolve(false);
    const attempts = capture.terminalReconciliationAttempts ?? 0;
    if (attempts >= MAX_RECONCILIATION_ATTEMPTS) return Promise.resolve(false);
    capture.terminalReconciliationMessageId = messageId;
    capture.terminalReconciliationAttempts = attempts + 1;
    const result = this.reconcileQuarantine(client, capture.childSessionId);
    // A failed observation consumed this update but not the message identity:
    // a later host update for the same terminal message may retry within the
    // bound. A successful reconciliation deletes the capture.
    void result.then((released) => {
      if (
        !released &&
        this.active.get(capture.childSessionId) === capture &&
        capture.terminalReconciliationMessageId === messageId
      ) {
        delete capture.terminalReconciliationMessageId;
      }
    });
    return result;
  }

  private async confirmQuarantine(client: OrchestratorClient, capture: Capture): Promise<boolean> {
    try {
      const owned = () =>
        this.active.get(capture.childSessionId) === capture && capture.quarantined;
      if (!(await confirmCaptureTermination(client, capture, owned))) return false;
      if (this.active.get(capture.childSessionId) !== capture || !capture.quarantined) return false;
      this.active.delete(capture.childSessionId);
      return true;
    } catch {
      // Failed host I/O is an unconfirmed outcome, never an unlock signal.
      return false;
    }
  }

  /** Only the owner lease may release; a failed concurrent begin must never
   * remove another operation's fence. Quarantined captures are retained. */
  release(childSessionId: string, leaseId?: string): void {
    const capture = this.active.get(childSessionId);
    if (capture && leaseId !== undefined && capture.leaseId === leaseId && !capture.quarantined) {
      this.active.delete(childSessionId);
    }
  }

  private require(childSessionId: string): Capture {
    const capture = this.active.get(childSessionId);
    if (!capture) throw new ReviewerCaptureError('Reviewer capture fence is unavailable.');
    return capture;
  }

  private reject(capture: Capture, reason: string): never {
    capture.violation ??= reason;
    throw new ReviewerCaptureError(capture.violation);
  }
}

function sameModel(value: RecordValue, expected: ReviewerModelSelection): boolean {
  return (
    value.providerID === expected.providerID &&
    value.modelID === expected.modelID &&
    (value.variant ?? null) === expected.variant
  );
}

function responseIdentityMatches(info: RecordValue, capture: Capture): boolean {
  return (
    info.sessionID === capture.childSessionId &&
    info.parentID === capture.requestMessageId &&
    typeof info.id === 'string' &&
    info.id.startsWith('msg') &&
    info.id !== capture.requestMessageId &&
    sameModel(
      { providerID: info.providerID, modelID: info.modelID, variant: info.variant },
      capture.model,
    )
  );
}

function completedResponse(info: RecordValue): boolean {
  return (
    info.role === 'assistant' &&
    info.agent === REVIEWER_SUBAGENT_TYPE &&
    info.finish === 'stop' &&
    info.error == null &&
    Number.isFinite(record(info.time).completed)
  );
}

function hasTerminalOutcome(info: RecordValue): boolean {
  if (!Number.isFinite(record(info.time).completed)) return false;
  if (info.error != null) return true;
  return ['stop', 'length', 'content-filter', 'error', 'other'].includes(String(info.finish));
}

function terminalCaptureHistory(data: unknown, capture: Capture): boolean {
  if (!Array.isArray(data) || data.length === 0) return false;
  const messages = data.map((entry: unknown) => ({
    info: record(record(entry).info),
    parts: record(entry).parts,
  }));
  if (messages.some((entry) => entry.info.sessionID !== capture.childSessionId)) return false;
  const requests = messages.filter((entry) => entry.info.id === capture.requestMessageId);
  if (requests.length !== 1 || requests[0]?.info.role !== 'user') return false;
  const running = messages.some(
    (entry) =>
      Array.isArray(entry.parts) &&
      entry.parts.some((part: unknown) => {
        const value = record(part);
        return (
          value.type === 'tool' &&
          ['running', 'pending'].includes(String(record(value.state).status))
        );
      }),
  );
  const last = messages.at(-1)?.info;
  return (
    !running &&
    last !== undefined &&
    last.role === 'assistant' &&
    responseIdentityMatches(last, capture) &&
    hasTerminalOutcome(last)
  );
}

async function confirmCaptureTermination(
  client: OrchestratorClient,
  capture: Capture,
  owned: () => boolean,
): Promise<boolean> {
  const metadata = await client.getSession(capture.childSessionId);
  if (!owned() || metadata.sessionId !== capture.childSessionId) return false;
  const aborted = await client.interrupt(capture.childSessionId);
  if (!owned() || aborted !== true) return false;
  let previousDigest: string | undefined;
  for (let probe = 0; probe < 2; probe++) {
    const digest = await captureSnapshotDigest(client, capture, owned);
    if (digest === null) return false;
    if (previousDigest !== undefined && previousDigest !== digest) return false;
    previousDigest = digest;
  }
  return true;
}

async function captureSnapshotDigest(
  client: OrchestratorClient,
  capture: Capture,
  owned: () => boolean,
): Promise<string | null> {
  const [status, history] = await Promise.all([
    client.quiescence(capture.childSessionId),
    client.readHistory(capture.childSessionId),
  ]);
  if (!owned() || status !== 'idle' || !terminalCaptureHistory(history, capture)) return null;
  return hashText(canonicalJsonStringify(history));
}

/** Resolve only the actual final child call, linked to its own host user request. */
export function completedReviewerModel(
  data: unknown,
  childSessionId: string,
): ReviewerModelSelection | null {
  if (!Array.isArray(data)) return null;
  const assistant = [...data]
    .reverse()
    .map((entry: unknown) => record(record(entry).info))
    .find((info) => info.role === 'assistant');
  if (!assistant || assistant.sessionID !== childSessionId) return null;
  const user = data
    .map((entry: unknown) => record(record(entry).info))
    .find((info) => info.id === assistant.parentID);
  if (!user || user.role !== 'user' || user.sessionID !== childSessionId) return null;
  const selected = ReviewerModelSelection.safeParse({
    providerID: assistant.providerID,
    modelID: assistant.modelID,
    variant: assistant.variant ?? null,
  });
  return selected.success && sameModel(record(user.model), selected.data) ? selected.data : null;
}

/** Only regular text and reasoning are permitted; reasoning never enters the payload. */
export function textOf(parts: unknown): string | null {
  if (!Array.isArray(parts)) return null;
  const text: string[] = [];
  for (const raw of parts) {
    const part = record(raw);
    if (part.type === 'reasoning' || part.type === 'step-start' || part.type === 'step-finish')
      continue;
    if (
      part.type !== 'text' ||
      typeof part.text !== 'string' ||
      part.synthetic === true ||
      part.ignored === true
    )
      return null;
    text.push(part.text);
  }
  return text.join('');
}

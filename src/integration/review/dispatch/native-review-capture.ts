/**
 * @module integration/review/native-review-capture
 * @description Native same-child terminal capture. The after-hook verifies
 * a pre-bound dispatch/attempt/child; it never derives review authority from the
 * returned model text. Findings validation and the evidence/audit writer remain
 * canonical owners.
 */

import { randomUUID } from 'node:crypto';
import { canonicalJsonStringify } from '../../../shared/canonical-json.js';
import { hashText } from '../../../shared/hashing.js';
import { parseStrictJsonObject } from '../../../shared/strict-json-object.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../../shared/flowguard-identifiers.js';
import type { ReviewObligation, ReviewAttempt } from '../../../state/evidence.js';
import { ReviewerFindingsInput } from '../../../state/evidence-review-input.js';
import {
  ReviewMessageCapture,
  ReviewerModelSelection,
} from '../../../state/review-message-capture.js';
import { NativeSubagentCaptureProvenance } from '../../../state/evidence-review-invocation.js';
import type { SessionState } from '../../../state/schema.js';
import type { OrchestratorDeps } from '../pipeline-types.js';
import type { SessionAuthorityResolution } from '../../../adapters/session-authority.js';
import { buildObligationFindingsJsonSchema } from '../evidence/findings-schema.js';
import { prepareReviewerFindingsForValidation } from '../enforcement/prepare-findings.js';
import { recordEvidenceOrBlockReuse } from '../evidence/reviewer-evidence-recorder.js';
import { hashFindings } from '../findings-hash.js';
import {
  nativeReviewAuditIntents,
  validateCapturedFindings,
  obligationCaptureContract,
} from './native-review-findings.js';
import { serializationPromptFor } from './serialization-prompt.js';
import type { NativeReviewInitialController } from './native-review-initial.js';

const MAX_MESSAGES = 10_000;

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
}

export class NativeReviewCaptureError extends Error {
  readonly code = 'REVIEWER_CAPTURE_PROVENANCE_INVALID';
}

export class NativeReviewCaptureOutcomeUnknownError extends Error {
  readonly code = 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN';
}

export interface NativeCaptureHost {
  context(sessionID: string): Promise<readonly unknown[]>;
  /** Mint one host-valid request message identity for the serialization prompt. */
  mintRequestMessageId(): string;
  prompt(input: {
    readonly sessionID: string;
    readonly id: string;
    readonly text: string;
  }): Promise<unknown>;
  wait(sessionID: string): Promise<void>;
}

export interface NativeCaptureRuntime {
  readonly orchestratorDeps: OrchestratorDeps;
  readonly ws: {
    resolveSessionAuthority(sessionId: string): Promise<SessionAuthorityResolution>;
  };
  readonly reviewerExecutionTimeoutMs?: number;
  readonly log: {
    info(service: string, message: string, extra?: Record<string, unknown>): void;
    warn(service: string, message: string, extra?: Record<string, unknown>): void;
  };
  readonly logError: (message: string, error: unknown) => void;
}

interface Lease {
  readonly leaseId: string;
  readonly childSessionId: string;
  readonly nativeCallId: string;
  readonly obligationId: string;
  readonly attemptId: string;
  readonly requestMessageId: string;
  readonly requestText: string;
  readonly requestDigest: string;
  readonly model: ReviewerModelSelection;
  promptObserved: boolean;
  contextObserved: boolean;
  modelRequestObserved: boolean;
  toolAttempted: boolean;
  violation?: string;
  quarantined: boolean;
}

/**
 * Exclusive, request-scoped V2 lease. One child can own at most one capture;
 * observations are rejected once a violation or foreign request is seen.
 */
export class NativeReviewCaptureFence {
  private readonly active = new Map<string, Lease>();

  begin(input: {
    readonly childSessionId: string;
    readonly nativeCallId: string;
    readonly obligationId: string;
    readonly attemptId: string;
    readonly model: ReviewerModelSelection;
    readonly requestMessageId: string;
    readonly requestText: string;
  }): { readonly leaseId: string; readonly requestMessageId: string } {
    if (this.active.has(input.childSessionId))
      throw new NativeReviewCaptureError('Reviewer capture already owns this child.');
    const leaseId = randomUUID();
    const requestMessageId = input.requestMessageId;
    this.active.set(input.childSessionId, {
      leaseId,
      ...input,
      requestMessageId,
      requestDigest: hashText(input.requestText),
      promptObserved: false,
      contextObserved: false,
      modelRequestObserved: false,
      toolAttempted: false,
      quarantined: false,
    });
    return { leaseId, requestMessageId };
  }

  private lease(childSessionId: string, leaseId: string): Lease {
    const lease = this.active.get(childSessionId);
    if (!lease || lease.leaseId !== leaseId)
      throw new NativeReviewCaptureError('Reviewer capture lease is unavailable or foreign.');
    if (lease.quarantined || lease.violation)
      throw new NativeReviewCaptureError(lease.violation ?? 'Reviewer capture outcome is unknown.');
    return lease;
  }

  isActive(childSessionId: string, leaseId: string): boolean {
    const lease = this.active.get(childSessionId);
    return lease?.leaseId === leaseId && !lease.quarantined && lease.violation === undefined;
  }

  activeLease(childSessionId: string): string | undefined {
    const lease = this.active.get(childSessionId);
    return lease && !lease.quarantined && lease.violation === undefined ? lease.leaseId : undefined;
  }

  observePrompt(childSessionId: string, leaseId: string, messageID: string, text: string): void {
    const lease = this.lease(childSessionId, leaseId);
    if (
      lease.promptObserved ||
      messageID !== lease.requestMessageId ||
      hashText(text) !== lease.requestDigest
    )
      this.reject(lease, 'Reviewer serialization prompt is not the exact authorized request.');
    lease.promptObserved = true;
  }

  observeContext(childSessionId: string, leaseId: string, tools: Record<string, unknown>): void {
    const lease = this.lease(childSessionId, leaseId);
    if (lease.contextObserved)
      this.reject(lease, 'A second reviewer serialization context was observed.');
    // The capture request must be tool-free. The host may emit a tool call even
    // after removal; the before-hook below records that attempt as contamination.
    for (const name of Object.keys(tools)) delete tools[name];
    lease.contextObserved = true;
  }

  observeModelRequest(childSessionId: string, leaseId: string, kind: string, model: unknown): void {
    const lease = this.lease(childSessionId, leaseId);
    if (lease.modelRequestObserved || kind !== 'primary' || !sameModel(model, lease.model))
      this.reject(lease, 'Reviewer serialization model request is not the exact authorized step.');
    lease.modelRequestObserved = true;
  }

  beforeTool(childSessionId: string): void {
    const lease = this.active.get(childSessionId);
    if (!lease) return;
    lease.toolAttempted = true;
    this.reject(lease, 'Tool action attempted during reviewer serialization.');
  }

  verify(
    childSessionId: string,
    leaseId: string,
    baseline: readonly unknown[],
    history: readonly unknown[],
  ): {
    readonly capture: ReviewMessageCapture;
    readonly provenance: NativeSubagentCaptureProvenance;
  } {
    const lease = this.lease(childSessionId, leaseId);
    this.assertWindow(lease, baseline, history);
    const window = history.slice(baseline.length);
    if (!hasTerminalWindow(window))
      throw new NativeReviewCaptureOutcomeUnknownError(
        'Reviewer serialization has no proven terminal completion.',
      );
    const user = record(window[0]);
    const assistant = record(window[1]);
    this.assertRequest(lease, user, assistant);
    const payloadText = responseText(assistant.content);
    if (payloadText === null)
      this.reject(lease, 'Reviewer serialization contains a non-text content part.');
    const decoded = parseStrictJsonObject(payloadText);
    if (decoded.kind !== 'ok')
      this.reject(lease, 'Reviewer serialization is not one strict JSON object.');
    const findings = ReviewerFindingsInput.safeParse(decoded.value);
    if (!findings.success || findings.data.attestation.toolObligationId !== lease.obligationId)
      this.reject(lease, 'Reviewer serialization violates the obligation findings contract.');
    const capture = buildCapture(lease, childSessionId, assistant, payloadText);
    const provenance = buildProvenance(lease, capture, assistant, history);
    return { capture, provenance };
  }

  private assertWindow(
    lease: Lease,
    baseline: readonly unknown[],
    history: readonly unknown[],
  ): void {
    if (
      !lease.promptObserved ||
      !lease.contextObserved ||
      !lease.modelRequestObserved ||
      lease.toolAttempted ||
      baseline.length > MAX_MESSAGES ||
      history.length > MAX_MESSAGES
    )
      this.reject(lease, 'Reviewer serialization did not preserve the exact baseline window.');
    if (
      history.length !== baseline.length + 3 ||
      canonicalJsonStringify(history.slice(0, baseline.length)) !== canonicalJsonStringify(baseline)
    )
      this.reject(lease, 'Reviewer serialization did not preserve the exact baseline window.');
  }

  private assertRequest(lease: Lease, user: RecordValue, assistant: RecordValue): void {
    if (
      user.type !== 'user' ||
      user.id !== lease.requestMessageId ||
      user.text !== lease.requestText ||
      (Array.isArray(user.files) && user.files.length > 0) ||
      assistant.type !== 'assistant' ||
      typeof assistant.id !== 'string' ||
      !assistant.id.startsWith('msg') ||
      assistant.agent !== REVIEWER_SUBAGENT_TYPE ||
      !Number.isFinite(record(assistant.time).completed) ||
      !sameModel(assistant.model, lease.model)
    )
      this.reject(lease, 'Reviewer serialization has no exact terminal assistant completion.');
  }

  release(childSessionId: string, leaseId: string): void {
    const lease = this.active.get(childSessionId);
    if (lease?.leaseId === leaseId && !lease.quarantined) this.active.delete(childSessionId);
  }

  quarantine(childSessionId: string, leaseId: string): void {
    const lease = this.active.get(childSessionId);
    if (lease?.leaseId === leaseId) lease.quarantined = true;
  }

  private reject(lease: Lease, reason: string): never {
    lease.violation ??= reason;
    throw new NativeReviewCaptureError(lease.violation);
  }
}

function sameModel(value: unknown, expected: ReviewerModelSelection): boolean {
  const model = record(value);
  return (
    model.providerID === expected.providerID &&
    model.id === expected.modelID &&
    (model.variant ?? null) === expected.variant
  );
}

function responseText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const text: string[] = [];
  for (const raw of content) {
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

function hasTerminalWindow(window: readonly unknown[]): boolean {
  const assistant = record(window[1]);
  const terminal = record(window[2]);
  return (
    window.length === 3 &&
    terminal.type === 'idle' &&
    terminal.outcome === 'succeeded' &&
    assistant.error === undefined &&
    assistant.finish === 'stop'
  );
}

function buildCapture(
  lease: Lease,
  childSessionId: string,
  assistant: RecordValue,
  payloadText: string,
): ReviewMessageCapture {
  return ReviewMessageCapture.parse({
    childSessionId,
    obligationId: lease.obligationId,
    attemptId: lease.attemptId,
    requestMessageId: lease.requestMessageId,
    responseMessageId: assistant.id,
    requestDigest: lease.requestDigest,
    payloadText,
    payloadDigest: hashText(payloadText),
    model: lease.model,
    assistantMessageIds: [assistant.id],
  });
}

function buildProvenance(
  lease: Lease,
  capture: ReviewMessageCapture,
  assistant: RecordValue,
  history: readonly unknown[],
): NativeSubagentCaptureProvenance {
  return NativeSubagentCaptureProvenance.parse({
    schemaVersion: 1,
    nativeCallId: lease.nativeCallId,
    requestMessageId: capture.requestMessageId,
    responseMessageId: capture.responseMessageId,
    requestDigest: capture.requestDigest,
    payloadDigest: capture.payloadDigest,
    model: capture.model,
    assistantMessageIds: [capture.responseMessageId],
    terminal: {
      outcome: 'succeeded',
      finish: 'stop',
      completedAt: new Date(Number(record(assistant.time).completed)).toISOString(),
    },
    modelRequest: { kind: 'primary', model: capture.model },
    historyDigest: hashText(canonicalJsonStringify(history)),
    userMessageCount: 1,
    toolAttemptCount: 0,
  });
}

export interface NativeCaptureInput {
  readonly initial: NativeReviewInitialController;
  readonly host: NativeCaptureHost;
  readonly fence: NativeReviewCaptureFence;
  readonly runtime: NativeCaptureRuntime;
  readonly sessDir: string;
  readonly parentSessionId: string;
  readonly childSessionId: string;
  readonly nativeCallId: string;
  readonly state: SessionState;
  readonly obligation: ReviewObligation;
  readonly attempt: ReviewAttempt;
}

export type NativeCaptureOutcome =
  | {
      readonly kind: 'fulfilled';
      readonly findings: Record<string, unknown>;
      readonly verdict: string;
    }
  | { readonly kind: 'blocked'; readonly code: string; readonly reason: string };

/**
 * Execute exactly one serialization window against the already-bound child and
 * bind the validated findings atomically. Every failure returns a typed blocker;
 * no failure path writes an invocation.
 */
export async function executeNativeReviewCapture(
  input: NativeCaptureInput,
): Promise<NativeCaptureOutcome> {
  let leaseId: string | undefined;
  try {
    const start = await startSerialization(input);
    leaseId = start.lease.leaseId;
    await input.host.prompt({
      sessionID: input.childSessionId,
      id: start.lease.requestMessageId,
      text: start.promptText,
    });
    await input.host.wait(input.childSessionId);
    const history = await input.host.context(input.childSessionId);
    const proof = input.fence.verify(
      input.childSessionId,
      start.lease.leaseId,
      start.reviewed.baseline,
      history,
    );
    const prepared = prepareFindings(input, proof.capture.payloadText);
    if (prepared.kind === 'blocked') return prepared;
    const dispatch = input.state.reviewAssurance?.dispatches.find(
      (item) => item.hostCallId === input.nativeCallId,
    );
    if (!dispatch)
      return {
        kind: 'blocked',
        code: 'REVIEW_ATTEMPT_UNAVAILABLE',
        reason: 'The authorized dispatch disappeared.',
      };
    return await bindNativeSubagentFindings(
      input,
      proof,
      prepared.findings,
      dispatch,
      start.lease.leaseId,
    );
  } catch (error) {
    if (leaseId !== undefined) input.fence.quarantine(input.childSessionId, leaseId);
    input.runtime.logError('native reviewer capture failed', error);
    return {
      kind: 'blocked',
      code:
        error instanceof NativeReviewCaptureOutcomeUnknownError ||
        !(error instanceof NativeReviewCaptureError)
          ? 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN'
          : 'REVIEWER_CAPTURE_PROVENANCE_INVALID',
      reason: error instanceof Error ? error.message : 'Reviewer serialization outcome is unknown.',
    };
  } finally {
    if (leaseId !== undefined) input.fence.release(input.childSessionId, leaseId);
  }
}

async function startSerialization(input: NativeCaptureInput): Promise<{
  readonly reviewed: ReturnType<NativeReviewInitialController['complete']>;
  readonly lease: ReturnType<NativeReviewCaptureFence['begin']>;
  readonly promptText: string;
}> {
  const initial = await input.host.context(input.childSessionId);
  const dispatch = input.state.reviewAssurance?.dispatches.find(
    (item) => item.hostCallId === input.nativeCallId,
  );
  const reviewed = input.initial.complete(
    input.childSessionId,
    initial,
    dispatch?.canonicalPromptDigest ?? '',
  );
  const contract = obligationCaptureContract(input.state, input.obligation);
  const promptText = serializationPromptFor(
    input.obligation.obligationId,
    buildObligationFindingsJsonSchema(contract),
  );
  const lease = input.fence.begin({
    childSessionId: input.childSessionId,
    nativeCallId: input.nativeCallId,
    obligationId: input.obligation.obligationId,
    attemptId: input.attempt.attemptId,
    model: reviewed.model,
    requestMessageId: input.host.mintRequestMessageId(),
    requestText: promptText,
  });
  return { reviewed, lease, promptText };
}

function prepareFindings(
  input: NativeCaptureInput,
  payloadText: string,
): NativeCaptureOutcome | { readonly kind: 'ok'; readonly findings: Record<string, unknown> } {
  const decoded = parseStrictJsonObject(payloadText);
  if (decoded.kind !== 'ok')
    return { kind: 'blocked', code: 'HOST_STRUCTURED_OUTPUT_REQUIRED', reason: decoded.reason };
  const prepared = prepareReviewerFindingsForValidation({
    rawFindings: decoded.value,
    obligationId: input.obligation.obligationId,
    hostConstants: {
      mandateDigest: input.obligation.mandateDigest,
      criteriaVersion: input.obligation.criteriaVersion,
    },
    hostProvenance: {
      childSessionId: input.childSessionId,
      reviewedAt: new Date().toISOString(),
    },
  });
  if (!prepared.ok)
    return {
      kind: 'blocked',
      code: 'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION',
      reason: prepared.issues.join('; '),
    };
  const validation = validateCapturedFindings(input.state, input.obligation, prepared.findings);
  return validation.kind === 'valid'
    ? { kind: 'ok', findings: prepared.findings }
    : { kind: 'blocked', code: validation.code, reason: validation.reason };
}

async function bindNativeSubagentFindings(
  input: NativeCaptureInput,
  proof: ReturnType<NativeReviewCaptureFence['verify']>,
  findings: Record<string, unknown>,
  dispatch: NonNullable<SessionState['reviewAssurance']>['dispatches'][number],
  leaseId: string,
): Promise<NativeCaptureOutcome> {
  const findingsHash = hashFindings(findings);
  const result = await recordEvidenceOrBlockReuse(input.runtime.orchestratorDeps, input.sessDir, {
    obligationId: input.obligation.obligationId,
    obligationType: input.obligation.obligationType,
    sessionId: input.parentSessionId,
    childSessionId: input.childSessionId,
    hostCallId: input.nativeCallId,
    attemptId: input.attempt.attemptId,
    promptHash: dispatch.canonicalPromptDigest,
    findingsHash,
    invokedAt: dispatch.dispatchAuthorizedAt,
    fulfilledAt: new Date().toISOString(),
    deadlineAt: new Date(
      Date.parse(dispatch.dispatchAuthorizedAt) +
        (input.runtime.reviewerExecutionTimeoutMs ?? 600_000),
    ).toISOString(),
    executionFailed: () => !input.fence.isActive(input.childSessionId, leaseId),
    reviewerResult: {
      sessionId: input.childSessionId,
      findings,
      reviewOutputMode: 'validated_json',
      reviewAssuranceLevel: 'host_message_validated',
      capture: proof.capture,
    },
    nativeProvenance: proof.provenance,
    semanticIntents: nativeReviewAuditIntents({
      obligation: input.obligation,
      parentSessionId: input.parentSessionId,
      childSessionId: input.childSessionId,
      attemptId: input.attempt.attemptId,
      promptHash: dispatch.canonicalPromptDigest,
      findingsHash,
      phase: input.state.phase,
    }),
  });
  if (result !== 'fulfilled')
    return {
      kind: 'blocked',
      code: result === 'reused' ? 'SUBAGENT_EVIDENCE_REUSED' : 'REVIEW_ATTEMPT_UNAVAILABLE',
      reason: `Reviewer evidence binding returned ${result}.`,
    };
  return {
    kind: 'fulfilled',
    findings,
    verdict: String(findings.overallVerdict),
  };
}

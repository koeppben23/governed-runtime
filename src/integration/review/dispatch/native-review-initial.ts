/** Initial-review provenance: one observed primary request per assistant step.
 * History is checked against live hook receipts, never used to create authority.
 * Restart cannot reconstruct these receipts from a transcript. */
import { canonicalJsonStringify } from '../../../shared/canonical-json.js';
import { hashText } from '../../../shared/hashing.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../../shared/flowguard-identifiers.js';
import { ReviewerModelSelection } from '../../../state/review-message-capture.js';
import { buildEnforcementError } from '../../blocked-result.js';
import { READ_ONLY_HOST_TOOLS } from '../../phase-tool-gate.js';
import { TOOL_FLOWGUARD_OBSERVE_REPOSITORY } from '../../tool-names.js';

/** Initial investigation only; serialization rejects every tool, including observations. */
export function isInitialReviewerTool(tool: string): boolean {
  return READ_ONLY_HOST_TOOLS.has(tool) || tool === TOOL_FLOWGUARD_OBSERVE_REPOSITORY;
}

type Row = Record<string, unknown>;
function row(value: unknown): Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
}
const PREFIX = 'You are a subagent spawned by another session.\n';
const MAX_MESSAGES = 10_000;
type ToolReceipt = {
  readonly id: string;
  readonly messageID: string;
  readonly tool: string;
  readonly inputDigest: string;
  status?: 'completed' | 'error';
  /** Digest of the exact result FlowGuard observed at its own after-hook position. */
  resultDigest?: string;
};
/** Native completion facts a receipt binds; result/error are host-observed values. */
export type InitialToolCompletion = InitialToolBoundary & {
  readonly status: 'completed' | 'error';
  readonly result?: unknown;
  readonly error?: unknown;
};
export type InitialToolBoundary = {
  readonly sessionID: string;
  readonly messageID: string;
  readonly id: string;
  readonly tool: string;
  readonly agent: string;
  readonly input: unknown;
};
type Step = {
  readonly model: ReviewerModelSelection;
  readonly tools: Map<string, ToolReceipt>;
};
type Run = {
  readonly requestId: string;
  readonly text: string;
  prefix: readonly unknown[];
  contextDigest?: string;
  step?: Step;
  /** Effective model/variant of the first step; every later step must match it. */
  model?: ReviewerModelSelection;
  sealed: boolean;
  violation?: string;
};

function digest(value: unknown): string {
  return hashText(canonicalJsonStringify(value));
}
function selectedModel(value: unknown): ReviewerModelSelection {
  const model = row(value);
  const parsed = ReviewerModelSelection.safeParse({
    providerID: model.providerID,
    modelID: model.id,
    variant: model.variant ?? null,
  });
  if (!parsed.success) reject(undefined, 'Reviewer model identity is unavailable.');
  return parsed.data;
}
function reject(run: Run | undefined, reason: string): never {
  if (run) run.violation ??= reason;
  throw buildEnforcementError('REVIEWER_COMPLETION_UNVERIFIABLE', reason);
}

/** Lives in the existing capture composition. No reviewer execution or recovery. */
export class NativeReviewInitialController {
  private readonly runs = new Map<string, Run>();

  admit(child: string, requestId: string, text: string): void {
    const existing = this.runs.get(child);
    if (existing) reject(existing, 'An initial reviewer request cannot be continued or replayed.');
    if (!requestId.startsWith('msg') || !text.startsWith(PREFIX))
      reject(undefined, 'The initial reviewer request has no exact native identity/prefix.');
    this.runs.set(child, { requestId, text, prefix: [], sealed: false });
  }

  private require(child: string): Run {
    const run = this.runs.get(child);
    if (!run) reject(undefined, 'Live initial-review hook receipts are unavailable.');
    if (run.sealed || run.violation)
      reject(run, run.violation ?? 'Initial reviewer execution is already sealed.');
    return run;
  }

  context(child: string, history: readonly unknown[]): void {
    const run = this.require(child);
    if (!Array.isArray(history) || history.length > MAX_MESSAGES)
      reject(run, 'Initial reviewer history is missing or unbounded.');
    if (run.contextDigest !== undefined)
      reject(run, 'Concurrent or repeated initial reviewer context.');
    if (run.step) this.settle(run, history, false);
    else this.initialUser(run, history);
    run.contextDigest = digest(history);
  }

  request(child: string, history: readonly unknown[], model: unknown): void {
    const run = this.require(child);
    if (run.contextDigest === undefined || digest(history) !== run.contextDigest)
      reject(run, 'Primary reviewer request has no exact preceding context.');
    delete run.contextDigest;
    const selected = selectedModel(model);
    // Evidence binds one effective model/variant. An unproved mid-review switch
    // cannot be represented by that binding and invalidates assurance (ADR-010 D5).
    if (run.model !== undefined && digest(run.model) !== digest(selected))
      reject(run, 'The effective reviewer model or variant changed between review steps.');
    run.model = selected;
    run.prefix = structuredClone(history);
    run.step = { model: selected, tools: new Map() };
  }

  beforeTool(event: InitialToolBoundary): void {
    const run = this.require(event.sessionID);
    const step = run.step;
    if (
      !step ||
      run.contextDigest !== undefined ||
      event.agent !== REVIEWER_SUBAGENT_TYPE ||
      !isInitialReviewerTool(event.tool) ||
      !event.messageID.startsWith('msg') ||
      !event.id ||
      step.tools.has(event.id)
    )
      reject(run, 'Tool execution has no unique authorized initial reviewer step.');
    if ([...step.tools.values()].some((tool) => tool.messageID !== event.messageID))
      reject(run, 'Tool calls from different assistant messages cannot share a reviewer step.');
    step.tools.set(event.id, {
      id: event.id,
      messageID: event.messageID,
      tool: event.tool,
      inputDigest: digest(event.input),
    });
  }

  afterTool(event: InitialToolCompletion): void {
    const run = this.require(event.sessionID);
    const receipt = run.step?.tools.get(event.id);
    if (
      !receipt ||
      receipt.status !== undefined ||
      receipt.messageID !== event.messageID ||
      receipt.tool !== event.tool ||
      event.agent !== REVIEWER_SUBAGENT_TYPE ||
      receipt.inputDigest !== digest(event.input)
    )
      reject(run, 'Initial reviewer tool completion has no exact admitted call.');
    receipt.status = event.status;
    receipt.resultDigest = completionDigest(event);
  }

  /**
   * Tail check registered after every setup-time hook: a result replaced by a
   * later after-hook no longer matches the receipt and invalidates the run.
   */
  afterToolTail(event: InitialToolCompletion): void {
    const run = this.runs.get(event.sessionID);
    if (!run || run.sealed) return;
    const receipt = run.step?.tools.get(event.id);
    if (!receipt || receipt.resultDigest !== completionDigest(event))
      reject(run, 'A reviewer tool result was replaced after FlowGuard observed it.');
  }

  /** Mark the active run invalid from an out-of-band integrity check. */
  violate(child: string, reason: string): never {
    return reject(this.runs.get(child), reason);
  }
  complete(child: string, history: readonly unknown[], promptDigest: string) {
    const run = this.require(child);
    if (!Array.isArray(history)) reject(run, 'Initial reviewer history is missing.');
    if (hashText(run.text.slice(PREFIX.length)) !== promptDigest)
      reject(run, 'The initial reviewer prompt no longer matches the authorized dispatch.');
    if (run.contextDigest !== undefined)
      reject(run, 'Initial reviewer context was never released.');
    const model = this.settle(run, history, true);
    run.sealed = true;
    return { baseline: history, model };
  }

  private initialUser(run: Run, history: readonly unknown[]): void {
    const user = row(history[0]);
    if (
      history.length !== 1 ||
      user.type !== 'user' ||
      user.id !== run.requestId ||
      user.text !== run.text ||
      ['files', 'agents', 'skills'].some(
        (key) => user[key] !== undefined && (!Array.isArray(user[key]) || user[key].length !== 0),
      )
    )
      reject(run, 'Initial reviewer history is not exactly the admitted user request.');
  }

  private settle(run: Run, history: readonly unknown[], terminal: boolean): ReviewerModelSelection {
    const step = run.step;
    if (!step) reject(run, 'An assistant step has no observed primary model request.');
    if (
      history.length > MAX_MESSAGES ||
      history.length !== run.prefix.length + (terminal ? 2 : 1) ||
      digest(history.slice(0, run.prefix.length)) !== digest(run.prefix)
    )
      reject(run, 'Reviewer history changed or contains unexplained extra entries.');
    const assistant = row(history[run.prefix.length]);
    this.assistant(run, step, assistant, terminal);
    if (terminal) {
      const idle = row(history.at(-1));
      if (idle.type !== 'idle' || idle.outcome !== 'succeeded' || idle.error !== undefined)
        reject(run, 'Initial reviewer execution has no successful terminal boundary.');
    }
    delete run.step;
    return step.model;
  }

  private assistant(run: Run, step: Step, assistant: Row, terminal: boolean): void {
    this.assistantIdentity(run, step, assistant);
    if (
      assistant.finish !== (terminal ? 'stop' : 'tool-calls') ||
      !Array.isArray(assistant.content)
    )
      reject(run, 'Reviewer assistant is not the observed model step/completion.');
    const tools = assistant.content.filter((part) => row(part).type === 'tool');
    if (
      (terminal && tools.length !== 0) ||
      (!terminal && tools.length === 0) ||
      tools.length !== step.tools.size
    )
      reject(run, 'Reviewer continuation does not have exact authorized tool receipts.');
    const ids = new Set<string>();
    for (const part of assistant.content) {
      const value = row(part);
      if (value.type === 'tool') {
        this.tool(run, step, String(assistant.id), value, ids);
      } else if (!validContent(value)) reject(run, 'Unexplained initial reviewer content.');
    }
  }

  private assistantIdentity(run: Run, step: Step, assistant: Row): void {
    if (
      assistant.type !== 'assistant' ||
      typeof assistant.id !== 'string' ||
      !assistant.id.startsWith('msg') ||
      assistant.agent !== REVIEWER_SUBAGENT_TYPE ||
      run.prefix.some((entry) => row(entry).id === assistant.id) ||
      assistant.error !== undefined ||
      assistant.retry !== undefined ||
      !Number.isFinite(row(assistant.time).completed) ||
      digest(selectedModel(assistant.model)) !== digest(step.model)
    )
      reject(run, 'Reviewer assistant is not the observed model step/completion.');
  }

  private tool(run: Run, step: Step, message: string, tool: Row, ids: Set<string>): void {
    const receipt = typeof tool.id === 'string' ? step.tools.get(tool.id) : undefined;
    const state = row(tool.state);
    if (
      !receipt ||
      ids.has(receipt.id) ||
      receipt.messageID !== message ||
      receipt.tool !== tool.name ||
      receipt.status === undefined ||
      state.status !== receipt.status ||
      digest(state.input) !== receipt.inputDigest ||
      tool.executed === true
    )
      reject(run, 'Reviewer tool history has no matching local before/after authorization.');
    ids.add(receipt.id);
  }
}

function validContent(value: Row): boolean {
  if (value.type === 'step-start' || value.type === 'step-finish') return true;
  return (
    (value.type === 'text' || value.type === 'reasoning') &&
    typeof value.text === 'string' &&
    value.synthetic !== true &&
    value.ignored !== true
  );
}

function completionDigest(event: InitialToolCompletion): string {
  return event.status === 'completed'
    ? digest({ status: 'completed', result: row(event.result) })
    : digest({ status: 'error', error: event.error ?? null });
}

/** Model-input projection of one stored native tool part (host to-llm-message mapping). */
function modelToolResult(tool: Row): unknown {
  const state = row(tool.state);
  if (state.status === 'error') return { error: state.error, content: state.content ?? [] };
  if (state.status !== 'completed' || !Array.isArray(state.content)) return undefined;
  const [single] = state.content;
  return state.content.length === 1 && row(single).type === 'text'
    ? { type: 'text', value: row(single).text }
    : { type: 'content', value: state.content };
}

/**
 * Compare every tool result offered to the reviewer model with the stored host
 * history. Returns the violation, or null when each result is exactly the
 * host-derived projection of its stored native tool part.
 */
export function toolResultMismatch(
  messages: readonly unknown[],
  history: readonly unknown[],
): string | null {
  const stored = new Map<string, unknown>();
  for (const part of history.flatMap(contentParts))
    if (part.type === 'tool' && typeof part.id === 'string')
      stored.set(part.id, modelToolResult(part));
  for (const part of messages.flatMap(contentParts)) {
    if (part.type !== 'tool-result') continue;
    const expected = typeof part.id === 'string' ? stored.get(part.id) : undefined;
    if (expected === undefined || !sameValue(part.result, expected))
      return 'A reviewer model-input tool result differs from the stored host tool history.';
  }
  return null;
}

function contentParts(entry: unknown): Row[] {
  const content = row(entry).content;
  return Array.isArray(content) ? content.map(row) : [];
}

function sameValue(left: unknown, right: unknown): boolean {
  try {
    return canonicalJsonStringify(left) === canonicalJsonStringify(right);
  } catch {
    return false;
  }
}

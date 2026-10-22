/**
 * @module integration/reviewer-execution-watchdog
 * @description Bounded reviewer execution watchdog. It observes the exact
 * reviewer child session and enforces nested tool, review, serialization and
 * absolute deadlines. Expiry requests host abort and persists a terminal
 * failure; an unconfirmed host outcome is never treated as success.
 */

import type { FlowGuardConfig } from '../config/flowguard-config.js';
import type {
  OrchestratorClient,
  ReviewerExecutionFailure,
  ReviewerExecutionFailureCode,
} from './review/types.js';

type Phase = ReviewerExecutionFailure['phase'];
type Timer = ReturnType<typeof setTimeout>;

function timer(callback: () => void, ms: number): Timer {
  const value = setTimeout(callback, ms);
  // The plugin lifecycle must not be kept alive solely by a watchdog.
  value.unref?.();
  return value;
}

interface Entry {
  readonly parentSessionId?: string;
  readonly callId?: string;
  childSessionId?: string;
  readonly timers: { review?: Timer; serialization?: Timer; total: Timer };
  readonly toolTimers: Map<string, Timer>;
  expired: boolean;
}

export interface ReviewerExecutionWatchdogDeps {
  readonly config: Pick<
    FlowGuardConfig['reviewer'],
    'toolTimeoutMs' | 'reviewTimeoutMs' | 'serializationTimeoutMs' | 'executionTimeoutMs'
  >;
  readonly client: OrchestratorClient;
  readonly log: {
    info(service: string, message: string, extra?: Record<string, unknown>): void;
    warn(service: string, message: string, extra?: Record<string, unknown>): void;
    error(service: string, message: string, extra?: Record<string, unknown>): void;
  };
  readonly persistFailure: (
    failure: ReviewerExecutionFailure,
    childSessionId: string,
  ) => Promise<boolean>;
  /** Persist a timeout before the child identity was ever observed. */
  readonly persistTaskFailure?: (
    failure: ReviewerExecutionFailure,
    parentSessionId: string,
    callId: string,
  ) => Promise<boolean>;
  readonly failures?: Map<string, ReviewerExecutionFailure>;
}

/**
 * A child is registered on its first reviewer model request. The deadline is
 * not reset for the same-child serialization request.
 */
export class ReviewerExecutionWatchdog {
  private readonly entries = new Map<string, Entry>();
  private readonly tasks = new Map<string, Entry>();

  constructor(private readonly deps: ReviewerExecutionWatchdogDeps) {}

  /** Start the absolute deadline at durable dispatch authorization. */
  onTaskAuthorized(parentSessionId: string, callId: string): void {
    if (this.tasks.has(callId)) return;
    const entry: Entry = {
      parentSessionId,
      callId,
      timers: {
        total: timer(() => void this.expireTask(callId), this.deps.config.executionTimeoutMs),
      },
      toolTimers: new Map(),
      expired: false,
    };
    this.tasks.set(callId, entry);
    this.deps.log.info('review', 'reviewer dispatch deadline started', {
      parentSessionId,
      callId,
      executionTimeoutMs: this.deps.config.executionTimeoutMs,
    });
  }

  /** Attach the exact child observed by the host; do not reset the absolute timer. */
  async onReviewerRequest(childSessionId: string): Promise<void> {
    if (this.entries.has(childSessionId)) return;
    const parentSessionId = await this.resolveParentSession(childSessionId);
    const task = parentSessionId
      ? await this.findExactTask(parentSessionId, childSessionId)
      : undefined;
    if (task) {
      task.childSessionId = childSessionId;
      task.timers.review = timer(
        () => void this.expire(childSessionId, 'review'),
        this.deps.config.reviewTimeoutMs,
      );
      this.entries.set(childSessionId, task);
      this.deps.log.info('review', 'reviewer child attached to dispatch deadline', {
        parentSessionId,
        childSessionId,
        reviewTimeoutMs: this.deps.config.reviewTimeoutMs,
      });
      return;
    }
    this.deps.log.error('review', 'reviewer child has no exact task dispatch mapping', {
      childSessionId,
      parentSessionId,
      pendingTasks: this.tasks.size,
    });
  }

  /** Resolve parent identity with get first, then a list fallback for creation races. */
  private async resolveParentSession(childSessionId: string): Promise<string | undefined> {
    const session = this.deps.client.session;
    let getReason = 'unavailable';
    if (typeof session.get === 'function') {
      try {
        const response = await session.get({ path: { id: childSessionId } });
        const parent = response.data?.parentID;
        if (parent) return parent;
        getReason = response.error ? 'error' : 'missing_parent';
      } catch (err) {
        getReason = err instanceof Error ? err.message : 'error';
      }
    }
    if (typeof session.list === 'function') {
      try {
        const response = await session.list();
        const parent = response.data?.find((item) => item.id === childSessionId)?.parentID;
        if (parent) return parent;
      } catch {
        // Fall through to the diagnostic below.
      }
    }
    this.deps.log.warn('review', 'reviewer parent session could not be resolved', {
      childSessionId,
      getReason,
      hasList: typeof session.list === 'function',
    });
    return undefined;
  }

  /** Resolve the task release by the parent-recorded Task call metadata, never by order. */
  private async findExactTask(
    parentSessionId: string,
    childSessionId: string,
  ): Promise<Entry | undefined> {
    const candidates = [...this.tasks.values()].filter(
      (candidate) =>
        candidate.parentSessionId === parentSessionId &&
        !candidate.childSessionId &&
        !candidate.expired,
    );
    if (candidates.length === 0) return undefined;
    const session = this.deps.client.session;
    if (typeof session.messages !== 'function') return undefined;
    try {
      const response = await session.messages({ path: { id: parentSessionId } });
      const callIds = new Set(
        (response.data ?? []).flatMap((message) =>
          (message.parts ?? []).flatMap((part) => {
            if (part.type !== 'tool' || part.state?.metadata?.sessionId !== childSessionId)
              return [];
            // OpenCode exposes both the Task part id and callID. The live host
            // passes callID to the before-hook; older/other Task paths pass id.
            // Accept only a unique exact match against either observed field.
            return [part.callID, part.id].filter(
              (value): value is string => typeof value === 'string',
            );
          }),
        ),
      );
      const matches = candidates.filter(
        (candidate) => candidate.callId && callIds.has(candidate.callId),
      );
      return matches.length === 1 ? matches[0] : undefined;
    } catch {
      return undefined;
    }
  }

  onToolStart(childSessionId: string, callId: string | undefined): void {
    const entry = this.entries.get(childSessionId);
    if (!entry || entry.expired || !callId) return;
    const existing = entry.toolTimers.get(callId);
    if (existing) clearTimeout(existing);
    const toolTimer = timer(
      () => void this.expire(childSessionId, 'tool'),
      this.deps.config.toolTimeoutMs,
    );
    entry.toolTimers.set(callId, toolTimer);
  }

  onToolEnd(childSessionId: string, callId: string | undefined): void {
    const entry = this.entries.get(childSessionId);
    if (!entry || !callId) return;
    const timer = entry.toolTimers.get(callId);
    if (timer) clearTimeout(timer);
    entry.toolTimers.delete(callId);
  }

  /** The review phase ended; the remaining absolute budget covers serialization. */
  onSerializationStart(childSessionId: string): void {
    const entry = this.entries.get(childSessionId);
    if (!entry || entry.expired) return;
    if (entry.timers.review) clearTimeout(entry.timers.review);
    delete entry.timers.review;
    if (!entry.timers.serialization) {
      entry.timers.serialization = timer(
        () => void this.expire(childSessionId, 'serialization'),
        this.deps.config.serializationTimeoutMs,
      );
    }
  }

  /** Normal after-hook completion cancels all deadlines. */
  complete(childSessionId: string): void {
    const entry = this.entries.get(childSessionId);
    if (!entry) return;
    this.clear(entry);
    this.entries.delete(childSessionId);
    if (entry.callId) this.tasks.delete(entry.callId);
  }

  /** The native Task completed; clear its dispatch timer even without child attachment. */
  completeTask(callId: string): boolean {
    const task = this.tasks.get(callId);
    if (!task) return false;
    this.clear(task);
    this.tasks.delete(callId);
    if (task.childSessionId) this.entries.delete(task.childSessionId);
    return true;
  }

  /** Complete a Task only after an exact call-ID hit; the parent fallback is last resort. */
  finishTask(input: {
    readonly callId?: string;
    readonly parentSessionId: string;
    readonly childSessionId?: string;
  }): void {
    if (input.callId && this.completeTask(input.callId)) return;
    this.completeTaskForParent(input.parentSessionId, input.childSessionId);
  }

  /** Clear the sole pending dispatch for a parent when the host call IDs differ. */
  completeTaskForParent(parentSessionId: string, childSessionId?: string): boolean {
    const pending = [...this.tasks.entries()].filter(([, task]) => {
      if (task.parentSessionId !== parentSessionId) return false;
      if (task.childSessionId && childSessionId) {
        return task.childSessionId === childSessionId;
      }
      return task.childSessionId === undefined;
    });
    if (pending.length !== 1) return false;
    const entry = pending[0];
    return entry ? this.completeTask(entry[0]) : false;
  }

  private clear(entry: Entry): void {
    if (entry.timers.review) clearTimeout(entry.timers.review);
    if (entry.timers.serialization) clearTimeout(entry.timers.serialization);
    clearTimeout(entry.timers.total);
    for (const timer of entry.toolTimers.values()) clearTimeout(timer);
    entry.toolTimers.clear();
  }

  private async expireTask(callId: string): Promise<void> {
    const entry = this.tasks.get(callId);
    if (!entry || entry.expired) return;
    if (entry.childSessionId) {
      await this.expire(entry.childSessionId, 'total');
      return;
    }
    entry.expired = true;
    this.clear(entry);
    const failure: ReviewerExecutionFailure = {
      code: 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
      phase: 'total',
      abortConfirmed: false,
      reason:
        'Reviewer dispatch exceeded the absolute deadline before a child session was observed.',
    };
    let persisted = false;
    if (this.deps.persistTaskFailure && entry.parentSessionId && entry.callId) {
      try {
        persisted = await this.deps.persistTaskFailure(
          failure,
          entry.parentSessionId,
          entry.callId,
        );
      } catch (err) {
        this.deps.log.error('review', 'reviewer dispatch timeout persistence failed', {
          parentSessionId: entry.parentSessionId,
          callId: entry.callId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (!persisted) this.deps.failures?.set(`task:${callId}`, failure);
    this.deps.log.error('review', 'reviewer dispatch deadline exceeded', {
      parentSessionId: entry.parentSessionId,
      callId,
      persisted,
    });
  }

  // eslint-disable-next-line complexity -- phase handling is intentionally fail-closed.
  private async expire(childSessionId: string, phase: Phase): Promise<void> {
    const entry = this.entries.get(childSessionId);
    if (!entry || entry.expired) return;
    entry.expired = true;
    this.clear(entry);

    let acknowledged = false;
    const session = this.deps.client.session;
    if (typeof session.abort === 'function') {
      try {
        const response = await session.abort({ path: { id: childSessionId } });
        acknowledged = response.data === true;
      } catch (err) {
        this.deps.log.warn('review', 'reviewer host abort failed', {
          childSessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      this.deps.log.warn('review', 'reviewer host abort unavailable', { childSessionId });
    }

    const confirmed = acknowledged && (await this.confirmTerminal(childSessionId));
    const code: ReviewerExecutionFailureCode = confirmed
      ? 'REVIEWER_EXECUTION_TIMEOUT'
      : 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN';
    const failure: ReviewerExecutionFailure = {
      code,
      phase,
      abortConfirmed: confirmed,
      reason: confirmed
        ? `Reviewer exceeded the ${phase} deadline and the host confirmed termination.`
        : `Reviewer exceeded the ${phase} deadline; host termination could not be confirmed.`,
    };
    let persisted = false;
    try {
      persisted = await this.deps.persistFailure(failure, childSessionId);
    } catch (err) {
      this.deps.log.error('review', 'reviewer execution failure persistence failed', {
        childSessionId,
        code,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (!persisted) this.deps.failures?.set(childSessionId, failure);
    this.deps.log.error('review', 'reviewer execution deadline exceeded', {
      childSessionId,
      code,
      phase,
      abortAcknowledged: acknowledged,
      abortConfirmed: confirmed,
      persisted,
    });
  }

  // eslint-disable-next-line complexity -- quiescence requires all positive host signals.
  private async confirmTerminal(childSessionId: string): Promise<boolean> {
    const session = this.deps.client.session;
    if (typeof session.messages !== 'function') return false;
    if (typeof session.status !== 'function') return false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const [status, history] = await Promise.all([
          session.status(),
          session.messages({ path: { id: childSessionId } }),
        ]);
        if (status.error || !status.data) return false;
        const hostState = status.data[childSessionId]?.type ?? 'idle';
        if (hostState !== 'idle') return false;
        const messages = history.data;
        if (!Array.isArray(messages) || messages.length === 0) return false;
        const running = messages.some((message) =>
          (message.parts ?? []).some(
            (part) =>
              part.type === 'tool' &&
              (part.state?.status === 'running' || part.state?.status === 'pending'),
          ),
        );
        if (running) return false;
        const assistants = messages.filter((message) => message.info?.role === 'assistant');
        const last = assistants.at(-1);
        if (!last || (!last.info?.finish && !last.info?.error)) return false;
      } catch {
        return false;
      }
    }
    return true;
  }
}

export function createReviewerExecutionWatchdog(
  deps: ReviewerExecutionWatchdogDeps,
): ReviewerExecutionWatchdog {
  return new ReviewerExecutionWatchdog(deps);
}

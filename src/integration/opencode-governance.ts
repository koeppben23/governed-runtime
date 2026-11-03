/** Native opt-in/scope boundary. Successful private-store absence is not a
 * workflow-state heuristic. Parent metadata alone never enrolls a descendant. */
import * as path from 'node:path';
import type { Plugin } from '@opencode/plugin';
import type { OpenCodeEvent } from '@opencode/client';
import {
  commitGovernanceActivation,
  governanceDelegationKey,
  resolveGovernanceActivation,
  type GovernanceActivationStore,
  type GovernanceActivationResolution,
} from '../adapters/governance-activation.js';
import { acquireNamedWriteLock } from '../adapters/persistence-lock.js';
import { workspacesHome, validateSessionId } from '../adapters/workspace/index.js';
import { blocked } from '../config/reasons.js';
import {
  GovernanceDelegationDispatch,
  type GovernanceActivationRevision,
} from '../state/governance-activation.js';
import { hashText } from '../shared/hashing.js';
import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';
import type { OpenCodeHostAdapter } from './opencode-host-adapter.js';
import { buildEnforcementError } from './blocked-result.js';

export interface ActiveGovernanceScope {
  readonly sessionId: string;
  readonly record: GovernanceActivationRevision;
  readonly root: GovernanceActivationRevision;
}
export type NativeGovernanceResolution =
  | { readonly kind: 'inactive' }
  | { readonly kind: 'active'; readonly scope: ActiveGovernanceScope }
  | ReturnType<typeof blocked>;

type EnrollmentWaiter = {
  readonly rootId: string;
  readonly dispatchKey: string | undefined;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
};
export type NativeBefore = Parameters<Parameters<Plugin.Context['tool']['hook']>[1]>[0] & {
  readonly input: unknown;
};

/** Consumes the canonical independent-review ledger; delegation alone is never review authority. */
export interface NativeReviewerAuthority {
  authorize(scope: ActiveGovernanceScope, event: NativeBefore): Promise<void>;
  bind(
    scope: ActiveGovernanceScope,
    dispatch: GovernanceDelegationDispatch,
    childId: string,
  ): Promise<void>;
  validate(scope: ActiveGovernanceScope): Promise<void>;
}

export class OpenCodeGovernance {
  readonly store: GovernanceActivationStore;
  private readonly dispatches = new Map<string, GovernanceDelegationDispatch>();
  private readonly linking = new Map<
    string,
    { readonly dispatchKey: string; readonly operation: Promise<void> }
  >();
  private readonly dispatchChildren = new Map<string, string>();
  private readonly settledDispatches = new Set<string>();
  private readonly waiters = new Map<string, Set<EnrollmentWaiter>>();

  constructor(
    context: Plugin.Context,
    private readonly host: OpenCodeHostAdapter,
    private readonly signal: AbortSignal,
    private readonly reviewer?: NativeReviewerAuthority,
  ) {
    this.store = context.storage;
    signal.addEventListener('abort', () => this.failPending('The governance adapter stopped.'), {
      once: true,
    });
  }

  async resolve(
    sessionId: string,
    ancestors: ReadonlySet<string> = new Set(),
    waitForEnrollment = true,
  ): Promise<NativeGovernanceResolution> {
    validateSessionId(sessionId);
    if (ancestors.has(sessionId) || ancestors.size >= 64)
      return this.block('Cyclic or excessive native session ancestry.');
    const nextAncestors = new Set([...ancestors, sessionId]);
    const own = await resolveGovernanceActivation(this.store, sessionId);
    if (own.kind === 'blocked') return own;
    const session = await this.host.getSession(sessionId);
    if (own.kind === 'active')
      return this.resolveActive(session, own.record, nextAncestors, waitForEnrollment);
    if (own.record !== null || session.parentSessionId === undefined) return { kind: 'inactive' };
    return this.resolveUnenrolledChild(
      session,
      session.parentSessionId,
      nextAncestors,
      waitForEnrollment,
    );
  }

  private async resolveUnenrolledChild(
    session: Awaited<ReturnType<OpenCodeHostAdapter['getSession']>>,
    parentId: string,
    ancestors: ReadonlySet<string>,
    waitForEnrollment: boolean,
  ): Promise<NativeGovernanceResolution> {
    const parent = await this.resolve(parentId, ancestors, waitForEnrollment);
    if (parent.kind !== 'active') return parent;
    if (!waitForEnrollment) return this.block('The child has no committed enrollment.');
    if (!this.hasPendingDispatch(parentId))
      return this.block(
        'Native parent lineage exists, but this child was not authorized by a governed subagent dispatch.',
      );
    await this.awaitEnrollment(session.sessionId, parent.scope.root.sessionId);
    const enrolled = await resolveGovernanceActivation(this.store, session.sessionId);
    if (enrolled.kind !== 'active')
      return this.block('The native child has no committed activation-generation enrollment.');
    return this.validateActive(session, enrolled.record, ancestors, waitForEnrollment);
  }

  private async resolveActive(
    session: Awaited<ReturnType<OpenCodeHostAdapter['getSession']>>,
    record: GovernanceActivationRevision,
    ancestors: ReadonlySet<string>,
    waitForEnrollment: boolean,
  ): Promise<NativeGovernanceResolution> {
    const continuation = this.pendingContinuation(session.sessionId);
    if (!continuation) return this.validateActive(session, record, ancestors, waitForEnrollment);
    // A root-lock holder must not wait for an enrollment that needs that lock.
    if (!waitForEnrollment) return this.block('A continuation receipt is still pending.');
    await this.awaitEnrollment(session.sessionId, record.rootSessionId, continuation);
    const fresh = await resolveGovernanceActivation(this.store, session.sessionId);
    if (fresh.kind !== 'active') return this.block('The continued child enrollment is not ACTIVE.');
    return this.validateActive(session, fresh.record, ancestors, waitForEnrollment);
  }

  private async validateActive(
    session: Awaited<ReturnType<OpenCodeHostAdapter['getSession']>>,
    record: GovernanceActivationRevision,
    ancestors: ReadonlySet<string>,
    waitForEnrollment: boolean,
  ): Promise<NativeGovernanceResolution> {
    if (record.directory !== session.directory)
      return this.block('The active host session moved outside its enrolled directory.');
    if (record.rootSessionId === session.sessionId)
      return { kind: 'active', scope: { sessionId: session.sessionId, record, root: record } };
    if (
      record.parentDispatch === null ||
      record.parentDispatch.sessionId !== session.parentSessionId
    )
      return this.block('The child no longer belongs to its authorized parent.');
    if (!(await this.isChildDispatchBound(record, session.agent)))
      return this.block('The child dispatch identity or agent is no longer verifiable.');
    const parent = await this.resolve(
      record.parentDispatch.sessionId,
      ancestors,
      waitForEnrollment,
    );
    if (parent.kind !== 'active')
      return this.block('The enrolled parent is not verifiably ACTIVE.');
    const root = parent;
    if (
      root.scope.root.sessionId !== record.rootSessionId ||
      root.scope.root.activationId !== record.activationId ||
      root.scope.root.generation !== record.generation ||
      root.scope.root.policyDigest !== record.policyDigest ||
      root.scope.root.worktreeRoot !== record.worktreeRoot
    )
      return this.block(
        'The child enrollment belongs to a stale or foreign activation generation.',
      );
    const scope = { sessionId: session.sessionId, record, root: root.scope.root };
    await this.validateReviewer(scope, session.agent);
    return {
      kind: 'active',
      scope,
    };
  }

  private async validateReviewer(
    scope: ActiveGovernanceScope,
    agent: string | undefined,
  ): Promise<void> {
    if (agent !== REVIEWER_SUBAGENT_TYPE) return;
    if (!this.reviewer)
      throw this.error('Reviewer enrollment requires its independent-review dispatch authority.');
    await this.reviewer.validate(scope);
  }

  private async isChildDispatchBound(
    record: GovernanceActivationRevision,
    agent: string | undefined,
  ): Promise<boolean> {
    if (record.parentDispatch === null) return false;
    const dispatch = GovernanceDelegationDispatch.safeParse(
      await this.store.get(
        governanceDelegationKey(
          record.parentDispatch.sessionId,
          record.parentDispatch.messageId,
          record.parentDispatch.callId,
        ),
      ),
    );
    if (
      dispatch.success &&
      dispatch.data.agent === REVIEWER_SUBAGENT_TYPE &&
      !this.dispatches.has(
        governanceDelegationKey(
          record.parentDispatch.sessionId,
          record.parentDispatch.messageId,
          record.parentDispatch.callId,
        ),
      )
    )
      return false; // Reload cannot reconstruct authority to resume an unknown reviewer execution.
    return (
      dispatch.success &&
      dispatch.data.sessionId === record.parentDispatch.sessionId &&
      dispatch.data.messageId === record.parentDispatch.messageId &&
      dispatch.data.callId === record.parentDispatch.callId &&
      dispatch.data.rootSessionId === record.rootSessionId &&
      dispatch.data.agent === agent &&
      dispatch.data.activationId === record.activationId &&
      dispatch.data.generation === record.generation
    );
  }

  async authorizeDispatch(scope: ActiveGovernanceScope, event: NativeBefore): Promise<void> {
    const input = event.input as Record<string, unknown>;
    const parsed = GovernanceDelegationDispatch.safeParse({
      schemaVersion: 1,
      sessionId: event.sessionID,
      messageId: event.messageID,
      callId: event.id,
      rootSessionId: scope.root.sessionId,
      activationId: scope.root.activationId,
      generation: scope.root.generation,
      agent: input.agent,
      requestedChildSessionId: input.sessionID ?? null,
    });
    if (!parsed.success)
      throw this.error(
        'A native subagent dispatch requires exact host call/message identity and a valid agent.',
      );
    const dispatch = parsed.data;
    const key = governanceDelegationKey(dispatch.sessionId, dispatch.messageId, dispatch.callId);
    await this.withLock(scope.root.sessionId, async () => {
      const fresh = await this.resolve(dispatch.sessionId, new Set(), false);
      if (
        fresh.kind !== 'active' ||
        fresh.scope.root.activationId !== scope.root.activationId ||
        fresh.scope.root.generation !== scope.root.generation
      )
        throw this.error('Activation changed before native subagent dispatch.');
      if ((await this.store.get(key)) !== undefined)
        throw this.error('A native subagent call identity cannot be replayed.');
      if (
        dispatch.requestedChildSessionId !== null &&
        this.pendingContinuation(dispatch.requestedChildSessionId)
      )
        throw this.error('The child already has an unsettled continuation dispatch.');
      await this.validateRequestedChild(dispatch);
      if (dispatch.agent === REVIEWER_SUBAGENT_TYPE) {
        if (!this.reviewer)
          throw this.error(
            'Reviewer enrollment requires its independent-review dispatch authority.',
          );
        await this.reviewer.authorize(fresh.scope, event);
      }
      await this.store.set(key, dispatch);
      this.dispatches.set(key, dispatch);
    });
  }

  private async validateRequestedChild(dispatch: GovernanceDelegationDispatch): Promise<void> {
    if (dispatch.requestedChildSessionId === null) return;
    const child = await this.resolve(dispatch.requestedChildSessionId, new Set(), false);
    if (child.kind !== 'active')
      throw this.error('The requested child is not verifiably enrolled.');
    this.validateContinuation(dispatch, child.scope.record);
    const previous = child.scope.record.parentDispatch;
    if (previous !== null) {
      const original = GovernanceDelegationDispatch.safeParse(
        await this.store.get(
          governanceDelegationKey(previous.sessionId, previous.messageId, previous.callId),
        ),
      );
      if (!original.success || original.data.agent === REVIEWER_SUBAGENT_TYPE)
        throw this.error(
          'A reviewer child cannot be continued or reassigned through ordinary delegation.',
        );
    }
  }

  /** Revoke admission, not execution/quiescence certification. The durable
   * release stays unresolved; neither completion text nor an error re-arms it. */
  quarantineReviewerDispatch(event: Pick<NativeBefore, 'sessionID' | 'messageID' | 'id'>): void {
    const key = governanceDelegationKey(event.sessionID, event.messageID, event.id);
    if (this.dispatches.get(key)?.agent !== REVIEWER_SUBAGENT_TYPE) return;
    this.dispatches.delete(key);
    this.settledDispatches.add(key);
  }

  /** Called synchronously by the event-loop consumer before it awaits more I/O. */
  observeProgress(event: OpenCodeEvent): Promise<void> | undefined {
    if (event.type !== 'session.tool.progress') return undefined;
    const dispatchKey = governanceDelegationKey(
      event.data.sessionID,
      event.data.assistantMessageID,
      event.data.id,
    );
    const dispatch = this.dispatches.get(dispatchKey);
    if (!dispatch) return undefined;
    if (this.settledDispatches.has(dispatchKey)) return undefined;
    const childId = event.data.metadata.sessionID;
    if (typeof childId !== 'string' || event.data.metadata.status !== 'running') return undefined;
    const observedChild = this.dispatchChildren.get(dispatchKey);
    if (observedChild !== undefined && observedChild !== childId)
      return Promise.reject(this.error('A native dispatch cannot enroll multiple children.'));
    this.dispatchChildren.set(dispatchKey, childId);
    let linking = this.linking.get(childId);
    if (linking?.dispatchKey !== dispatchKey) {
      const operation = this.withLock(dispatch.rootSessionId, () => this.enroll(dispatch, childId));
      linking = { dispatchKey, operation };
      this.linking.set(childId, linking);
      void operation.then(
        () => {
          this.settledDispatches.add(dispatchKey);
          this.settle(childId, dispatchKey);
        },
        (error) => {
          this.settledDispatches.add(dispatchKey);
          this.settle(childId, dispatchKey, error);
        },
      );
    }
    return linking.operation;
  }

  private async enroll(dispatch: GovernanceDelegationDispatch, childId: string): Promise<void> {
    if (this.signal.aborted) throw this.error('The governance adapter stopped before enrollment.');
    if (dispatch.requestedChildSessionId !== null && dispatch.requestedChildSessionId !== childId)
      throw this.error('Native progress named a child other than the authorized continuation.');
    const parent = await this.resolve(dispatch.sessionId, new Set(), false);
    if (
      parent.kind !== 'active' ||
      parent.scope.root.activationId !== dispatch.activationId ||
      parent.scope.root.generation !== dispatch.generation
    )
      throw this.error('Native progress belongs to an inactive or stale parent generation.');
    const child = await this.host.getSession(childId);
    await this.validateChild(dispatch, parent.scope, child);
    const existing = await resolveGovernanceActivation(this.store, childId);
    const revision = this.enrollmentRevision(dispatch, existing);
    await this.commitEnrollment(dispatch, child, parent.scope.root, revision);
  }

  private enrollmentRevision(
    dispatch: GovernanceDelegationDispatch,
    existing: GovernanceActivationResolution,
  ): number {
    if (existing.kind === 'active') {
      this.validateContinuation(dispatch, existing.record);
      return existing.record.revision;
    }
    if (existing.kind === 'inactive' && existing.record === null) return 0;
    throw this.error('Child authority is ambiguous or was already terminated.');
  }

  private async commitEnrollment(
    dispatch: GovernanceDelegationDispatch,
    child: Awaited<ReturnType<OpenCodeHostAdapter['getSession']>>,
    root: GovernanceActivationRevision,
    revision: number,
  ): Promise<void> {
    const childId = child.sessionId;
    const result = await commitGovernanceActivation(
      {
        store: this.store,
        withLock: (id, run) => this.withLock(id, run),
        authorize: async (input) =>
          !this.signal.aborted && input.action === 'enroll' && input.sessionId === childId
            ? {
                kind: 'authorized',
                decisionId: root.decisionId,
                source: 'delegation',
                actor: root.decisionActor,
              }
            : this.block('Only the observed native delegation may enroll this child.'),
      },
      {
        action: 'enroll',
        expectedRevision: revision,
        sessionId: childId,
        rootSessionId: root.sessionId,
        activationId: root.activationId,
        generation: root.generation,
        directory: child.directory,
        worktreeRoot: root.worktreeRoot,
        policyDigest: root.policyDigest,
        parentDispatch: {
          sessionId: dispatch.sessionId,
          messageId: dispatch.messageId,
          callId: dispatch.callId,
        },
      },
    );
    if (result.kind !== 'committed') throw this.error(result.reason);
  }

  private async validateChild(
    dispatch: GovernanceDelegationDispatch,
    parent: ActiveGovernanceScope,
    child: Awaited<ReturnType<OpenCodeHostAdapter['getSession']>>,
  ): Promise<void> {
    if (child.parentSessionId !== dispatch.sessionId || child.directory !== parent.record.directory)
      throw this.error('Native progress did not establish the exact enrolled child scope.');
    if (child.agent !== dispatch.agent)
      throw this.error('Native child agent differs from the authorized dispatch.');
    if (dispatch.agent === REVIEWER_SUBAGENT_TYPE) {
      if (!this.reviewer)
        throw this.error('Reviewer enrollment requires its independent-review dispatch authority.');
      await this.reviewer.bind(parent, dispatch, child.sessionId);
    }
  }

  private validateContinuation(
    dispatch: GovernanceDelegationDispatch,
    record: GovernanceActivationRevision,
  ): void {
    if (
      record.activationId !== dispatch.activationId ||
      record.rootSessionId !== dispatch.rootSessionId ||
      record.generation !== dispatch.generation ||
      record.parentDispatch?.sessionId !== dispatch.sessionId
    )
      throw this.error('Continuation attempted to reuse a foreign or stale enrolled child.');
  }

  private hasPendingDispatch(parentId: string): boolean {
    return [...this.dispatches.entries()].some(
      ([key, dispatch]) => dispatch.sessionId === parentId && !this.settledDispatches.has(key),
    );
  }

  private pendingContinuation(childId: string): string | undefined {
    return [...this.dispatches.entries()].find(
      ([key, dispatch]) =>
        dispatch.requestedChildSessionId === childId && !this.settledDispatches.has(key),
    )?.[0];
  }

  private async awaitEnrollment(
    childId: string,
    rootId: string,
    dispatchKey?: string,
  ): Promise<void> {
    const linking = this.linking.get(childId);
    if (linking && (dispatchKey === undefined || linking.dispatchKey === dispatchKey))
      return linking.operation;
    if (this.signal.aborted) throw this.error('The governance adapter stopped.');
    return new Promise<void>((resolve, reject) => {
      const waiter: EnrollmentWaiter = {
        rootId,
        dispatchKey,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.get(childId)?.delete(waiter);
        reject(this.error('No exact native parent-call/child progress receipt was observed.'));
      }, 5_000);
      const group = this.waiters.get(childId) ?? new Set<EnrollmentWaiter>();
      group.add(waiter);
      this.waiters.set(childId, group);
    });
  }

  private settle(childId: string, dispatchKey: string, error?: unknown): void {
    for (const waiter of this.waiters.get(childId) ?? []) {
      if (waiter.dispatchKey !== undefined && waiter.dispatchKey !== dispatchKey) continue;
      if (error !== undefined) waiter.reject(error);
      else waiter.resolve();
      this.waiters.get(childId)?.delete(waiter);
    }
    if (this.waiters.get(childId)?.size === 0) this.waiters.delete(childId);
  }

  failPending(reason: string, rootId?: string): void {
    for (const [childId, waiters] of this.waiters) {
      for (const waiter of waiters)
        if (rootId === undefined || waiter.rootId === rootId) {
          waiter.reject(this.error(reason));
          waiters.delete(waiter);
        }
      if (waiters.size === 0) this.waiters.delete(childId);
    }
  }

  private async withLock<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    const lock = await acquireNamedWriteLock(
      path.resolve(workspacesHome(), '..', 'governance-activation-locks'),
      `${hashText(sessionId)}.lock`,
      'governance activation',
    );
    try {
      return await run();
    } finally {
      await lock.release();
    }
  }

  private block(message: string): ReturnType<typeof blocked> {
    return blocked('GOVERNANCE_AUTHORITY_BLOCKED', { message });
  }
  private error(message: string): Error {
    const result = this.block(message);
    return buildEnforcementError(result.code, result.reason);
  }
}

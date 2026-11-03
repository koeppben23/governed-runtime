/** The durable opt-in authority. Workflow files are deliberately not consulted.
 * Revisions are append-only; an atomic head selects a committed revision. An
 * absent head with any journal content is lost/incomplete authority, not INACTIVE. */
import { randomUUID } from 'node:crypto';
import {
  GovernanceActivationAuditConfirmation,
  GovernanceActivationHead,
  GovernanceActivationRevision,
  GovernanceEnrollment,
  type GovernanceActivationAction,
  type GovernanceDecisionActor,
  type GovernanceDecisionSource,
  type GovernanceDelegationDispatch,
} from '../state/governance-activation.js';
import {
  governanceActivationTarget,
  isGovernanceActivationTransition,
} from '../machine/governance-activation.js';
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { hashText } from '../shared/hashing.js';
import { blocked } from '../config/reasons.js';

export interface GovernanceActivationStore {
  get(key: string): Promise<unknown>;
  set(
    key: string,
    value:
      | GovernanceActivationHead
      | GovernanceActivationRevision
      | GovernanceActivationAuditConfirmation
      | GovernanceDelegationDispatch
      | GovernanceEnrollment,
  ): Promise<void>;
  scan(input: { prefix: string; after?: string; limit: number }): Promise<{
    entries: readonly { key: string; value: unknown }[];
    next?: string;
  }>;
}

const AUTHORITY_PREFIX = 'governance/v1/';

type AuthorityBlocked = ReturnType<typeof blocked>;
export type GovernanceActivationResolution =
  | { readonly kind: 'inactive'; readonly record: GovernanceActivationRevision | null }
  | { readonly kind: 'active'; readonly record: GovernanceActivationRevision }
  | AuthorityBlocked;

export function governanceActivationKeys(sessionId: string): {
  head: string;
  revisions: string;
  enrollment: string;
  audit: string;
} {
  const prefix = `${AUTHORITY_PREFIX}${hashText(sessionId)}/`;
  return {
    head: `${prefix}head`,
    revisions: `${prefix}revisions/`,
    enrollment: `governance/enrollments/v1/${hashText(sessionId)}`,
    audit: `${prefix}audit-confirmation`,
  };
}

/** Record that the activation's audit event is durably confirmed. */
export async function confirmGovernanceActivationAudit(
  store: GovernanceActivationStore,
  activation: Pick<GovernanceActivationRevision, 'sessionId' | 'activationId'>,
): Promise<void> {
  await store.set(governanceActivationKeys(activation.sessionId).audit, {
    schemaVersion: 1,
    sessionId: activation.sessionId,
    activationId: activation.activationId,
  });
}

/** True only when the confirmation names this exact activation generation. */
export async function isGovernanceActivationAuditConfirmed(
  store: GovernanceActivationStore,
  activation: Pick<GovernanceActivationRevision, 'sessionId' | 'activationId'>,
): Promise<boolean> {
  const value = GovernanceActivationAuditConfirmation.safeParse(
    await store.get(governanceActivationKeys(activation.sessionId).audit),
  );
  return (
    value.success &&
    value.data.sessionId === activation.sessionId &&
    value.data.activationId === activation.activationId
  );
}

/** Registry restoration only: blocked scopes are surfaced, never normalized or
 * used as authority. Every callback still resolves its exact session afresh. */
export async function listActiveGovernanceRoots(store: GovernanceActivationStore): Promise<{
  readonly records: readonly GovernanceActivationRevision[];
  readonly errors: readonly AuthorityBlocked[];
}> {
  const records: GovernanceActivationRevision[] = [];
  const errors: AuthorityBlocked[] = [];
  const cursors = new Set<string>();
  let after: string | undefined;
  try {
    do {
      const page = await store.scan({
        prefix: AUTHORITY_PREFIX,
        ...(after === undefined ? {} : { after }),
        limit: 100,
      });
      for (const item of page.entries) {
        if (!item.key.endsWith('/head')) continue;
        const result = await resolveCatalogueHead(store, item);
        if (result.kind === 'blocked') errors.push(result);
        else if (
          result.kind === 'active' &&
          result.record.sessionId === result.record.rootSessionId
        )
          records.push(result.record);
      }
      after = page.next;
      if (after !== undefined) {
        if (cursors.has(after))
          return {
            records,
            errors: [...errors, unavailable('Activation catalogue cursor repeated.')],
          };
        cursors.add(after);
      }
    } while (after !== undefined);
  } catch (error) {
    errors.push(
      unavailable(
        `Activation catalogue read failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  return { records, errors };
}

async function resolveCatalogueHead(
  store: GovernanceActivationStore,
  item: { key: string; value: unknown },
): Promise<GovernanceActivationResolution> {
  const head = GovernanceActivationHead.safeParse(item.value);
  if (!head.success || item.key !== governanceActivationKeys(head.data.sessionId).head)
    return unavailable('A stored activation head is invalid.');
  return resolveGovernanceActivation(store, head.data.sessionId);
}

/** Native call IDs are provider-supplied and unique only within one host-generated
 * assistant message; the delegation identity therefore includes that message. */
export function governanceDelegationKey(
  sessionId: string,
  messageId: string,
  callId: string,
): string {
  return `governance/delegations/v1/${hashText(canonicalJsonStringify({ sessionId, messageId, callId }))}`;
}

function revisionKey(sessionId: string, revision: number): string {
  return `${governanceActivationKeys(sessionId).revisions}${String(revision).padStart(16, '0')}`;
}

function digest(record: GovernanceActivationRevision): string {
  return hashText(canonicalJsonStringify(record));
}

function unavailable(message: string): AuthorityBlocked {
  return blocked('GOVERNANCE_AUTHORITY_BLOCKED', { message });
}

type Journal = {
  readonly head: GovernanceActivationHead | null;
  readonly history: readonly GovernanceActivationRevision[];
};

async function readJournal(
  store: GovernanceActivationStore,
  sessionId: string,
): Promise<Journal | AuthorityBlocked> {
  const keys = governanceActivationKeys(sessionId);
  const raw = await store.get(keys.head);
  const enrollment = await store.get(keys.enrollment);
  if (raw === undefined) {
    const page = await store.scan({ prefix: keys.revisions, limit: 1 });
    if (enrollment !== undefined || hasJournalEntries(page))
      return unavailable('Enrollment journal exists without its committed head.');
    return { head: null, history: [] };
  }
  const parsed = GovernanceActivationHead.safeParse(raw);
  if (!parsed.success || parsed.data.sessionId !== sessionId)
    return unavailable('Invalid or foreign activation head.');
  const head = parsed.data;
  const pending = await store.scan({
    prefix: keys.revisions,
    after: revisionKey(sessionId, head.revision),
    limit: 1,
  });
  if (hasJournalEntries(pending))
    return unavailable('An activation transition has not committed its head.');
  const history = await readHistory(store, sessionId, head);
  if ('kind' in history) return history;
  if (!isEnrollmentBound(enrollment, sessionId, history[0]))
    return unavailable(
      'Enrollment marker is missing, corrupt or foreign to the activation history.',
    );
  const invalid = validateHistory(history);
  if (invalid) return invalid;
  if (canonicalJsonStringify(await store.get(keys.head)) !== canonicalJsonStringify(head))
    return unavailable('Activation authority changed during verification.');
  return { head, history };
}

function hasJournalEntries(page: Awaited<ReturnType<GovernanceActivationStore['scan']>>): boolean {
  return page.entries.length !== 0 || page.next !== undefined;
}

function isEnrollmentBound(
  raw: unknown,
  sessionId: string,
  first: GovernanceActivationRevision | undefined,
): boolean {
  const marker = GovernanceEnrollment.safeParse(raw);
  return (
    marker.success &&
    marker.data.sessionId === sessionId &&
    marker.data.firstActivationId === first?.activationId
  );
}

async function readHistory(
  store: GovernanceActivationStore,
  sessionId: string,
  head: GovernanceActivationHead,
): Promise<GovernanceActivationRevision[] | AuthorityBlocked> {
  const history: GovernanceActivationRevision[] = [];
  let expectedDigest = head.digest;
  for (let revision = head.revision; revision > 0; revision--) {
    if (history.length >= 10_000)
      return unavailable('Activation journal exceeds the verification bound.');
    const item = GovernanceActivationRevision.safeParse(
      await store.get(revisionKey(sessionId, revision)),
    );
    if (
      !item.success ||
      item.data.sessionId !== sessionId ||
      item.data.revision !== revision ||
      digest(item.data) !== expectedDigest
    ) {
      return unavailable('Activation journal is missing, corrupt or bound to another session.');
    }
    history.push(item.data);
    expectedDigest = item.data.previousDigest ?? '';
  }
  history.reverse();
  return history;
}

function validateHistory(
  history: readonly GovernanceActivationRevision[],
): AuthorityBlocked | null {
  let previous: GovernanceActivationRevision | null = null;
  const decisions = new Set<string>();
  for (const item of history) {
    if (!isGovernanceActivationTransition(previous, item))
      return unavailable('Invalid activation lifecycle transition.');
    if (item.status === 'activating' || item.status === 'ending') {
      if (decisions.has(item.decisionId)) return unavailable('Replayed activation decision.');
      decisions.add(item.decisionId);
    }
    previous = item;
  }
  return null;
}

export async function resolveGovernanceActivation(
  store: GovernanceActivationStore,
  sessionId: string,
): Promise<GovernanceActivationResolution> {
  try {
    const journal = await readJournal(store, sessionId);
    if ('kind' in journal) return journal;
    const record = journal.history.at(-1) ?? null;
    if (record === null || record.status === 'inactive') return { kind: 'inactive', record };
    if (record.status !== 'active')
      return unavailable(`Activation transition is ${record.status}; recovery is required.`);
    return { kind: 'active', record };
  } catch (error) {
    return unavailable(
      `Activation storage read failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface GovernanceActivationCommit {
  readonly action: GovernanceActivationAction;
  readonly expectedRevision: number;
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly activationId: string;
  readonly generation: number;
  readonly directory: string;
  readonly worktreeRoot: string;
  readonly policyDigest: string;
  readonly parentDispatch: GovernanceActivationRevision['parentDispatch'];
}

/**
 * Internal, non-serialized authorization port. The port, not the caller,
 * decides the decision identity, its channel and its canonically resolved actor;
 * a caller-provided origin field is never an implementation of this port.
 */
export interface GovernanceActivationDecision {
  readonly kind: 'authorized';
  readonly decisionId: string;
  readonly source: GovernanceDecisionSource;
  readonly actor: GovernanceDecisionActor;
}

export interface GovernanceActivationWriter {
  readonly store: GovernanceActivationStore;
  readonly withLock: <T>(sessionId: string, operation: () => Promise<T>) => Promise<T>;
  readonly authorize: (
    input: GovernanceActivationCommit,
    current: GovernanceActivationRevision | null,
  ) => Promise<GovernanceActivationDecision | AuthorityBlocked>;
}

type Committed = { readonly kind: 'committed'; readonly record: GovernanceActivationRevision };

export async function commitGovernanceActivation(
  writer: GovernanceActivationWriter,
  input: GovernanceActivationCommit,
): Promise<Committed | AuthorityBlocked> {
  return writer.withLock(input.sessionId, () => commitLocked(writer, input));
}

/** Caller holds the session lock. Every step re-reads and re-verifies the journal. */
async function commitLocked(
  writer: GovernanceActivationWriter,
  input: GovernanceActivationCommit,
): Promise<Committed | AuthorityBlocked> {
  try {
    const journal = await readJournal(writer.store, input.sessionId);
    if ('kind' in journal) return journal;
    if ((journal.head?.revision ?? 0) !== input.expectedRevision)
      return unavailable('Stale or concurrent activation revision.');
    const current = journal.history.at(-1) ?? null;
    const authorization = await writer.authorize(input, current);
    if (authorization.kind === 'blocked') return authorization;
    const record = prepareRevision(input, journal, authorization);
    if ('kind' in record) return record;
    const key = revisionKey(input.sessionId, record.revision);
    if ((await writer.store.get(key)) !== undefined)
      return unavailable(
        'Activation revision already exists; append-only history cannot be replaced.',
      );
    if (input.expectedRevision === 0)
      await writer.store.set(governanceActivationKeys(input.sessionId).enrollment, {
        schemaVersion: 1,
        sessionId: input.sessionId,
        firstActivationId: record.activationId,
      });
    await writer.store.set(key, record);
    await writer.store.set(governanceActivationKeys(input.sessionId).head, {
      schemaVersion: 1,
      sessionId: input.sessionId,
      revision: record.revision,
      digest: digest(record),
    });
    return { kind: 'committed', record };
  } catch (error) {
    return unavailable(
      `Activation commit failed; preserve the journal: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The workflow scope a root Start decision binds. */
export interface GovernanceRootStart {
  readonly sessionId: string;
  readonly directory: string;
  readonly worktreeRoot: string;
  readonly policyDigest: string;
}

export type GovernanceRootStartResult =
  | {
      readonly kind: 'activated';
      readonly record: GovernanceActivationRevision;
      /** True when an interrupted ACTIVATING revision of the same decision was completed. */
      readonly resumed: boolean;
    }
  | { readonly kind: 'already_active'; readonly record: GovernanceActivationRevision }
  | AuthorityBlocked;

/**
 * Start a root scope under one session lock: INACTIVE (or no journal) commits
 * ACTIVATING then ACTIVE; an interrupted ACTIVATING revision is completed; the
 * authorization port must then return the pending decision, and the lifecycle
 * rejects a different channel or actor. ENDING and delegated children never start.
 */
export async function startRootGovernance(
  writer: GovernanceActivationWriter,
  input: {
    readonly sessionId: string;
    readonly prepare: (
      current: GovernanceActivationRevision | null,
    ) => Promise<GovernanceRootStart>;
  },
): Promise<GovernanceRootStartResult> {
  return writer.withLock(input.sessionId, async () => {
    const journal = await readJournalForStart(writer.store, input.sessionId);
    if ('kind' in journal) return journal;
    const current = journal.history.at(-1) ?? null;
    const settled = settledStart(current);
    if (settled?.kind === 'blocked') return settled;
    const request = await input.prepare(current);
    if (request.sessionId !== input.sessionId)
      return unavailable('Start preparation changed its session.');
    if (current?.status === 'active' && !rootStartBindingMatches(current, request))
      return unavailable('The ACTIVE activation does not match the current workflow binding.');
    if (settled !== null) return settled;
    return commitPreparedStart(writer, current, journal.head?.revision ?? 0, request);
  });
}

function rootStartBindingMatches(
  current: GovernanceActivationRevision,
  request: GovernanceRootStart,
): boolean {
  return (
    current.sessionId === request.sessionId &&
    current.directory === request.directory &&
    current.worktreeRoot === request.worktreeRoot &&
    current.policyDigest === request.policyDigest
  );
}

/** Journal verification and preparation have completed under the caller's lock. */
async function commitPreparedStart(
  writer: GovernanceActivationWriter,
  current: GovernanceActivationRevision | null,
  revision: number,
  request: GovernanceRootStart,
): Promise<GovernanceRootStartResult> {
  if (current?.status === 'activating') return completeStart(writer, current, request, revision);
  const started = await commitLocked(writer, {
    ...request,
    action: 'start',
    expectedRevision: revision,
    rootSessionId: request.sessionId,
    activationId: randomUUID(),
    generation: (current?.generation ?? 0) + 1,
    parentDispatch: null,
  });
  if (started.kind === 'blocked') return started;
  return completeStart(writer, started.record, request, started.record.revision, false);
}

async function readJournalForStart(
  store: GovernanceActivationStore,
  sessionId: string,
): Promise<Journal | AuthorityBlocked> {
  try {
    return await readJournal(store, sessionId);
  } catch (error) {
    return unavailable(
      `Activation storage read failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Start outcomes that need no write; null means Start may (re)commit or complete. */
function settledStart(
  current: GovernanceActivationRevision | null,
): GovernanceRootStartResult | null {
  if (current !== null && current.parentDispatch !== null)
    return unavailable('A delegated child session cannot start governance.');
  if (current?.status === 'active') return { kind: 'already_active', record: current };
  if (current?.status === 'ending')
    return unavailable('Governance is ending for this session; End must complete first.');
  return null;
}

async function completeStart(
  writer: GovernanceActivationWriter,
  pending: GovernanceActivationRevision,
  request: GovernanceRootStart,
  revision: number,
  resumed = true,
): Promise<GovernanceRootStartResult> {
  if (!rootStartBindingMatches(pending, request))
    return unavailable(
      'The interrupted activation is bound to another directory, worktree or frozen policy.',
    );
  const {
    schemaVersion: _schemaVersion,
    revision: _revision,
    status: _status,
    decisionId: _decisionId,
    decisionSource: _decisionSource,
    decisionActor: _decisionActor,
    previousDigest: _previousDigest,
    ...scope
  } = pending;
  const active = await commitLocked(writer, {
    ...scope,
    action: 'activate',
    expectedRevision: revision,
  });
  if (active.kind === 'blocked') return active;
  return { kind: 'activated', record: active.record, resumed };
}

function prepareRevision(
  input: GovernanceActivationCommit,
  journal: Journal,
  decision: GovernanceActivationDecision,
): GovernanceActivationRevision | AuthorityBlocked {
  const { action, expectedRevision, ...scope } = input;
  const { decisionId } = decision;
  const parsed = GovernanceActivationRevision.safeParse({
    ...scope,
    schemaVersion: 2,
    revision: expectedRevision + 1,
    status: governanceActivationTarget(action),
    decisionId,
    decisionSource: decision.source,
    decisionActor: decision.actor,
    previousDigest: journal.head?.digest ?? null,
  });
  if (!parsed.success) return unavailable('Invalid activation revision input.');
  const record = parsed.data;
  if (!isGovernanceActivationTransition(journal.history.at(-1) ?? null, record))
    return unavailable('Activation transition is not admissible.');
  if (
    (action === 'start' || action === 'begin_end') &&
    journal.history.some((item) => item.decisionId === decisionId)
  )
    return unavailable('Activation decision has already been consumed.');
  return record;
}

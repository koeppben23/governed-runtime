/**
 * @module adapters/diagnostics/session-discovery
 * @description Read-only, bounded discovery of verified reviewer descendants.
 *
 * Discovery is separate from capture: a candidate is not authorization to read
 * its state. A child becomes verified only when every parent-child edge is a
 * canonical review invocation in the verified parent's state. Attempts,
 * observations, host parent IDs, names and timing are not lineage evidence.
 *
 * Candidate enumeration is incremental and hard-bounded. A parent state that
 * was not fully enumerated never authorizes reading its children, because an
 * unread candidate could carry a conflicting invocation claim.
 */

import type { SessionAuthorityResolution } from '../session-authority.js';
import { resolveSessionAuthority } from '../session-authority.js';
import type { SessionState } from '../../state/schema.js';
import { DEFAULT_MAX_DISCOVERY_NODES, type DiagnosticWarning } from './export-schema.js';
import { warning, type DiscoverySource } from './types.js';

export interface DiscoveredSession {
  readonly sessionId: string;
  readonly parentSessionId: string | null;
  readonly generation: number;
  readonly sources: readonly DiscoverySource[];
  readonly invocationParents: readonly string[];
  readonly lineage: 'verified' | 'not_verified';
  readonly conflict: boolean;
  readonly authority: SessionAuthorityResolution | null;
  readonly state: SessionState | null;
  readonly warnings: readonly DiagnosticWarning[];
}

export interface SessionTreeDiscovery {
  readonly rootSessionId: string;
  readonly sessions: readonly DiscoveredSession[];
  /** True when a hard budget or unreadable branch prevented complete discovery. */
  readonly truncated: boolean;
  readonly reasons: readonly string[];
}

export interface SessionTreeRequest {
  readonly root: string;
  readonly rootSessionId: string;
  readonly rootState: SessionState;
  readonly rootAuthority?: SessionAuthorityResolution;
  readonly maxNodes?: number;
  /** Hard budget for raw invocation/attempt/observation records examined. */
  readonly maxCandidates?: number;
  readonly deadlineAt?: number;
  readonly now?: () => number;
}

interface RawCandidate {
  readonly sessionId: string;
  readonly source: DiscoverySource;
  readonly invocationParent: string | null;
}

interface MutableDiscoveredSession {
  sessionId: string;
  parentSessionId: string | null;
  generation: number;
  sources: Set<DiscoverySource>;
  invocationParents: Set<string>;
  /** Parents whose state contained an invocation with this session as child. */
  invocationObservedFrom: Set<string>;
  lineage: 'verified' | 'not_verified';
  conflict: boolean;
  /** Whether this session's own state was enumerated to the end. */
  enumerationComplete: boolean;
  authority: SessionAuthorityResolution | null;
  state: SessionState | null;
  warnings: DiagnosticWarning[];
}

type ChildResolution = 'resolved' | 'absent' | 'deadline' | 'unavailable' | 'unreadable';
type EnumerationResult = 'continue' | 'stop';

/**
 * Raw candidate records are allowed to outnumber discovered nodes: a state may
 * legitimately list several attempts/observations per child. The multiplier
 * keeps enumeration proportional to the node budget without permitting an
 * unbounded temporary map.
 */
const CANDIDATE_BUDGET_MULTIPLIER = 4;

/**
 * Yield raw candidate claims one at a time so a large state cannot force an
 * unbounded temporary map before the discovery budget is checked.
 */
function* invocationCandidates(state: SessionState): Generator<RawCandidate> {
  for (const invocation of state.reviewAssurance?.invocations ?? []) {
    if (typeof invocation.childSessionId !== 'string' || invocation.childSessionId.length === 0) {
      continue;
    }
    yield {
      sessionId: invocation.childSessionId,
      source: 'review_invocation',
      invocationParent:
        typeof invocation.parentSessionId === 'string' ? invocation.parentSessionId : null,
    };
  }
}

function* attemptCandidates(state: SessionState): Generator<RawCandidate> {
  for (const attempt of state.reviewAssurance?.attempts ?? []) {
    if (typeof attempt.childSessionId === 'string' && attempt.childSessionId.length > 0) {
      yield {
        sessionId: attempt.childSessionId,
        source: 'review_attempt',
        invocationParent: null,
      };
    }
    for (const observation of attempt.observations) {
      if (
        typeof observation.observedBySessionId === 'string' &&
        observation.observedBySessionId.length > 0
      ) {
        yield {
          sessionId: observation.observedBySessionId,
          source: 'review_observation',
          invocationParent: null,
        };
      }
    }
  }
}

function* directCandidates(state: SessionState): Generator<RawCandidate> {
  yield* invocationCandidates(state);
  yield* attemptCandidates(state);
}

function addWarning(
  target: MutableDiscoveredSession,
  code: string,
  message: string,
  source: DiagnosticWarning['source'],
): void {
  if (target.warnings.some((entry) => entry.code === code)) return;
  target.warnings.push(warning(code, message, target.sessionId, source));
}

/**
 * The only authoritative parent is a single invocation claim that was observed
 * in that claimed parent's own discovered state. Attempts and observations do
 * not name a parent and therefore never establish lineage.
 */
function authoritativeParent(session: MutableDiscoveredSession): string | null {
  if (session.conflict || session.invocationParents.size !== 1) return null;
  const claimed = [...session.invocationParents][0] ?? null;
  return claimed !== null && session.invocationObservedFrom.has(claimed) ? claimed : null;
}

/**
 * A parent edge is trusted only when the parent's own state was enumerated to
 * the end. Partial enumeration could hide a conflicting invocation claim.
 */
function verifiedParent(
  session: MutableDiscoveredSession,
  sessions: Map<string, MutableDiscoveredSession>,
): string | null {
  const claimed = authoritativeParent(session);
  if (claimed === null) return null;
  return sessions.get(claimed)?.enumerationComplete === true ? claimed : null;
}

function clearUnreachableSession(
  session: MutableDiscoveredSession,
  sessions: Map<string, MutableDiscoveredSession>,
  reasons: string[],
): void {
  session.lineage = 'not_verified';
  session.authority = null;
  session.state = null;
  if (session.conflict) {
    reasons.push(`LINEAGE_CONFLICT:${session.sessionId}`);
    return;
  }
  const claimed = authoritativeParent(session);
  const parent = claimed === null ? undefined : sessions.get(claimed);
  if (parent !== undefined && !parent.enumerationComplete) {
    addWarning(
      session,
      'SESSION_LINEAGE_PARENT_INCOMPLETE',
      'The claimed parent state was not fully enumerated; the session was retained but not read.',
      'review',
    );
    reasons.push(`SESSION_LINEAGE_PARENT_INCOMPLETE:${session.sessionId}`);
    return;
  }
  addWarning(
    session,
    'SESSION_LINEAGE_NOT_VERIFIED',
    'Known session was retained in the graph but not read because its lineage to the requested root is not positively established.',
    'review',
  );
  reasons.push(`SESSION_LINEAGE_NOT_VERIFIED:${session.sessionId}`);
}

function recomputeLineage(
  rootSessionId: string,
  sessions: Map<string, MutableDiscoveredSession>,
  reasons: string[],
): void {
  const reachable = new Set<string>([rootSessionId]);
  const queue = [rootSessionId];
  while (queue.length > 0) {
    const parentId = queue.shift();
    if (parentId === undefined) break;
    for (const session of sessions.values()) {
      if (session.sessionId === rootSessionId) continue;
      if (verifiedParent(session, sessions) !== parentId) continue;
      if (reachable.has(session.sessionId)) continue;
      reachable.add(session.sessionId);
      queue.push(session.sessionId);
    }
  }
  for (const session of sessions.values()) {
    if (session.sessionId === rootSessionId) continue;
    if (reachable.has(session.sessionId) && !session.conflict) {
      session.lineage = 'verified';
      continue;
    }
    clearUnreachableSession(session, sessions, reasons);
  }
}

function applyLineageClaims(
  target: MutableDiscoveredSession,
  existing: MutableDiscoveredSession | undefined,
): void {
  const parents = [...target.invocationParents];
  if (parents.length > 1) {
    if (!target.conflict) {
      addWarning(
        target,
        'LINEAGE_CONFLICT',
        'Conflicting authoritative parent invocations were found; the session is not read.',
        'review',
      );
    }
    target.conflict = true;
    target.lineage = 'not_verified';
    target.parentSessionId = null;
    return;
  }
  if (parents.length === 1) {
    target.parentSessionId = parents[0] ?? null;
    target.lineage = authoritativeParent(target) === null ? 'not_verified' : 'verified';
    return;
  }
  target.parentSessionId = existing?.parentSessionId ?? null;
  target.lineage = 'not_verified';
}

function mergeCandidate(
  existing: MutableDiscoveredSession | undefined,
  candidate: RawCandidate,
  observingParent: string,
  generation: number,
): MutableDiscoveredSession {
  const target =
    existing ??
    ({
      sessionId: candidate.sessionId,
      parentSessionId: null,
      generation,
      sources: new Set<DiscoverySource>(),
      invocationParents: new Set<string>(),
      invocationObservedFrom: new Set<string>(),
      lineage: 'not_verified',
      conflict: false,
      enumerationComplete: false,
      authority: null,
      state: null,
      warnings: [],
    } satisfies MutableDiscoveredSession);
  target.sources.add(candidate.source);
  if (candidate.invocationParent !== null && candidate.invocationParent !== candidate.sessionId) {
    target.invocationParents.add(candidate.invocationParent);
  }
  if (candidate.source === 'review_invocation' && candidate.invocationParent !== null) {
    target.invocationObservedFrom.add(observingParent);
  }
  target.generation = Math.min(target.generation, generation);
  applyLineageClaims(target, existing);
  return target;
}

async function resolveVerifiedChild(
  request: SessionTreeRequest,
  node: MutableDiscoveredSession,
  reasons: string[],
): Promise<ChildResolution> {
  if (node.lineage !== 'verified' || node.conflict) return 'unreadable';
  const now = request.now ?? Date.now;
  if (request.deadlineAt !== undefined && now() > request.deadlineAt) {
    addWarning(
      node,
      'CAPTURE_TIME_BUDGET_EXCEEDED',
      'The child state was not read because the total capture time budget was exhausted.',
      'capture',
    );
    reasons.push(`CAPTURE_TIME_BUDGET_EXCEEDED:${node.sessionId}`);
    return 'deadline';
  }
  try {
    const authority = await resolveSessionAuthority({
      root: request.root,
      sessionId: node.sessionId,
    });
    node.authority = authority;
    node.state = authority.status === 'resolved' ? authority.state : null;
    if (authority.status === 'absent') {
      addWarning(
        node,
        'SESSION_STATE_ABSENT',
        'No FlowGuard state exists for this known session.',
        'state',
      );
      reasons.push(`SESSION_STATE_ABSENT:${node.sessionId}`);
      node.enumerationComplete = true;
      return 'absent';
    }
    if (authority.status === 'unavailable') {
      addWarning(
        node,
        `SESSION_${authority.code}`,
        `Known session could not be resolved: ${authority.reason}`,
        'state',
      );
      reasons.push(`SESSION_${authority.code}:${node.sessionId}`);
      return 'unavailable';
    }
    return 'resolved';
  } catch (error) {
    addWarning(
      node,
      'SESSION_AUTHORITY_UNREADABLE',
      `Known session could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
      'state',
    );
    reasons.push(`SESSION_AUTHORITY_UNREADABLE:${node.sessionId}`);
    return 'unreadable';
  }
}

interface QueuedParent {
  readonly id: string;
  readonly state: SessionState;
  readonly generation: number;
}

interface DiscoveryTraversal {
  readonly request: SessionTreeRequest;
  readonly maxNodes: number;
  readonly maxCandidates: number;
  readonly sessions: Map<string, MutableDiscoveredSession>;
  readonly reasons: string[];
  readonly resolved: Set<string>;
  readonly queue: QueuedParent[];
  truncated: boolean;
}

function visitCandidate(
  traversal: DiscoveryTraversal,
  parent: QueuedParent,
  candidate: RawCandidate,
): EnumerationResult {
  const existing = traversal.sessions.get(candidate.sessionId);
  if (existing === undefined && traversal.sessions.size >= traversal.maxNodes) {
    // Preserve the first candidate that proves the budget was exceeded; it
    // remains visible in the denominator, then enumeration stops.
    traversal.truncated = true;
    traversal.reasons.push('DISCOVERY_NODE_LIMIT');
    traversal.sessions.set(
      candidate.sessionId,
      mergeCandidate(existing, candidate, parent.id, parent.generation + 1),
    );
    return 'stop';
  }
  traversal.sessions.set(
    candidate.sessionId,
    mergeCandidate(existing, candidate, parent.id, parent.generation + 1),
  );
  return 'continue';
}

/**
 * Resolve only children whose single invocation claim names this parent and
 * whose edge was observed here. This runs after the parent state was fully
 * enumerated, so a partially enumerated state never authorizes a read.
 */
async function resolveObservedChildren(
  traversal: DiscoveryTraversal,
  parent: QueuedParent,
): Promise<EnumerationResult> {
  for (const child of traversal.sessions.values()) {
    if (child.sessionId === parent.id) continue;
    if (child.lineage !== 'verified' || child.conflict) continue;
    if (authoritativeParent(child) !== parent.id) continue;
    if (traversal.resolved.has(child.sessionId)) continue;
    traversal.resolved.add(child.sessionId);
    const resolution = await resolveVerifiedChild(traversal.request, child, traversal.reasons);
    if (resolution === 'deadline') {
      traversal.truncated = true;
      return 'stop';
    }
    if (resolution === 'unavailable' || resolution === 'unreadable') {
      traversal.truncated = true;
      continue;
    }
    if (resolution === 'resolved' && child.state !== null) {
      traversal.queue.push({
        id: child.sessionId,
        state: child.state,
        generation: child.generation,
      });
    }
  }
  return 'continue';
}

function enumerateParent(
  traversal: DiscoveryTraversal,
  parent: QueuedParent,
  current: MutableDiscoveredSession,
  examinedCandidates: { count: number },
): EnumerationResult {
  const now = traversal.request.now ?? Date.now;
  for (const candidate of directCandidates(parent.state)) {
    if (examinedCandidates.count >= traversal.maxCandidates) {
      traversal.truncated = true;
      traversal.reasons.push('DISCOVERY_CANDIDATE_LIMIT');
      current.enumerationComplete = false;
      return 'stop';
    }
    if (traversal.request.deadlineAt !== undefined && now() > traversal.request.deadlineAt) {
      traversal.truncated = true;
      traversal.reasons.push(`CAPTURE_TIME_BUDGET_EXCEEDED:${parent.id}`);
      current.enumerationComplete = false;
      return 'stop';
    }
    examinedCandidates.count++;
    if (candidate.sessionId === traversal.request.rootSessionId) continue;
    if (visitCandidate(traversal, parent, candidate) === 'stop') {
      current.enumerationComplete = false;
      return 'stop';
    }
  }
  current.enumerationComplete = true;
  return 'continue';
}

/**
 * Discover the verified descendant tree from one resolved root state.
 *
 * The result is denominator-preserving within the discovery budget: every
 * candidate discovered before truncation remains in `sessions`, even when its
 * state cannot be read.
 */
export async function discoverSessionTree(
  request: SessionTreeRequest,
): Promise<SessionTreeDiscovery> {
  const maxNodes = request.maxNodes ?? DEFAULT_MAX_DISCOVERY_NODES;
  const traversal: DiscoveryTraversal = {
    request,
    maxNodes,
    maxCandidates: Math.max(1, request.maxCandidates ?? maxNodes * CANDIDATE_BUDGET_MULTIPLIER),
    sessions: new Map<string, MutableDiscoveredSession>(),
    reasons: [],
    resolved: new Set<string>([request.rootSessionId]),
    queue: [{ id: request.rootSessionId, state: request.rootState, generation: 0 }],
    truncated: false,
  };
  traversal.sessions.set(request.rootSessionId, {
    sessionId: request.rootSessionId,
    parentSessionId: null,
    generation: 0,
    sources: new Set<DiscoverySource>(['root']),
    invocationParents: new Set<string>(),
    invocationObservedFrom: new Set<string>(),
    lineage: 'verified',
    conflict: false,
    enumerationComplete: false,
    authority: request.rootAuthority ?? null,
    state: request.rootState,
    warnings: [],
  });
  const examinedCandidates = { count: 0 };
  while (traversal.queue.length > 0) {
    const parent = traversal.queue.shift();
    if (parent === undefined) break;
    const current = traversal.sessions.get(parent.id);
    if (current === undefined || current.lineage !== 'verified' || current.conflict) continue;
    if (enumerateParent(traversal, parent, current, examinedCandidates) === 'stop') break;
    if ((await resolveObservedChildren(traversal, parent)) === 'stop') break;
  }
  recomputeLineage(request.rootSessionId, traversal.sessions, traversal.reasons);
  return {
    rootSessionId: request.rootSessionId,
    sessions: [...traversal.sessions.values()].map((session) => ({
      sessionId: session.sessionId,
      parentSessionId: session.parentSessionId,
      generation: session.generation,
      sources: [...session.sources],
      invocationParents: [...session.invocationParents],
      lineage: session.lineage,
      conflict: session.conflict,
      authority: session.authority,
      state: session.state,
      warnings: [...session.warnings],
    })),
    truncated: traversal.truncated,
    reasons: traversal.reasons,
  };
}

/**
 * @module adapters/diagnostics/session-discovery
 * @description Read-only, bounded discovery of verified reviewer descendants.
 *
 * Discovery is separate from capture: a candidate is not authorization to read
 * its state. A child becomes verified only when every parent-child edge is a
 * canonical review invocation in the verified parent's state. Attempts,
 * observations, host parent IDs, names and timing are not lineage evidence.
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
  readonly truncated: boolean;
  readonly reasons: readonly string[];
}

export interface SessionTreeRequest {
  readonly root: string;
  readonly rootSessionId: string;
  readonly rootState: SessionState;
  readonly rootAuthority?: SessionAuthorityResolution;
  readonly maxNodes?: number;
  readonly deadlineAt?: number;
  readonly now?: () => number;
}

interface DirectCandidate {
  readonly sources: Set<DiscoverySource>;
  readonly invocationParents: Set<string>;
}

interface MutableDiscoveredSession {
  sessionId: string;
  parentSessionId: string | null;
  generation: number;
  sources: Set<DiscoverySource>;
  invocationParents: Set<string>;
  /** Parents whose discovered state named this session as a direct candidate. */
  observedFrom: Set<string>;
  lineage: 'verified' | 'not_verified';
  conflict: boolean;
  authority: SessionAuthorityResolution | null;
  state: SessionState | null;
  warnings: DiagnosticWarning[];
}

function mergeSet(target: Set<string>, values: Iterable<string>): void {
  for (const value of values) target.add(value);
}

/** Collect all direct candidates named by one state's review assurance. */
function directCandidates(state: SessionState): Map<string, DirectCandidate> {
  const found = new Map<string, DirectCandidate>();
  const add = (sessionId: string | undefined, source: DiscoverySource, parent?: string) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    const existing = found.get(sessionId) ?? {
      sources: new Set<DiscoverySource>(),
      invocationParents: new Set<string>(),
    };
    existing.sources.add(source);
    if (parent !== undefined && parent !== sessionId) existing.invocationParents.add(parent);
    found.set(sessionId, existing);
  };
  for (const invocation of state.reviewAssurance?.invocations ?? []) {
    add(invocation.childSessionId, 'review_invocation', invocation.parentSessionId);
  }
  for (const attempt of state.reviewAssurance?.attempts ?? []) {
    add(attempt.childSessionId, 'review_attempt');
    for (const observation of attempt.observations) {
      add(observation.observedBySessionId, 'review_observation');
    }
  }
  return found;
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
  return claimed !== null && session.observedFrom.has(claimed) ? claimed : null;
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
      if (authoritativeParent(session) !== parentId) continue;
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
    session.lineage = 'not_verified';
    session.authority = null;
    session.state = null;
    if (session.conflict) {
      reasons.push(`LINEAGE_CONFLICT:${session.sessionId}`);
      continue;
    }
    addWarning(
      session,
      'SESSION_LINEAGE_NOT_VERIFIED',
      'Known session was retained in the graph but not read because its lineage to the requested root is not positively established.',
      'review',
    );
    reasons.push(`SESSION_LINEAGE_NOT_VERIFIED:${session.sessionId}`);
  }
}

function mergeCandidate(
  existing: MutableDiscoveredSession | undefined,
  sessionId: string,
  candidate: DirectCandidate,
  observingParent: string,
  generation: number,
): MutableDiscoveredSession {
  const target =
    existing ??
    ({
      sessionId,
      parentSessionId: null,
      generation,
      sources: new Set<DiscoverySource>(),
      invocationParents: new Set<string>(),
      observedFrom: new Set<string>(),
      lineage: 'not_verified',
      conflict: false,
      authority: null,
      state: null,
      warnings: [],
    } satisfies MutableDiscoveredSession);
  mergeSet(target.sources, candidate.sources);
  mergeSet(target.invocationParents, candidate.invocationParents);
  // A session can never be its own authoritative parent.
  target.invocationParents.delete(sessionId);
  target.observedFrom.add(observingParent);
  target.generation = Math.min(target.generation, generation);
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
  } else if (parents.length === 1) {
    target.parentSessionId = parents[0] ?? null;
    target.lineage = authoritativeParent(target) === null ? 'not_verified' : 'verified';
  } else {
    target.parentSessionId = existing?.parentSessionId ?? null;
    target.lineage = 'not_verified';
  }
  return target;
}

async function resolveVerifiedChild(
  request: SessionTreeRequest,
  node: MutableDiscoveredSession,
  reasons: string[],
): Promise<void> {
  if (node.lineage !== 'verified' || node.conflict) return;
  const now = request.now ?? Date.now;
  if (request.deadlineAt !== undefined && now() > request.deadlineAt) {
    addWarning(
      node,
      'CAPTURE_TIME_BUDGET_EXCEEDED',
      'The child state was not read because the total capture time budget was exhausted.',
      'capture',
    );
    reasons.push(`CAPTURE_TIME_BUDGET_EXCEEDED:${node.sessionId}`);
    return;
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
    } else if (authority.status === 'unavailable') {
      addWarning(
        node,
        `SESSION_${authority.code}`,
        `Known session could not be resolved: ${authority.reason}`,
        'state',
      );
      reasons.push(`SESSION_${authority.code}:${node.sessionId}`);
    }
  } catch (error) {
    addWarning(
      node,
      'SESSION_AUTHORITY_UNREADABLE',
      `Known session could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
      'state',
    );
    reasons.push(`SESSION_AUTHORITY_UNREADABLE:${node.sessionId}`);
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
  readonly sessions: Map<string, MutableDiscoveredSession>;
  readonly reasons: string[];
  readonly resolved: Set<string>;
  readonly queue: QueuedParent[];
  truncated: boolean;
}

async function visitCandidate(
  traversal: DiscoveryTraversal,
  parent: QueuedParent,
  childId: string,
  candidate: DirectCandidate,
): Promise<void> {
  const existing = traversal.sessions.get(childId);
  if (existing === undefined && traversal.sessions.size >= traversal.maxNodes) {
    // Preserve the first candidate that proves the budget was exceeded; it
    // remains visible in the denominator and then traversal stops.
    traversal.truncated = true;
    traversal.reasons.push('DISCOVERY_NODE_LIMIT');
  }
  const child = mergeCandidate(existing, childId, candidate, parent.id, parent.generation + 1);
  traversal.sessions.set(childId, child);
  if (traversal.truncated) return;
  if (child.lineage !== 'verified' || child.conflict || traversal.resolved.has(child.sessionId)) {
    return;
  }
  traversal.resolved.add(child.sessionId);
  await resolveVerifiedChild(traversal.request, child, traversal.reasons);
  if (child.state !== null && child.authority?.status === 'resolved') {
    traversal.queue.push({
      id: child.sessionId,
      state: child.state,
      generation: child.generation,
    });
  }
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
  const traversal: DiscoveryTraversal = {
    request,
    maxNodes: request.maxNodes ?? DEFAULT_MAX_DISCOVERY_NODES,
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
    observedFrom: new Set<string>(),
    lineage: 'verified',
    conflict: false,
    authority: request.rootAuthority ?? null,
    state: request.rootState,
    warnings: [],
  });
  while (traversal.queue.length > 0) {
    const parent = traversal.queue.shift();
    if (parent === undefined) break;
    const current = traversal.sessions.get(parent.id);
    if (current === undefined || current.lineage !== 'verified' || current.conflict) continue;
    for (const [childId, candidate] of directCandidates(parent.state)) {
      if (childId === request.rootSessionId) continue;
      await visitCandidate(traversal, parent, childId, candidate);
      if (traversal.truncated) break;
    }
    if (traversal.truncated) break;
  }
  recomputeLineage(request.rootSessionId, traversal.sessions, traversal.reasons);
  return {
    rootSessionId: request.rootSessionId,
    sessions: [...traversal.sessions.values()].map((session) => ({
      ...session,
      sources: [...session.sources],
      invocationParents: [...session.invocationParents],
    })),
    truncated: traversal.truncated,
    reasons: traversal.reasons,
  };
}

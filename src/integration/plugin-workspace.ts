/**
 * @module integration/plugin-workspace
 * @description Workspace resolution, hash chain, state persistence, and
 * session helpers — extracted from plugin.ts for composition root purity.
 *
 * Takes mutable state objects (cachedFingerprint, chainStates, etc.)
 * and injected dependencies (readState, log, config, etc.) and returns
 * all the closure-coupled helper functions that plugin.ts previously
 * defined inline. Each function is self-contained with explicit deps.
 *
 * @version v1
 */

import {
  readState,
  writeState,
  appendAuditEvent,
  readAuditTrail,
} from '../adapters/persistence.js';
import {
  computeFingerprint,
  sessionDir as resolveSessionDir,
  workspaceDir as resolveWorkspaceDir,
} from '../adapters/workspace/index.js';
import { GENESIS_HASH, type ChainedAuditEvent } from '../audit/types.js';
import { decisionReceipts } from '../audit/query.js';
import { getLastChainHash } from '../audit/integrity.js';
import { appendReviewAuditEvent } from './plugin-review-audit.js';
import { blockObligation } from './plugin-review-state.js';
import { strictBlockedOutput } from './plugin-helpers.js';
import {
  createSessionState as createEnforcementState,
  type SessionEnforcementState,
} from './review-enforcement.js';

import type { SessionState } from '../state/schema.js';

/** Mutable per-session chain state. */
export type MutableChainState = {
  initialized: boolean;
  lastHash: string | null;
};

/** Dependencies for the workspace factory. */
export interface WorkspaceDeps {
  auditWorktree: string | undefined;
}

/** Session identity context bundled for audit operations. */
export interface ReviewSessionContext {
  readonly sessDir: string;
  readonly sessionId: string;
  readonly phase: string;
}

/** All helpers returned by the workspace factory. */
export interface PluginWorkspace {
  resolveFingerprint(): Promise<string | null>;
  getSessionDir(sessionId: string): string | null;
  getChainState(sessionId: string): MutableChainState;
  invalidateChainState(sessionId: string): void;
  initChain(sessDir: string | null, sessionId: string): Promise<string>;
  appendAndTrack(
    event: ChainedAuditEvent,
    sessDir: string,
    trackChain: boolean,
    sessionId: string,
  ): Promise<void>;
  updateReviewAssurance(
    sessDir: string,
    update: (state: SessionState, now: string) => SessionState,
  ): Promise<void>;
  blockReviewOutcome(
    ctx: ReviewSessionContext,
    obligationId: string,
    code: string,
    detail: Record<string, string>,
    output: { output: string },
  ): Promise<void>;
  nextDecisionSequence(sessDir: string, sessionId: string): Promise<number>;
  runSerializedForSession(sessionId: string, task: () => Promise<void>): Promise<void>;
  getEnforcementState(sessionId: string): SessionEnforcementState;
  readonly cachedFingerprint: string | null;
  readonly cachedWsDir: string | null;
}

/**
 * Workspace service implementation.
 *
 * Owns mutable per-session state (chain states, queues, caches, enforcement states).
 * Each method is self-contained and testable in isolation.
 */
export class PluginWorkspaceImpl implements PluginWorkspace {
  private _cachedFingerprint: string | null = null;
  private _cachedWsDir: string | null = null;
  private readonly _chainStates = new Map<string, MutableChainState>();
  private readonly _sessionQueues = new Map<string, Promise<void>>();
  private readonly _decisionSequenceCache = new Map<string, number>();
  private readonly _enforcementStates = new Map<string, SessionEnforcementState>();

  constructor(private readonly _deps: WorkspaceDeps) {}

  get cachedFingerprint(): string | null {
    return this._cachedFingerprint;
  }

  get cachedWsDir(): string | null {
    return this._cachedWsDir;
  }

  // ── Workspace resolution ────────────────────────────────────────────────

  async resolveFingerprint(): Promise<string | null> {
    if (this._cachedFingerprint) return this._cachedFingerprint;
    if (!this._deps.auditWorktree) return null;
    try {
      const result = await computeFingerprint(this._deps.auditWorktree);
      this._cachedFingerprint = result.fingerprint;
      this._cachedWsDir = resolveWorkspaceDir(result.fingerprint);
      return this._cachedFingerprint;
    } catch {
      return null;
    }
  }

  getSessionDir(sessionId: string): string | null {
    if (!this._cachedFingerprint) return null;
    try {
      return resolveSessionDir(this._cachedFingerprint, sessionId);
    } catch {
      return null;
    }
  }

  // ── Chain state ─────────────────────────────────────────────────────────

  getChainState(sessionId: string): MutableChainState {
    let state = this._chainStates.get(sessionId);
    if (!state) {
      state = { initialized: false, lastHash: null };
      this._chainStates.set(sessionId, state);
    }
    return state;
  }

  invalidateChainState(sessionId: string): void {
    this._chainStates.delete(sessionId);
  }

  // ── Audit helpers ───────────────────────────────────────────────────────

  async initChain(sessDir: string | null, sessionId: string): Promise<string> {
    const cs = this.getChainState(sessionId);
    if (cs.initialized && cs.lastHash !== null) return cs.lastHash;
    if (!sessDir) {
      cs.lastHash = GENESIS_HASH;
      cs.initialized = true;
      return cs.lastHash;
    }
    const { events } = await readAuditTrail(sessDir);
    cs.lastHash = getLastChainHash(events);
    cs.initialized = true;
    return cs.lastHash;
  }

  async appendAndTrack(
    event: ChainedAuditEvent,
    sessDir: string,
    trackChain: boolean,
    sessionId: string,
  ): Promise<void> {
    await appendAuditEvent(sessDir, event);
    if (trackChain) {
      this.getChainState(sessionId).lastHash = event.chainHash;
    }
  }

  // ── State persistence ───────────────────────────────────────────────────

  async updateReviewAssurance(
    sessDir: string,
    update: (state: SessionState, now: string) => SessionState,
  ): Promise<void> {
    const current = await readState(sessDir);
    if (!current) return;
    const now = new Date().toISOString();
    const next = update(current, now);
    await writeState(sessDir, next);
  }

  async blockReviewOutcome(
    ctx: ReviewSessionContext,
    obligationId: string,
    code: string,
    detail: Record<string, string>,
    output: { output: string },
  ): Promise<void> {
    await this.updateReviewAssurance(ctx.sessDir, (s) => blockObligation(s, obligationId, code));
    await appendReviewAuditEvent(
      ctx.sessDir,
      ctx.sessionId,
      ctx.phase,
      'review:obligation_blocked',
      { obligationId, code },
    );
    output.output = strictBlockedOutput(code, detail);
  }

  // ── Session helpers ─────────────────────────────────────────────────────

  async nextDecisionSequence(sessDir: string, sessionId: string): Promise<number> {
    const cached = this._decisionSequenceCache.get(sessionId);
    if (cached !== undefined) {
      const next = cached + 1;
      this._decisionSequenceCache.set(sessionId, next);
      return next;
    }
    const { events } = await readAuditTrail(sessDir);
    const receipts = decisionReceipts(events).filter((r) => r.sessionId === sessionId);
    const maxSequence = receipts.reduce((max, r) => Math.max(max, r.decisionSequence), 0);
    const next = maxSequence + 1;
    this._decisionSequenceCache.set(sessionId, next);
    return next;
  }

  async runSerializedForSession(sessionId: string, task: () => Promise<void>): Promise<void> {
    const previous = this._sessionQueues.get(sessionId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(task)
      .finally(() => {
        if (this._sessionQueues.get(sessionId) === current) this._sessionQueues.delete(sessionId);
      });
    this._sessionQueues.set(sessionId, current);
    await current;
  }

  // ── Enforcement ─────────────────────────────────────────────────────────

  getEnforcementState(sessionId: string): SessionEnforcementState {
    let state = this._enforcementStates.get(sessionId);
    if (!state) {
      state = createEnforcementState();
      this._enforcementStates.set(sessionId, state);
    }
    return state;
  }
}

export function createWorkspace(deps: WorkspaceDeps): PluginWorkspace {
  const impl = new PluginWorkspaceImpl(deps);
  return {
    resolveFingerprint: () => impl.resolveFingerprint(),
    getSessionDir: (sid) => impl.getSessionDir(sid),
    getChainState: (sid) => impl.getChainState(sid),
    invalidateChainState: (sid) => impl.invalidateChainState(sid),
    initChain: (sd, sid) => impl.initChain(sd, sid),
    appendAndTrack: (e, sd, tc, sid) => impl.appendAndTrack(e, sd, tc, sid),
    updateReviewAssurance: (sd, u) => impl.updateReviewAssurance(sd, u),
    blockReviewOutcome: (ctx, oid, code, detail, out) =>
      impl.blockReviewOutcome(ctx, oid, code, detail, out),
    nextDecisionSequence: (sd, sid) => impl.nextDecisionSequence(sd, sid),
    runSerializedForSession: (sid, t) => impl.runSerializedForSession(sid, t),
    getEnforcementState: (sid) => impl.getEnforcementState(sid),
    get cachedFingerprint() {
      return impl.cachedFingerprint;
    },
    get cachedWsDir() {
      return impl.cachedWsDir;
    },
  };
}

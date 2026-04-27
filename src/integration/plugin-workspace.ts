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

export function createWorkspace(deps: WorkspaceDeps): PluginWorkspace {
  const { auditWorktree } = deps;
  let cachedFingerprint: string | null = null;
  let cachedWsDir: string | null = null;

  const chainStates = new Map<string, MutableChainState>();
  const sessionQueues = new Map<string, Promise<void>>();
  const decisionSequenceCache = new Map<string, number>();
  const enforcementStates = new Map<string, SessionEnforcementState>();

  // ── Workspace resolution ────────────────────────────────────────────────

  async function resolveFingerprint(): Promise<string | null> {
    if (cachedFingerprint) return cachedFingerprint;
    if (!auditWorktree) return null;
    try {
      const result = await computeFingerprint(auditWorktree);
      cachedFingerprint = result.fingerprint;
      cachedWsDir = resolveWorkspaceDir(result.fingerprint);
      return cachedFingerprint;
    } catch {
      return null;
    }
  }

  function getSessionDir(sessionId: string): string | null {
    if (!cachedFingerprint) return null;
    try {
      return resolveSessionDir(cachedFingerprint, sessionId);
    } catch {
      return null;
    }
  }

  // ── Chain state ─────────────────────────────────────────────────────────

  function getChainState(sessionId: string): MutableChainState {
    let state = chainStates.get(sessionId);
    if (!state) {
      state = { initialized: false, lastHash: null };
      chainStates.set(sessionId, state);
    }
    return state;
  }

  function invalidateChainState(sessionId: string): void {
    chainStates.delete(sessionId);
  }

  // ── Audit helpers ───────────────────────────────────────────────────────

  async function initChain(sessDir: string | null, sessionId: string): Promise<string> {
    const cs = getChainState(sessionId);
    if (cs.initialized && cs.lastHash !== null) return cs.lastHash;
    if (!sessDir) {
      cs.lastHash = GENESIS_HASH;
      cs.initialized = true;
      return cs.lastHash;
    }
    const { events } = await readAuditTrail(sessDir);
    cs.lastHash = getLastChainHash(events as unknown as Array<Record<string, unknown>>);
    cs.initialized = true;
    return cs.lastHash;
  }

  async function appendAndTrack(
    event: ChainedAuditEvent,
    sessDir: string,
    trackChain: boolean,
    sessionId: string,
  ): Promise<void> {
    await appendAuditEvent(sessDir, event);
    if (trackChain) {
      getChainState(sessionId).lastHash = event.chainHash;
    }
  }

  // ── State persistence ───────────────────────────────────────────────────

  async function updateReviewAssurance(
    sessDir: string,
    update: (state: SessionState, now: string) => SessionState,
  ): Promise<void> {
    const current = await readState(sessDir);
    if (!current) return;
    const now = new Date().toISOString();
    const next = update(current, now);
    await writeState(sessDir, next);
  }

  async function blockReviewOutcome(
    ctx: ReviewSessionContext,
    obligationId: string,
    code: string,
    detail: Record<string, string>,
    output: { output: string },
  ): Promise<void> {
    await updateReviewAssurance(ctx.sessDir, (s) => blockObligation(s, obligationId, code));
    await appendReviewAuditEvent(
      ctx.sessDir,
      ctx.sessionId,
      ctx.phase,
      'review:obligation_blocked',
      {
        obligationId,
        code,
      },
    );
    output.output = strictBlockedOutput(code, detail);
  }

  // ── Session helpers ─────────────────────────────────────────────────────

  async function nextDecisionSequence(sessDir: string, sessionId: string): Promise<number> {
    const cached = decisionSequenceCache.get(sessionId);
    if (cached !== undefined) {
      const next = cached + 1;
      decisionSequenceCache.set(sessionId, next);
      return next;
    }
    const { events } = await readAuditTrail(sessDir);
    const receipts = decisionReceipts(events).filter((r) => r.sessionId === sessionId);
    const maxSequence = receipts.reduce((max, r) => Math.max(max, r.decisionSequence), 0);
    const next = maxSequence + 1;
    decisionSequenceCache.set(sessionId, next);
    return next;
  }

  async function runSerializedForSession(
    sessionId: string,
    task: () => Promise<void>,
  ): Promise<void> {
    const previous = sessionQueues.get(sessionId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(task)
      .finally(() => {
        if (sessionQueues.get(sessionId) === current) sessionQueues.delete(sessionId);
      });
    sessionQueues.set(sessionId, current);
    await current;
  }

  // ── Enforcement ─────────────────────────────────────────────────────────

  function getEnforcementState(sessionId: string): SessionEnforcementState {
    let state = enforcementStates.get(sessionId);
    if (!state) {
      state = createEnforcementState();
      enforcementStates.set(sessionId, state);
    }
    return state;
  }

  return {
    resolveFingerprint,
    getSessionDir,
    getChainState,
    invalidateChainState,
    initChain,
    appendAndTrack,
    updateReviewAssurance,
    blockReviewOutcome,
    nextDecisionSequence,
    runSerializedForSession,
    getEnforcementState,
    get cachedFingerprint() {
      return cachedFingerprint;
    },
    get cachedWsDir() {
      return cachedWsDir;
    },
  };
}

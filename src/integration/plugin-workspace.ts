/**
 * @module integration/plugin-workspace
 * @description Workspace resolution, hash chain, and state helpers — extracted from plugin.ts.
 *
 * Provides the closure-coupled helper functions that plugin.ts previously defined
 * inline. Takes mutable state objects (cachedFingerprint, chainStates, etc.) as
 * constructor parameters to enable testability and clear ownership boundaries.
 *
 * @version v1
 */

import {
  writeState,
  readState,
  appendAuditEvent,
  readAuditTrail,
} from '../adapters/persistence.js';
import {
  computeFingerprint,
  sessionDir as resolveSessionDir,
} from '../adapters/workspace/index.js';
import { GENESIS_HASH, type ChainedAuditEvent } from '../audit/types.js';
import { decisionReceipts } from '../audit/query.js';
import { getLastChainHash } from '../audit/integrity.js';
import { resolvePluginSessionPolicy } from './plugin-policy.js';
import { createSessionState as createEnforcementState } from './review-enforcement.js';
import type { SessionEnforcementState } from './review-enforcement.js';
import type { SessionState } from '../state/schema.js';

/** Mutable per-session chain state. */
export type MutableChainState = {
  initialized: boolean;
  lastHash: string | null;
};

/** Services provided by the workspace module. */
export interface PluginWorkspace {
  resolveFingerprint(): Promise<string | null>;
  getSessionDir(sessionId: string): string | null;
  getChainState(sessionId: string): MutableChainState;
  initChain(sessDir: string | null, sessionId: string): Promise<string>;
  appendAndTrack(
    event: { chainHash?: string },
    sessDir: string,
    trackChain: boolean,
    sessionId: string,
  ): Promise<void>;
  nextDecisionSequence(sessDir: string, sessionId: string): Promise<number>;
  updateReviewAssurance(
    sessDir: string,
    update: (state: SessionState, now: string) => SessionState,
  ): Promise<void>;
  resolveSessionPolicy(sessDir: string): Promise<{
    policy: {
      mode: string;
      requireHumanGates: boolean;
      actorClassification: Record<string, string>;
      audit: { emitToolCalls: boolean; emitTransitions: boolean; enableChainHash: boolean };
    };
    state: SessionState | null;
  }>;
  runSerializedForSession(sessionId: string, task: () => Promise<void>): Promise<void>;
  getEnforcementState(sessionId: string): SessionEnforcementState;
  readonly cachedFingerprint: string | null;
  readonly config: {
    policy: { defaultMode?: string };
  };
}

/**
 * Create workspace services for a plugin instance.
 */
export function createWorkspace(
  auditWorktree: string | undefined,
  config: { policy: { defaultMode?: string } },
): PluginWorkspace {
  let cachedFingerprint: string | null = null;
  const chainStates = new Map<string, MutableChainState>();
  const sessionQueues = new Map<string, Promise<void>>();
  const decisionSequenceCache = new Map<string, number>();
  const enforcementStates = new Map<string, SessionEnforcementState>();

  async function resolveFingerprint(): Promise<string | null> {
    if (cachedFingerprint) return cachedFingerprint;
    if (!auditWorktree) return null;
    try {
      const result = await computeFingerprint(auditWorktree);
      cachedFingerprint = result.fingerprint;
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

  function getChainState(sessionId: string): MutableChainState {
    let state = chainStates.get(sessionId);
    if (!state) {
      state = { initialized: false, lastHash: null };
      chainStates.set(sessionId, state);
    }
    return state;
  }

  async function initChain(sessDir: string | null, sessionId: string): Promise<string> {
    const cs = getChainState(sessionId);
    if (cs.initialized && cs.lastHash !== null) return cs.lastHash;
    try {
      if (!sessDir) {
        cs.lastHash = GENESIS_HASH;
        cs.initialized = true;
        return cs.lastHash;
      }
      const { events } = await readAuditTrail(sessDir);
      cs.lastHash = getLastChainHash(events as unknown as Array<Record<string, unknown>>);
      cs.initialized = true;
      return cs.lastHash;
    } catch {
      cs.lastHash = GENESIS_HASH;
      cs.initialized = true;
      return cs.lastHash;
    }
  }

  async function appendAndTrack(
    event: { chainHash?: string },
    sessDir: string,
    trackChain: boolean,
    sessionId: string,
  ): Promise<void> {
    await appendAuditEvent(sessDir, event as unknown as ChainedAuditEvent);
    if (trackChain) {
      getChainState(sessionId).lastHash = event.chainHash!;
    }
  }

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

  async function resolveSessionPolicy(sessDir: string) {
    const result = await resolvePluginSessionPolicy({
      sessDir,
      configDefaultMode: config.policy.defaultMode as
        | 'solo'
        | 'team'
        | 'team-ci'
        | 'regulated'
        | undefined,
    });
    return {
      policy: {
        mode: result.policy.mode,
        requireHumanGates: result.policy.requireHumanGates,
        actorClassification: result.policy.actorClassification,
        audit: result.policy.audit,
      },
      state: result.state,
    };
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
        if (sessionQueues.get(sessionId) === current) {
          sessionQueues.delete(sessionId);
        }
      });
    sessionQueues.set(sessionId, current);
    await current;
  }

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
    initChain,
    appendAndTrack,
    nextDecisionSequence,
    updateReviewAssurance,
    resolveSessionPolicy,
    runSerializedForSession,
    getEnforcementState,
    get cachedFingerprint() {
      return cachedFingerprint;
    },
    get config() {
      return config;
    },
  };
}

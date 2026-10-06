/**
 * @module integration/plugin-audit-test-helpers
 * @description Shared AuditDeps factory and fixed identities for plugin-audit
 *              test suites. Import target only — never executed as a test suite.
 */

import { vi } from 'vitest';
import { makeState } from '../fixtures.js';
import type { SessionState } from '../state/schema.js';
import type { SessionAuthorityResolution } from '../adapters/session-authority.js';
import type { AuditDeps } from './plugin-audit.js';

export const SESSION_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
export const FIXED_DECISION_AT = '2026-05-15T12:00:00.000Z';

let chainSeq: number;

export function resetChainSeq(): void {
  chainSeq = 0;
}

/** Canonical resolved authority for the shared session fixture. */
export function resolvedAuthority(
  state: SessionState,
  sessDir = '/tmp/sess-dir',
): Extract<SessionAuthorityResolution, { status: 'resolved' }> {
  return {
    status: 'resolved',
    sessDir,
    worktreeRoot: '/tmp/worktree',
    fingerprint: state.binding.fingerprint,
    state,
  };
}

/** Positively absent authority (canonical location known, no state). */
export function absentAuthority(
  sessDir = '/tmp/sess-dir',
): Extract<SessionAuthorityResolution, { status: 'absent' }> {
  return {
    status: 'absent',
    sessDir,
    worktreeRoot: '/tmp/worktree',
    fingerprint: 'fp-abc',
  };
}

/** Unavailable authority (location or binding not provable). */
export function unavailableAuthority(
  code:
    | 'NO_WORKTREE'
    | 'NOT_GIT_REPO'
    | 'WORKTREE_MISMATCH'
    | 'SESSION_BINDING_MISMATCH' = 'NO_WORKTREE',
): Extract<SessionAuthorityResolution, { status: 'unavailable' }> {
  return { status: 'unavailable', code, reason: 'test authority unavailable' };
}

export function makeDeps(overrides: Partial<AuditDeps> = {}): AuditDeps {
  const state = makeState('PLAN');
  return {
    resolveSessionAuthority: vi.fn().mockResolvedValue(resolvedAuthority(state)),
    resolveSessionPolicy: vi.fn().mockResolvedValue({
      policy: {
        audit: { emitToolCalls: true, emitTransitions: true, enableChainHash: true },
        actorClassification: {},
        mode: 'solo',
        requireHumanGates: false,
      },
      state,
    }),
    initChain: vi.fn().mockResolvedValue('prev-hash-001'),
    invalidateChainState: vi.fn(),
    // Chain-threading contract: appendAndTrack mutates evt.chainHash.
    // plugin-audit.ts reads evt.chainHash! after every call to thread prevHash.
    appendAndTrack: vi.fn(async (evt: Record<string, unknown>) => {
      evt.chainHash = `chain-${String(chainSeq++).padStart(3, '0')}`;
    }),
    nextDecisionSequence: vi.fn().mockResolvedValue(1),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    logError: vi.fn(),
    mode: 'solo',
    ...overrides,
  };
}

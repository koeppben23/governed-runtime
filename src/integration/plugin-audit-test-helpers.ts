/**
 * @module integration/plugin-audit-test-helpers
 * @description Shared AuditDeps factory and fixed identities for plugin-audit
 *              test suites. Import target only — never executed as a test suite.
 */

import { vi } from 'vitest';
import { makeState } from '../fixtures.js';
import type { AuditDeps } from './plugin-audit.js';

export const SESSION_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
export const FIXED_DECISION_AT = '2026-05-15T12:00:00.000Z';

let chainSeq: number;

export function resetChainSeq(): void {
  chainSeq = 0;
}

export function makeDeps(overrides: Partial<AuditDeps> = {}): AuditDeps {
  return {
    resolveFingerprint: vi.fn().mockResolvedValue('fp-abc'),
    getSessionDir: vi.fn().mockReturnValue('/tmp/sess-dir'),
    resolveSessionPolicy: vi.fn().mockResolvedValue({
      policy: {
        audit: { emitToolCalls: true, emitTransitions: true, enableChainHash: true },
        actorClassification: {},
        mode: 'solo',
        requireHumanGates: false,
      },
      state: makeState('PLAN'),
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
    cachedFingerprint: 'fp-abc',
    mode: 'solo',
    ...overrides,
  };
}

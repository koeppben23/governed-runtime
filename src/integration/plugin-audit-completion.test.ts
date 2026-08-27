import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendAuditEvent, readAuditTrail } from '../adapters/persistence-audit.js';
import { writeState } from '../adapters/persistence.js';
import { makeState } from '../fixtures.js';
import {
  buildTransitionBody,
  finalizeWithTimestampEvidence,
  type EventBody,
} from '../audit/types.js';
import type { PendingAuditOperation, SessionState } from '../state/schema.js';
import { runAudit, type AuditDeps } from './plugin-audit.js';

const SESSION_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const COMPLETED_AT = '2026-05-15T12:00:00.000Z';
const sessionDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    sessionDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

function completedState(): SessionState {
  const state = makeState('COMPLETE', {
    id: SESSION_ID,
    transition: {
      from: 'EVIDENCE_REVIEW',
      to: 'COMPLETE',
      event: 'IMPL_COMPLETE',
      at: COMPLETED_AT,
    },
  });
  const operation: Extract<PendingAuditOperation, { kind: 'transition' }> = {
    kind: 'transition',
    operationId: 'bbbbbbbb-0000-4000-8000-000000000001',
    preStateDigest: 'a'.repeat(64),
    mutationDigest: 'b'.repeat(64),
    postStateDigest: 'c'.repeat(64),
    auditEventDigest: 'd'.repeat(64),
    status: 'reconciled',
    transition: { ...state.transition!, chainIndex: 0, autoAdvanced: false },
  };
  return {
    ...state,
    policySnapshot: { ...state.policySnapshot, mode: 'team' },
    pendingAuditOperations: [operation],
  };
}

async function completionDeps(state: SessionState): Promise<{ deps: AuditDeps; sessDir: string }> {
  const sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-completion-'));
  sessionDirs.push(sessDir);
  await writeState(sessDir, state);
  const terminalOperation = state.pendingAuditOperations.find(
    (operation): operation is Extract<PendingAuditOperation, { kind: 'transition' }> =>
      operation.kind === 'transition' && operation.transition.to === 'COMPLETE',
  );
  if (terminalOperation) {
    const body = buildTransitionBody(
      state.flowguardSessionId,
      state.binding.hostSessionId,
      terminalOperation.transition.to,
      {
        operationId: terminalOperation.operationId,
        preStateDigest: terminalOperation.preStateDigest,
        mutationDigest: terminalOperation.mutationDigest,
        postStateDigest: terminalOperation.postStateDigest,
        from: terminalOperation.transition.from,
        to: terminalOperation.transition.to,
        event: terminalOperation.transition.event,
        autoAdvanced: terminalOperation.transition.autoAdvanced,
        chainIndex: terminalOperation.transition.chainIndex,
      },
      terminalOperation.transition.at,
      'genesis',
    );
    await appendAuditEvent(sessDir, finalizeWithTimestampEvidence(body, 'genesis'));
  }
  const appendAndTrack = vi.fn(async (event: { chainHash?: string }) => {
    const persisted = await appendAuditEvent(sessDir, event as EventBody);
    event.chainHash = persisted.chainHash;
  });
  return {
    sessDir,
    deps: {
      resolveFingerprint: vi.fn().mockResolvedValue('fp-abc'),
      getSessionDir: vi.fn().mockReturnValue(sessDir),
      resolveSessionPolicy: vi.fn().mockResolvedValue({
        policy: {
          audit: { emitToolCalls: true, emitTransitions: true, enableChainHash: true },
          actorClassification: {},
          mode: 'team',
          requireHumanGates: true,
        },
        state,
      }),
      initChain: vi.fn().mockResolvedValue('genesis'),
      invalidateChainState: vi.fn(),
      appendAndTrack,
      nextDecisionSequence: vi.fn().mockResolvedValue(1),
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      logError: vi.fn(),
      cachedFingerprint: 'fp-abc',
      mode: 'team',
    },
  };
}

function completionCount(events: Awaited<ReturnType<typeof readAuditTrail>>['events']): number {
  return events.filter((event) => event.event === 'lifecycle:session_completed').length;
}

describe('plugin audit completion idempotency', () => {
  it('emits one completion across final decision, status, and archive hooks', async () => {
    const { deps, sessDir } = await completionDeps(completedState());
    for (const tool of [
      'flowguard_decision',
      'flowguard_status',
      'flowguard_status',
      'flowguard_archive',
      'flowguard_status',
    ]) {
      await runAudit(deps, tool, {}, { phase: 'COMPLETE', error: false }, SESSION_ID);
    }

    const { events } = await readAuditTrail(sessDir);
    expect(completionCount(events)).toBe(1);
    expect(events.find((event) => event.event === 'lifecycle:session_completed')?.occurredAt).toBe(
      COMPLETED_AT,
    );
  });

  it('deduplicates concurrent completion emissions under the audit lock', async () => {
    const { deps, sessDir } = await completionDeps(completedState());
    await Promise.all([
      runAudit(deps, 'flowguard_status', {}, { phase: 'COMPLETE', error: false }, SESSION_ID),
      runAudit(deps, 'flowguard_status', {}, { phase: 'COMPLETE', error: false }, SESSION_ID),
    ]);

    expect(completionCount((await readAuditTrail(sessDir)).events)).toBe(1);
  });

  it.each(['missing', 'ambiguous'] as const)(
    'blocks regulated completion when terminal authority is %s',
    async (authority) => {
      const state = completedState();
      const operation = state.pendingAuditOperations[0]!;
      const invalid = {
        ...state,
        policySnapshot: { ...state.policySnapshot, mode: 'regulated' as const },
        pendingAuditOperations:
          authority === 'missing'
            ? []
            : [operation, { ...operation, operationId: 'cccccccc-0000-4000-8000-000000000001' }],
      };
      const { deps, sessDir } = await completionDeps(invalid);
      deps.mode = 'regulated';
      vi.mocked(deps.resolveSessionPolicy).mockResolvedValue({
        policy: {
          audit: { emitToolCalls: false, emitTransitions: false, enableChainHash: true },
          actorClassification: {},
          mode: 'regulated',
          requireHumanGates: true,
        },
        state: invalid,
      });

      await expect(
        runAudit(deps, 'flowguard_status', {}, { phase: 'COMPLETE', error: false }, SESSION_ID),
      ).resolves.toMatchObject({
        block: true,
        code: 'AUDIT_TERMINAL_TRANSITION_AUTHORITY_UNAVAILABLE',
      });
      expect(completionCount((await readAuditTrail(sessDir)).events)).toBe(0);
    },
  );

  it.each([
    ['from', { from: 'IMPL_REVIEW' as const }],
    ['to', { to: 'PLAN' as const }],
    ['event', { event: 'APPROVE' as const }],
    ['at', { at: '2026-05-15T12:00:01.000Z' }],
  ])('blocks regulated completion when terminal operation %s differs', async (_field, mismatch) => {
    const state = completedState();
    const operation = state.pendingAuditOperations[0]!;
    if (operation.kind !== 'transition')
      throw new TypeError('expected terminal transition operation');
    const invalid = {
      ...state,
      policySnapshot: { ...state.policySnapshot, mode: 'regulated' as const },
      pendingAuditOperations: [
        {
          ...operation,
          transition: { ...operation.transition, ...mismatch },
        },
      ],
    };
    const { deps, sessDir } = await completionDeps(invalid);
    deps.mode = 'regulated';
    vi.mocked(deps.resolveSessionPolicy).mockResolvedValue({
      policy: {
        audit: { emitToolCalls: false, emitTransitions: false, enableChainHash: true },
        actorClassification: {},
        mode: 'regulated',
        requireHumanGates: true,
      },
      state: invalid,
    });

    await expect(
      runAudit(deps, 'flowguard_status', {}, { phase: 'COMPLETE', error: false }, SESSION_ID),
    ).resolves.toMatchObject({
      block: true,
      code: 'AUDIT_TERMINAL_TRANSITION_AUTHORITY_UNAVAILABLE',
    });
    expect(completionCount((await readAuditTrail(sessDir)).events)).toBe(0);
  });
});

/**
 * @module integration/plugin-audit-session-authority
 * @description Authority symmetry between the audit reconciler and the
 *              generic post-tool audit path.
 *
 * `resolveAuditContext` resolves the session directory through the CACHED
 * fingerprint. When the fingerprint could not be computed — a transient
 * failure, or a cold process that has not resolved one yet — `getSessionDir`
 * returns null, which is indistinguishable from "this session does not exist".
 *
 * `reconcilePendingAuditOperations` already treats that correctly: it proves
 * absence positively through the canonical resolution authority and fails
 * closed with `AUDIT_SESSION_AUTHORITY_UNAVAILABLE` otherwise. `runAudit`
 * returned `undefined` and skipped the audit silently, so a governed tool call
 * could produce no audit record at all while reporting success.
 */

import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeState } from '../adapters/persistence.js';
import { makeState } from '../fixtures.js';
import { runAudit, type AuditDeps } from './plugin-audit.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

function makeDeps(overrides: Partial<AuditDeps> = {}): AuditDeps {
  return {
    // A cold or failed fingerprint resolution: the mapping is unavailable,
    // NOT proof that the session is absent.
    resolveFingerprint: vi.fn().mockResolvedValue(null),
    getSessionDir: vi.fn().mockReturnValue(null),
    resolveSessionPolicy: vi.fn().mockRejectedValue(new Error('unreachable')),
    initChain: vi.fn().mockResolvedValue('prev-hash-001'),
    invalidateChainState: vi.fn(),
    appendAndTrack: vi.fn(),
    nextDecisionSequence: vi.fn().mockResolvedValue(1),
    mode: 'regulated',
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    logError: vi.fn(),
    ...overrides,
  } as unknown as AuditDeps;
}

async function withSessionDir<T>(fn: (sessDir: string) => Promise<T>): Promise<T> {
  const sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-audit-authority-'));
  try {
    return await fn(sessDir);
  } finally {
    await fs.rm(sessDir, { recursive: true, force: true });
  }
}

describe('runAudit session authority', () => {
  it('fails closed when the mapping is missing but canonical state exists', async () => {
    await withSessionDir(async (sessDir) => {
      await writeState(sessDir, makeState('PLAN', { id: SESSION_ID }));
      const deps = makeDeps({
        resolveCanonicalSessionDir: vi.fn().mockResolvedValue({ status: 'resolved', sessDir }),
      } as Partial<AuditDeps>);

      const result = await runAudit(deps, 'flowguard_plan', {}, {}, SESSION_ID);

      expect(result).toMatchObject({
        auditOk: false,
        block: true,
        code: 'AUDIT_SESSION_AUTHORITY_UNAVAILABLE',
      });
    });
  });

  it('fails closed when the canonical resolution authority is itself unavailable', async () => {
    // Unavailable must never be treated as absent.
    const deps = makeDeps({
      resolveCanonicalSessionDir: vi.fn().mockResolvedValue({ status: 'unavailable' }),
    } as Partial<AuditDeps>);

    const result = await runAudit(deps, 'flowguard_plan', {}, {}, SESSION_ID);

    expect(result).toMatchObject({
      auditOk: false,
      block: true,
      code: 'AUDIT_SESSION_AUTHORITY_UNAVAILABLE',
    });
  });

  it('stays silent when the session is positively proven absent', async () => {
    // A tool call outside any governed session must not be blocked. This is
    // the only case the silent return was ever correct for.
    await withSessionDir(async (sessDir) => {
      const deps = makeDeps({
        resolveCanonicalSessionDir: vi.fn().mockResolvedValue({ status: 'resolved', sessDir }),
      } as Partial<AuditDeps>);

      await expect(runAudit(deps, 'flowguard_plan', {}, {}, SESSION_ID)).resolves.toBeUndefined();
    });
  });

  it('stays silent for a resolved but unhydrated session', async () => {
    // Mapping resolves, no state yet: absence is positively established.
    await withSessionDir(async (sessDir) => {
      const deps = makeDeps({
        resolveFingerprint: vi.fn().mockResolvedValue('fp-abc'),
        getSessionDir: vi.fn().mockReturnValue(sessDir),
        resolveSessionPolicy: vi.fn().mockResolvedValue({
          policy: {
            audit: { emitToolCalls: true, emitTransitions: true, enableChainHash: true },
            actorClassification: {},
            mode: 'regulated',
            requireHumanGates: false,
          },
          state: null,
        }),
      });

      await expect(runAudit(deps, 'flowguard_plan', {}, {}, SESSION_ID)).resolves.toBeUndefined();
    });
  });
});

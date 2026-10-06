/**
 * @module integration/plugin-audit-session-authority
 * @description The audit path fails closed whenever the single canonical
 *              session authority cannot positively establish the session.
 *
 * A cold or failed resolution is `unavailable`, NOT proof that the session is
 * absent. Only a positive `absent` outcome may skip the audit silently;
 * `unavailable` blocks with `AUDIT_SESSION_AUTHORITY_UNAVAILABLE` (carrying the
 * typed root cause) so a governed tool call can never produce no audit record
 * while reporting success.
 */

import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeState } from '../adapters/persistence.js';
import { makeState } from '../fixtures.js';
import { runAudit, type AuditDeps } from './plugin-audit.js';
import { absentAuthority, unavailableAuthority } from './plugin-audit-test-helpers.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

function makeDeps(overrides: Partial<AuditDeps> = {}): AuditDeps {
  return {
    // The authority cannot prove the session location: unavailable, NOT absent.
    resolveSessionAuthority: vi.fn().mockResolvedValue(unavailableAuthority('NO_WORKTREE')),
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
  it('fails closed when the session location cannot be proven even though state exists on disk', async () => {
    await withSessionDir(async (sessDir) => {
      await writeState(sessDir, makeState('PLAN', { id: SESSION_ID }));
      const deps = makeDeps({
        resolveSessionAuthority: vi.fn().mockResolvedValue(unavailableAuthority('NO_WORKTREE')),
      });

      const result = await runAudit(deps, 'flowguard_plan', {}, {}, SESSION_ID);

      expect(result).toMatchObject({
        auditOk: false,
        block: true,
        code: 'AUDIT_SESSION_AUTHORITY_UNAVAILABLE',
        causeCode: 'NO_WORKTREE',
      });
    });
  });

  it('fails closed when the canonical resolution authority is itself unavailable', async () => {
    // Unavailable must never be treated as absent.
    const deps = makeDeps({
      resolveSessionAuthority: vi.fn().mockResolvedValue(unavailableAuthority('NOT_GIT_REPO')),
    });

    const result = await runAudit(deps, 'flowguard_plan', {}, {}, SESSION_ID);

    expect(result).toMatchObject({
      auditOk: false,
      block: true,
      code: 'AUDIT_SESSION_AUTHORITY_UNAVAILABLE',
      causeCode: 'NOT_GIT_REPO',
    });
  });

  it('stays silent when the session is positively proven absent', async () => {
    // A tool call outside any governed session must not be blocked. This is
    // the only case the silent return was ever correct for.
    await withSessionDir(async (sessDir) => {
      const deps = makeDeps({
        resolveSessionAuthority: vi.fn().mockResolvedValue(absentAuthority(sessDir)),
      });

      await expect(runAudit(deps, 'flowguard_plan', {}, {}, SESSION_ID)).resolves.toBeUndefined();
      expect(deps.resolveSessionPolicy).not.toHaveBeenCalled();
      expect(deps.appendAndTrack).not.toHaveBeenCalled();
    });
  });

  it('stays silent for a resolved but unhydrated session', async () => {
    // A known canonical location with no state yet is positively absent:
    // never resolved-with-null-state, and never an audit record.
    await withSessionDir(async (sessDir) => {
      await fs.mkdir(path.join(sessDir, 'without-state'), { recursive: true });
      const deps = makeDeps({
        resolveSessionAuthority: vi.fn().mockResolvedValue(absentAuthority(sessDir)),
        resolveSessionPolicy: vi.fn().mockRejectedValue(new Error('unreachable')),
      });

      await expect(runAudit(deps, 'flowguard_plan', {}, {}, SESSION_ID)).resolves.toBeUndefined();
      expect(deps.resolveSessionAuthority).toHaveBeenCalledWith(SESSION_ID);
      expect(deps.resolveSessionPolicy).not.toHaveBeenCalled();
    });
  });
});

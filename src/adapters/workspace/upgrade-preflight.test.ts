/**
 * @module workspace/upgrade-preflight.test
 * @description Empty-evidence classification at the upgrade boundary.
 *
 * `verifyChain([])` is vacuously valid, so an empty audit file must be decided
 * by the caller that knows whether evidence is expected. These tests pin that
 * split: an archive member with no record is never "compatible", and an empty
 * live trail is only acceptable when the persisted state proves no prior audit
 * evidence.
 *
 * @test-policy EDGE, BAD
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { classifyAuditMember, classifyLiveAudit } from './upgrade-preflight.js';
import { hasPublishedAuditEvidence } from '../persistence-audit-continuity.js';
import type { SessionState } from '../../state/schema.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function makeSessionDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-upgrade-preflight-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const liveState = (hasAuditEvidence: boolean | null): Parameters<typeof classifyLiveAudit>[2] => ({
  status: 'ok',
  phase: 'COMPLETE',
  terminal: true,
  findings: [],
  hasAuditEvidence,
});

/** Minimal state shape for the canonical "prior audit evidence" predicate. */
function stateWithEvidence(overrides: Partial<SessionState>): SessionState {
  return {
    auditOutboxCheckpoint: undefined,
    pendingAuditOperations: [],
    ...overrides,
  } as unknown as SessionState;
}

describe('upgrade preflight audit classification', () => {
  it('BAD: an archived audit member without records cannot be classified', () => {
    expect(classifyAuditMember({ kind: 'ok', content: '' })).toBe('unknown');
    expect(classifyAuditMember({ kind: 'ok', content: '\n  \n\t\n' })).toBe('unknown');
  });

  it('BAD: an archived non-v3 record is incompatible, not merely invalid', () => {
    expect(classifyAuditMember({ kind: 'ok', content: '{"event":"state_write"}\n' })).toBe(
      'incompatible',
    );
  });

  it('BAD: a blocked archive member stays unknown', () => {
    expect(classifyAuditMember({ kind: 'blocked' })).toBe('unknown');
  });

  it('EDGE: an empty live trail is acceptable only without persisted evidence', async () => {
    const dir = await makeSessionDir();
    await fs.writeFile(path.join(dir, 'audit.jsonl'), '', 'utf-8');

    const fresh = await classifyLiveAudit(dir, 'session-a', liveState(false));
    expect(fresh.status).toBe('ok');
    expect(fresh.findings).toEqual([]);

    const undecidable = await classifyLiveAudit(dir, 'session-a', liveState(null));
    expect(undecidable.status).toBe('ok');
  });

  it('BAD: an empty live trail with persisted audit evidence is a blocker', async () => {
    const dir = await makeSessionDir();
    await fs.writeFile(path.join(dir, 'audit.jsonl'), '\n', 'utf-8');

    const result = await classifyLiveAudit(dir, 'session-b', liveState(true));
    expect(result.status).toBe('invalid');
    expect(result.findings).toContainEqual(
      expect.objectContaining({ severity: 'blocker', code: 'AUDIT_EVIDENCE_MISSING' }),
    );
  });

  it('EDGE: a retired outbox checkpoint proves prior audit evidence', () => {
    expect(hasPublishedAuditEvidence(stateWithEvidence({}))).toBe(false);
    expect(
      hasPublishedAuditEvidence(
        stateWithEvidence({
          pendingAuditOperations: [
            { status: 'state_committed' },
          ] as SessionState['pendingAuditOperations'],
        }),
      ),
    ).toBe(false);
    expect(
      hasPublishedAuditEvidence(
        stateWithEvidence({
          pendingAuditOperations: [
            { status: 'audit_committed' },
          ] as SessionState['pendingAuditOperations'],
        }),
      ),
    ).toBe(true);
    expect(
      hasPublishedAuditEvidence(
        stateWithEvidence({
          auditOutboxCheckpoint: {
            version: 1,
            reconciledCount: 1,
            lastOperationId: 'op-1',
            auditSequence: 1,
            chainHash: 'hash',
            auditEventDigest: 'digest',
          },
        }),
      ),
    ).toBe(true);
  });
});

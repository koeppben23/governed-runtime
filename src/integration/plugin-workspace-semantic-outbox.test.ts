/** @module integration/plugin-workspace-semantic-outbox — Idempotent retry persistence. */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { readState, writeState } from '../adapters/persistence.js';
import { makeState } from '../fixtures.js';
import { PluginWorkspaceImpl } from './plugin-workspace.js';
import { freezeReviewMaterial } from './review/assurance.js';
import { blockObligation } from './review/obligation-state.js';

const NOW = '2026-05-15T12:00:00.000Z';
const OBLIGATION_ID = '33333333-3333-4333-8333-333333333333';

describe('PluginWorkspaceImpl semantic outbox', () => {
  it('persists an auditworthy idempotent blocked-review retry', async () => {
    const sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-semantic-retry-'));
    try {
      const base = makeState('PLAN');
      const blocked = makeState('PLAN', {
        reviewAssurance: {
          assuranceSchemaVersion: 'review-assurance.v6',
          obligations: [
            {
              obligationId: OBLIGATION_ID,
              obligationType: 'plan',
              requiredChallengeCount: 0,
              requiredChallengeKind: 'design_challenge',
              challengePolicyVersion: 'challenge-policy.v1',
              subjectDigest: 'subject-digest',
              reviewMaterial: freezeReviewMaterial('frozen review material', 'subject-digest'),
              repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
              iteration: 1,
              planVersion: 1,
              criteriaVersion: 'review-criteria.v1',
              mandateDigest: 'mandate-digest',
              maxReviewerOutputRepairAttempts: 1,
              createdAt: NOW,
              pluginHandshakeAt: NOW,
              status: 'blocked',
              invocationId: null,
              blockedCode: 'REVIEWER_INVOCATION_EXHAUSTED',
              fulfilledAt: null,
              consumedAt: null,
              reviewSubjectScope: {
                kind: 'repository_change',
                paths: ['src/a.ts'],
                revisions: ['head'],
              },
            },
          ],
          invocations: [],
          attempts: [],
          dispatches: [],
        },
        policySnapshot: base.policySnapshot,
      });
      await writeState(sessDir, blocked);

      const workspace = new PluginWorkspaceImpl({ auditWorktree: undefined });
      await expect(
        workspace.updateReviewAssurance(
          sessDir,
          (state) => blockObligation(state, OBLIGATION_ID, 'REVIEWER_INVOCATION_EXHAUSTED'),
          (state) => [
            {
              phase: state.phase,
              event: 'review:obligation_blocked',
              occurredAt: NOW,
              detail: { obligationId: OBLIGATION_ID, code: 'REVIEWER_INVOCATION_EXHAUSTED' },
            },
          ],
        ),
      ).resolves.toBeUndefined();

      const persisted = await readState(sessDir);
      expect(persisted!.reviewAssurance!.obligations[0]!.blockedCode).toBe(
        'REVIEWER_INVOCATION_EXHAUSTED',
      );
      expect(persisted!.pendingAuditOperations).toHaveLength(1);
      expect(persisted!.pendingAuditOperations[0]).toMatchObject({
        kind: 'semantic',
        preStateDigest: persisted!.pendingAuditOperations[0]!.postStateDigest,
      });
    } finally {
      await fs.rm(sessDir, { recursive: true, force: true });
    }
  });
});

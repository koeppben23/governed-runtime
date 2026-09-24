/**
 * @module integration/plugin-direct-writer-proofgraph
 * @description Regression tests for the direct metadata write channel.
 *
 * `writeStateWithAuditOperationsAlreadyLocked` and its locking wrapper persist
 * runtime and audit metadata without running implementation-entry finalization
 * or ProofGraph refresh. These tests pin the channel contract:
 * - metadata writes preserve the persisted projection and the frozen base;
 * - every new audit operation binds the state the write actually persisted;
 * - an absent implementation base still fails closed at the persistence
 *   boundary;
 * - a derivation-input change through the direct channel is rejected instead of
 *   persisting a stale projection.
 *
 * @test-policy HAPPY, BAD, CORNER
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { readState, writeState } from '../adapters/persistence.js';
import { makeProgressedState } from '../fixtures.js';
import { buildStateWriteBody } from '../audit/types.js';
import { buildSemanticAuditBody } from '../audit/semantic-event.js';
import { computeCanonicalEventDigest } from '../audit/canonical-digest.js';
import { computeStateDigest, writeStateWithAuditOperations } from './audit-outbox.js';
import { recordMutationCompletion } from './plugin-mutation-episodes.js';
import { PluginWorkspaceImpl } from './plugin-workspace.js';
import { freezeReviewMaterial } from './review/obligations/assurance.js';
import { blockObligation } from './review/obligations/obligation-state.js';
import { writeStateWithArtifacts } from './tools/helpers.js';
import type { SessionState } from '../state/schema.js';

const CLAIM_ID = '10000000-0000-4000-8000-00000000000a';
const OBLIGATION_ID = '33333333-3333-4333-8333-333333333333';
const NOW = '2026-06-01T00:00:00.000Z';

let sessDir: string;

beforeEach(async () => {
  sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-direct-writer-'));
});

afterEach(async () => {
  await fs.rm(sessDir, { recursive: true, force: true });
});

function withClaim(state: SessionState): SessionState {
  return {
    ...state,
    proofContract: {
      version: 'contract.v2',
      claims: [
        {
          claimId: CLAIM_ID,
          statement: 'the command registry is consistent',
          signalClass: 'fact',
          critical: false,
          provenance: { kind: 'canonical_authority', authorityId: 'ticket', digest: 'authority' },
          evidenceRefs: [{ kind: 'structural_surface', surfaceId: 'command-registration' }],
          counterexampleRefs: [],
        },
      ],
    },
  };
}

function episode(hostCallId: string, toolName: string): SessionState['mutationEpisodes'][number] {
  return {
    episodeId: crypto.randomUUID(),
    hostCallId,
    toolName,
    runtimeInstanceId: crypto.randomUUID(),
    leaseGeneration: 1,
    authorizedAt: '2026-01-01T00:00:00.000Z',
    status: 'dispatch_authorized',
    completedAt: null,
    outcome: null,
    implementationDigest: null,
    evidenceStatus: 'ineligible',
  };
}

function blockedObligation(code: string): NonNullable<SessionState['reviewAssurance']> {
  return {
    assuranceSchemaVersion: 'review-assurance.v6',
    obligations: [
      {
        obligationId: OBLIGATION_ID,
        obligationType: 'plan',
        reviewCycle: 1,
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
        maxReviewerAttempts: 1,
        reviewProfile: 'core',
        profileSource: 'policy_default',
        createdAt: NOW,
        pluginHandshakeAt: NOW,
        status: 'blocked',
        invocationId: null,
        blockedCode: code,
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
  };
}

async function seedClaimState(
  phase: 'IMPLEMENTATION' | 'IMPL_VALIDATION',
  overrides: {
    readonly mutationEpisodes?: SessionState['mutationEpisodes'];
    readonly reviewAssurance?: SessionState['reviewAssurance'];
  } = {},
): Promise<SessionState> {
  const state: SessionState = {
    ...withClaim(makeProgressedState(phase)),
    ...(overrides.mutationEpisodes === undefined
      ? {}
      : { mutationEpisodes: overrides.mutationEpisodes }),
    ...(overrides.reviewAssurance === undefined
      ? {}
      : { reviewAssurance: overrides.reviewAssurance }),
  };
  const seeded = await writeStateWithArtifacts(sessDir, state);
  expect(seeded.proofGraph?.claims[0]?.verificationState).toBe('PROVEN');
  return seeded;
}

describe('direct metadata write channel', () => {
  it('preserves projection and base for a direct mutation-episode completion', async () => {
    const hostCallId = 'call-1';
    const seeded = await seedClaimState('IMPLEMENTATION', {
      mutationEpisodes: [episode(hostCallId, 'bash')],
    });
    const runtime = { ws: { getSessionDir: () => sessDir } } as never;

    await recordMutationCompletion({
      runtime,
      sessionId: seeded.flowguardSessionId,
      hookInput: { tool: 'bash', callID: hostCallId } as never,
      hookOutput: { metadata: { exit: 0 }, output: '' } as never,
      now: NOW,
    });

    const persisted = await readState(sessDir);
    expect(persisted).not.toBeNull();
    expect(persisted!.proofGraph).toEqual(seeded.proofGraph);
    expect(persisted!.implementationBaseAuthority).toEqual(seeded.implementationBaseAuthority);
    expect(persisted!.mutationEpisodes[0]?.status).toBe('completed');

    const added = persisted!.pendingAuditOperations.slice(seeded.pendingAuditOperations.length);
    expect(added).toHaveLength(1);
    const operation = added[0]!;
    expect(operation.preStateDigest).toBe(computeStateDigest(seeded));
    expect(operation.postStateDigest).toBe(computeStateDigest(persisted!));
    if (operation.kind !== 'state_write') throw new Error('expected state_write operation');
    const body = buildStateWriteBody({
      flowguardSessionId: persisted!.flowguardSessionId,
      hostSessionId: persisted!.binding.hostSessionId,
      phase: operation.stateWrite.phase,
      detail: {
        operationId: operation.operationId,
        preStateDigest: operation.preStateDigest,
        mutationDigest: operation.mutationDigest,
        postStateDigest: operation.postStateDigest,
      },
      occurredAt: operation.stateWrite.at,
      prevHash: 'genesis',
    });
    expect(computeCanonicalEventDigest(body)).toBe(operation.auditEventDigest);
  });

  it('binds every operation of a review-assurance metadata write to that write', async () => {
    const seeded = await seedClaimState('IMPLEMENTATION', {
      reviewAssurance: blockedObligation('REVIEWER_INVOCATION_EXHAUSTED'),
    });
    const workspace = new PluginWorkspaceImpl({ auditWorktree: undefined });

    await workspace.updateReviewAssurance(
      sessDir,
      (state) => blockObligation(state, OBLIGATION_ID, 'REVIEW_TRANSPORT_FAILED'),
      (state) => [
        {
          phase: state.phase,
          event: 'review:obligation_blocked',
          occurredAt: NOW,
          detail: { obligationId: OBLIGATION_ID, code: 'REVIEW_TRANSPORT_FAILED' },
        },
      ],
    );

    const persisted = await readState(sessDir);
    expect(persisted).not.toBeNull();
    expect(persisted!.proofGraph).toEqual(seeded.proofGraph);
    expect(persisted!.implementationBaseAuthority).toEqual(seeded.implementationBaseAuthority);
    expect(persisted!.reviewAssurance?.obligations[0]?.blockedCode).toBe('REVIEW_TRANSPORT_FAILED');

    const added = persisted!.pendingAuditOperations.slice(seeded.pendingAuditOperations.length);
    expect(added.some((operation) => operation.kind === 'state_write')).toBe(true);
    expect(added.some((operation) => operation.kind === 'semantic')).toBe(true);
    for (const operation of added) {
      expect(operation.preStateDigest).toBe(computeStateDigest(seeded));
      expect(operation.postStateDigest).toBe(computeStateDigest(persisted!));
      if (operation.kind === 'state_write') {
        const body = buildStateWriteBody({
          flowguardSessionId: persisted!.flowguardSessionId,
          hostSessionId: persisted!.binding.hostSessionId,
          phase: operation.stateWrite.phase,
          detail: {
            operationId: operation.operationId,
            preStateDigest: operation.preStateDigest,
            mutationDigest: operation.mutationDigest,
            postStateDigest: operation.postStateDigest,
          },
          occurredAt: operation.stateWrite.at,
          prevHash: 'genesis',
        });
        expect(computeCanonicalEventDigest(body)).toBe(operation.auditEventDigest);
        continue;
      }
      if (operation.kind !== 'semantic') throw new Error('unexpected operation kind');
      const body = buildSemanticAuditBody({
        flowguardSessionId: persisted!.flowguardSessionId,
        hostSessionId: persisted!.binding.hostSessionId,
        phase: operation.semantic.phase,
        detail: operation.semantic.detail,
        event: operation.semantic.event,
        occurredAt: operation.semantic.occurredAt,
        prevHash: 'genesis',
        operationId: operation.operationId,
        preStateDigest: operation.preStateDigest,
        mutationDigest: operation.mutationDigest,
        postStateDigest: operation.postStateDigest,
      });
      expect(computeCanonicalEventDigest(body)).toBe(operation.auditEventDigest);
    }
  });

  it('fails closed when a direct write enters IMPLEMENTATION without a frozen base', async () => {
    const previous = makeProgressedState('VALIDATION');
    await writeState(sessDir, previous);
    const next: SessionState = {
      ...previous,
      phase: 'IMPLEMENTATION',
      implementationBaseAuthority: undefined,
    };

    await expect(writeStateWithAuditOperations(sessDir, next)).rejects.toThrow(
      /without a frozen implementation base authority/,
    );

    const persisted = await readState(sessDir);
    expect(persisted?.phase).toBe('VALIDATION');
  });

  it('rejects a derivation-input change through the direct channel before persistence', async () => {
    const seeded = await seedClaimState('IMPL_VALIDATION');
    const before = await readState(sessDir);

    await expect(
      writeStateWithAuditOperations(sessDir, { ...seeded, implementation: null }),
    ).rejects.toMatchObject({ code: 'DIRECT_WRITE_REQUIRES_PREPARE' });

    const persisted = await readState(sessDir);
    expect(persisted).toEqual(before);
    expect(persisted?.proofGraph).toEqual(seeded.proofGraph);
    expect(persisted?.implementation).toEqual(seeded.implementation);
  });

  it.each([
    ['obligationId', { obligationId: '44444444-4444-4444-8444-444444444444' }],
    ['subjectDigest', { subjectDigest: 'changed-subject-digest' }],
    ['reviewCycle', { reviewCycle: 2 }],
  ] as const)(
    'rejects a review-obligation identity change (%s) through the direct channel',
    async (_field, patch) => {
      const seeded = await seedClaimState('IMPLEMENTATION', {
        reviewAssurance: blockedObligation('REVIEWER_INVOCATION_EXHAUSTED'),
      });
      const assurance = seeded.reviewAssurance;
      expect(assurance).not.toBeUndefined();
      const next: SessionState = {
        ...seeded,
        reviewAssurance: {
          ...assurance!,
          obligations: assurance!.obligations.map((obligation) => ({ ...obligation, ...patch })),
        },
      };

      await expect(writeStateWithAuditOperations(sessDir, next)).rejects.toMatchObject({
        code: 'DIRECT_WRITE_REQUIRES_PREPARE',
      });

      const persisted = await readState(sessDir);
      expect(persisted?.reviewAssurance).toEqual(seeded.reviewAssurance);
    },
  );

  it('rejects a new review obligation through the direct channel', async () => {
    const seeded = await seedClaimState('IMPLEMENTATION', {
      reviewAssurance: blockedObligation('REVIEWER_INVOCATION_EXHAUSTED'),
    });
    const assurance = seeded.reviewAssurance;
    expect(assurance).not.toBeUndefined();
    const [firstObligation] = assurance!.obligations;
    expect(firstObligation).not.toBeUndefined();
    const next: SessionState = {
      ...seeded,
      reviewAssurance: {
        ...assurance!,
        obligations: [
          ...assurance!.obligations,
          { ...firstObligation!, obligationId: '55555555-5555-4555-8555-555555555555' },
        ],
      },
    };

    await expect(writeStateWithAuditOperations(sessDir, next)).rejects.toMatchObject({
      code: 'DIRECT_WRITE_REQUIRES_PREPARE',
    });
  });
});

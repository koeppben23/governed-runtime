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
import { readState, writeStateAlreadyLocked } from '../adapters/persistence.js';
import { makeProgressedState, makeState } from '../fixtures.js';
import { buildStateWriteBody } from '../audit/types.js';
import { buildSemanticAuditBody } from '../audit/semantic-event.js';
import { computeCanonicalEventDigest } from '../audit/canonical-digest.js';
import { computeStateDigest, writeStateWithAuditOperations } from './audit-outbox.js';
import { recordMutationCompletion } from './plugin-mutation-episodes.js';
import { finalizeStrictTimestampFailure } from './plugin-audit-reconcile.js';
import { persistRiskDecisionBlock } from './plugin-risk.js';
import { enforceDiscoveryHealthAfterBash } from './plugin-discovery-health.js';
import { PluginWorkspaceImpl } from './plugin-workspace.js';
import { freezeReviewMaterial } from './review/obligations/assurance.js';
import { blockObligation } from './review/obligations/obligation-state.js';
import { writeStateWithArtifacts } from './tools/helpers.js';
import type { SessionState } from '../state/schema.js';
import type { DeniedRiskClassificationDecision } from './phase-tool-gate.js';
import type { AuditContext } from './plugin-audit-context.js';

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
    readonly policySnapshot?: SessionState['policySnapshot'];
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
    ...(overrides.policySnapshot === undefined ? {} : { policySnapshot: overrides.policySnapshot }),
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

  it('fails closed at the persistence boundary for a raw IMPLEMENTATION write without a base', async () => {
    await expect(writeStateAlreadyLocked(sessDir, makeState('IMPLEMENTATION'))).rejects.toThrow(
      /without a frozen implementation base authority/,
    );

    expect(await readState(sessDir)).toBeNull();
  });

  it('rejects a direct metadata write without existing state before any persistence or audit operation', async () => {
    await expect(writeStateWithAuditOperations(sessDir, makeState('TICKET'))).rejects.toMatchObject(
      {
        code: 'DIRECT_WRITE_REQUIRES_PREPARE',
      },
    );

    // Nothing was persisted: no state file, no outbox operation, and no lock
    // residue. The rejection must precede both prepareAuditOperations and
    // writeStateAlreadyLocked.
    expect(await readState(sessDir)).toBeNull();
    expect(await fs.readdir(sessDir)).toEqual([]);
  });

  it.each([
    ['phase', (state: SessionState): SessionState => ({ ...state, phase: 'IMPL_VALIDATION' })],
    [
      'binding',
      (state: SessionState): SessionState => ({
        ...state,
        binding: { ...state.binding, worktree: '/tmp/other-worktree' },
      }),
    ],
    [
      'transition',
      (state: SessionState): SessionState => ({
        ...state,
        transition: { from: 'TICKET', to: 'PLAN', event: 'PLAN_READY', at: NOW },
      }),
    ],
    [
      'policySnapshot',
      (state: SessionState): SessionState => ({
        ...state,
        policySnapshot: {
          ...state.policySnapshot,
          enforceRiskClassification: state.policySnapshot.enforceRiskClassification !== true,
        },
      }),
    ],
    [
      'implementationBaseAuthority',
      (state: SessionState): SessionState => ({
        ...state,
        implementationBaseAuthority: undefined,
      }),
    ],
    [
      'proofGraph',
      (state: SessionState): SessionState => ({
        ...state,
        proofGraph: { ...state.proofGraph!, evaluatedAt: '2026-02-01T00:00:00.000Z' },
      }),
    ],
    [
      'activeChecks',
      (state: SessionState): SessionState => ({
        ...state,
        activeChecks: [...state.activeChecks, 'extra-check'],
      }),
    ],
    [
      'session identity',
      (state: SessionState): SessionState => {
        const id = '99999999-9999-4999-8999-999999999999';
        return { ...state, id, flowguardSessionId: id };
      },
    ],
    [
      'reducedCeremony',
      (state: SessionState): SessionState => ({
        ...state,
        reducedCeremony: {
          profile: 'reduced',
          reason: 'direct-write test',
          claimedTaskClass: 'TRIVIAL',
          computedMinimumTaskClass: 'TRIVIAL',
          touchedSurfaces: [],
          decidedAt: NOW,
        },
      }),
    ],
    [
      'implementationRiskAssessment',
      (state: SessionState): SessionState => ({
        ...state,
        implementationRiskAssessment: {
          computedMinimumTaskClass: 'TRIVIAL',
          touchedSurfaces: [],
          assessedFrom: 'implementation_changed_files',
          assessedFileCount: 0,
          implementationDigest: 'direct-write-test-digest',
        },
      }),
    ],
  ] as const)(
    'rejects a protected authority change (%s) through the direct channel',
    async (_field, mutate) => {
      const seeded = await seedClaimState('IMPLEMENTATION');
      const before = await readState(sessDir);

      await expect(writeStateWithAuditOperations(sessDir, mutate(seeded))).rejects.toMatchObject({
        code: 'DIRECT_WRITE_REQUIRES_PREPARE',
      });

      expect(await readState(sessDir)).toEqual(before);
    },
  );

  it('reports changed authority fields in sorted order', async () => {
    const seeded = await seedClaimState('IMPLEMENTATION');
    const id = '99999999-9999-4999-8999-999999999999';

    await expect(
      writeStateWithAuditOperations(sessDir, { ...seeded, id, flowguardSessionId: id }),
    ).rejects.toThrow('flowguardSessionId, id');

    expect(await readState(sessDir)).toEqual(seeded);
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
    [
      'reviewMaterial',
      { reviewMaterial: freezeReviewMaterial('tampered material', 'tampered-digest') },
    ],
    ['reviewProfile', { reviewProfile: 'full' }],
    ['requiredChallengeCount', { requiredChallengeCount: 1 }],
    ['maxReviewerAttempts', { maxReviewerAttempts: 5 }],
  ] as const)(
    'rejects a frozen review-obligation attribute change (%s) through the direct channel',
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

  it('rejects a review-obligation reorder through the direct channel', async () => {
    const assurance = blockedObligation('REVIEWER_INVOCATION_EXHAUSTED');
    const [first] = assurance.obligations;
    expect(first).not.toBeUndefined();
    const second = { ...first!, obligationId: '66666666-6666-4666-8666-666666666666' };
    const seeded = await seedClaimState('IMPLEMENTATION', {
      reviewAssurance: { ...assurance, obligations: [first!, second] },
    });
    const current = seeded.reviewAssurance;
    expect(current?.obligations).toHaveLength(2);

    const next: SessionState = {
      ...seeded,
      reviewAssurance: {
        ...current!,
        obligations: [current!.obligations[1]!, current!.obligations[0]!],
      },
    };

    await expect(writeStateWithAuditOperations(sessDir, next)).rejects.toMatchObject({
      code: 'DIRECT_WRITE_REQUIRES_PREPARE',
    });

    const persisted = await readState(sessDir);
    expect(persisted?.reviewAssurance).toEqual(seeded.reviewAssurance);
  });

  it('keeps authority committed after the decision read when a risk block persists', async () => {
    const seeded = await seedClaimState('IMPLEMENTATION');
    const intervening = await writeStateWithAuditOperations(sessDir, seeded, [
      {
        phase: seeded.phase,
        event: 'review:obligation_blocked',
        occurredAt: NOW,
        detail: { obligationId: OBLIGATION_ID, code: 'INTERVENING_AUTHORITY' },
      },
    ]);
    const interveningOperationId = intervening.pendingAuditOperations.at(-1)!.operationId;

    const decision: DeniedRiskClassificationDecision = {
      allowed: false,
      code: 'RISK_CLASSIFICATION_MISMATCH',
      reason: 'blocked',
      decisionId: 'd-1',
      claimedTaskClass: 'STANDARD',
      minimumTaskClass: 'HIGH-RISK',
      touchedSurfaces: ['src/foo.ts'],
      riskTriggers: ['ceremony_only'],
      changedFiles: ['src/foo.ts'],
    };
    await persistRiskDecisionBlock(sessDir, decision, 'RISK_CLASSIFICATION_MISMATCH', 'blocked');

    const persisted = await readState(sessDir);
    expect(persisted?.riskGate).toMatchObject({
      status: 'blocked',
      code: 'RISK_CLASSIFICATION_MISMATCH',
    });
    expect(persisted?.pendingAuditOperations.map((operation) => operation.operationId)).toContain(
      interveningOperationId,
    );
    expect(persisted?.proofGraph).toEqual(seeded.proofGraph);
    expect(persisted?.implementationBaseAuthority).toEqual(seeded.implementationBaseAuthority);
  });

  it('keeps authority committed after the decision read when a discovery block persists', async () => {
    const base = makeProgressedState('IMPLEMENTATION');
    const seeded = await seedClaimState('IMPLEMENTATION', {
      policySnapshot: {
        ...base.policySnapshot,
        discoveryHealth: { enforcement: 'required', onDegraded: 'block', onDrift: 'block' },
      },
    });
    const intervening = await writeStateWithAuditOperations(sessDir, seeded, [
      {
        phase: seeded.phase,
        event: 'review:obligation_blocked',
        occurredAt: NOW,
        detail: { obligationId: OBLIGATION_ID, code: 'INTERVENING_AUTHORITY' },
      },
    ]);
    const interveningOperationId = intervening.pendingAuditOperations.at(-1)!.operationId;
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-direct-writer-ws-'));
    const output: { output?: unknown } = {};

    try {
      await enforceDiscoveryHealthAfterBash(
        { getSessionDir: () => sessDir, getWorkspaceDir: () => workspaceDir },
        seeded.flowguardSessionId,
        output,
      );
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }

    expect(output.output).toBeDefined();
    const persisted = await readState(sessDir);
    expect(persisted?.discoveryHealthGate).toMatchObject({
      status: 'blocked',
      code: 'DISCOVERY_HEALTH_UNAVAILABLE',
    });
    expect(persisted?.pendingAuditOperations.map((operation) => operation.operationId)).toContain(
      interveningOperationId,
    );
    expect(persisted?.proofGraph).toEqual(seeded.proofGraph);
    expect(persisted?.implementationBaseAuthority).toEqual(seeded.implementationBaseAuthority);
  });

  it('keeps authority committed after the decision read when a TSA failure persists', async () => {
    const seeded = await seedClaimState('IMPLEMENTATION');
    const intervening = await writeStateWithAuditOperations(sessDir, seeded, [
      {
        phase: seeded.phase,
        event: 'review:obligation_blocked',
        occurredAt: NOW,
        detail: { obligationId: OBLIGATION_ID, code: 'INTERVENING_AUTHORITY' },
      },
    ]);
    const interveningOperationId = intervening.pendingAuditOperations.at(-1)!.operationId;

    const outcome = await finalizeStrictTimestampFailure(
      { sessDir, now: NOW } as AuditContext,
      () => ({ eventKind: 'tool:write', reason: 'timestamp authority unavailable' }),
    );

    expect(outcome).toMatchObject({
      auditOk: false,
      block: true,
      code: 'TSA_TIMESTAMP_ASSURANCE_FAILED',
    });
    const persisted = await readState(sessDir);
    expect(persisted?.error).toMatchObject({ code: 'TSA_TIMESTAMP_ASSURANCE_FAILED' });
    expect(persisted?.pendingAuditOperations.map((operation) => operation.operationId)).toContain(
      interveningOperationId,
    );
    expect(persisted?.proofGraph).toEqual(seeded.proofGraph);
    expect(persisted?.implementationBaseAuthority).toEqual(seeded.implementationBaseAuthority);
  });
});

import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'node:crypto';

import { executeReviewDecision } from '../rails/review-decision.js';
import { makeProgressedState } from '../__fixtures__.js';
import { resolvePolicy } from '../config/policy.js';
import {
  normalizePolicySnapshotWithMeta,
  resolvePolicyFromSnapshot,
} from '../config/policy-snapshot.js';
import { readState, readConfig, writeRepoConfig } from '../adapters/persistence.js';
import { computeFingerprint, sessionDir, workspaceDir } from '../adapters/workspace/index.js';
import {
  createToolContext,
  createTestWorkspace,
  parseToolResult,
  type TestToolContext,
  type TestWorkspace,
} from './test-helpers.js';
import { hydrate } from './tools/index.js';

vi.mock('../adapters/git', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/git.js')>();
  return {
    ...original,
    remoteOriginUrl: vi.fn().mockResolvedValue('https://github.com/test/repo.git'),
    changedFiles: vi.fn().mockResolvedValue(['src/foo.ts', 'src/bar.ts']),
    listRepoSignals: vi.fn().mockResolvedValue({
      files: ['tsconfig.json', 'package.json', 'src/index.ts'],
      packageFiles: ['package.json'],
      configFiles: ['tsconfig.json'],
    }),
  };
});

let ws: TestWorkspace;
let ctx: TestToolContext;

describe('policy snapshot regression', () => {
  beforeEach(async () => {
    ws = await createTestWorkspace();
    ctx = createToolContext({
      worktree: ws.tmpDir,
      directory: ws.tmpDir,
      sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await ws.cleanup();
  });

  it('snapshot beats preset for approval assurance threshold', () => {
    const state = makeProgressedState('PLAN_REVIEW');

    const reviewerDecision = {
      verdict: 'approve' as const,
      rationale: 'approve',
      decidedBy: 'reviewer-claim',
      decisionIdentity: {
        actorId: 'reviewer-claim',
        actorEmail: 'reviewer@example.com',
        actorSource: 'claim' as const,
        actorAssurance: 'claim_validated' as const,
      },
    };

    const presetPolicy = resolvePolicy('regulated');
    const presetResult = executeReviewDecision(state, reviewerDecision, {
      now: () => '2026-04-29T00:00:00.000Z',
      digest: (text) => text,
      policy: presetPolicy,
    });
    expect(presetResult.kind).toBe('ok');

    const snapshotPolicy = resolvePolicyFromSnapshot({
      ...state.policySnapshot,
      mode: 'regulated',
      requestedMode: 'regulated',
      minimumActorAssuranceForApproval: 'idp_verified',
    });

    const snapshotResult = executeReviewDecision(state, reviewerDecision, {
      now: () => '2026-04-29T00:00:00.000Z',
      digest: (text) => text,
      policy: snapshotPolicy,
    });
    expect(snapshotResult.kind).toBe('blocked');
    if (snapshotResult.kind === 'blocked') {
      expect(snapshotResult.code).toBe('ACTOR_ASSURANCE_INSUFFICIENT');
    }
  });

  it('identityProviderMode from snapshot is preserved for upstream actor enforcement', () => {
    const state = makeProgressedState('PLAN_REVIEW');

    const snapshotPolicy = resolvePolicyFromSnapshot({
      ...state.policySnapshot,
      mode: 'regulated',
      requestedMode: 'regulated',
      identityProviderMode: 'required',
      identityProvider: undefined,
      minimumActorAssuranceForApproval: 'best_effort',
    });

    const result = executeReviewDecision(
      state,
      {
        verdict: 'approve',
        rationale: 'approve',
        decidedBy: 'reviewer',
        decisionIdentity: {
          actorId: 'reviewer',
          actorEmail: 'reviewer@example.com',
          actorSource: 'claim',
          actorAssurance: 'claim_validated',
        },
      },
      {
        now: () => '2026-04-29T00:00:00.000Z',
        digest: (text) => text,
        policy: snapshotPolicy,
      },
    );

    // Review-decision itself gates assurance/four-eyes.
    // IdP-required enforcement is guaranteed upstream by policy-bound actor resolution.
    expect(result.kind).toBe('ok');
    expect(snapshotPolicy.identityProviderMode).toBe('required');
  });

  it('legacy snapshot normalization is explicit and safe', () => {
    const legacy = {
      mode: 'regulated',
      hash: 'legacy-hash',
      resolvedAt: '2026-01-01T00:00:00.000Z',
      requestedMode: 'regulated',
      effectiveGateBehavior: 'human_gated',
      requireHumanGates: true,
      maxSelfReviewIterations: 3,
      maxImplReviewIterations: 3,
      allowSelfApproval: false,
      audit: { emitTransitions: true, emitToolCalls: true, enableChainHash: true },
      actorClassification: { flowguard_decision: 'human' },
    };

    const normalized = normalizePolicySnapshotWithMeta(legacy);
    expect(normalized.normalized).toBe(true);
    expect(normalized.reason).toBe('incomplete_snapshot_normalized');
    expect(normalized.snapshot.minimumActorAssuranceForApproval).toBe('best_effort');
    expect(normalized.snapshot.identityProviderMode).toBe('optional');
  });

  it('hydrate persists full effective policy fields in snapshot', async () => {
    parseToolResult(await hydrate.execute({ policyMode: 'solo', profileId: 'baseline' }, ctx));

    const fp = await computeFingerprint(ws.tmpDir);
    const wsDir = workspaceDir(fp.fingerprint);
    const config = await readConfig();
    config.policy.minimumActorAssuranceForApproval = 'claim_validated';
    config.policy.identityProviderMode = 'required';
    config.policy.identityProvider = {
      mode: 'static',
      issuer: 'https://idp.example.com',
      audience: ['flowguard'],
      claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
      signingKeys: [
        {
          kind: 'jwk',
          kid: 'k1',
          alg: 'RS256',
          jwk: { kty: 'RSA', n: 'dGVzdA', e: 'AQAB' },
        },
      ],
    } as unknown as typeof config.policy.identityProvider;
    await writeRepoConfig(ws.tmpDir, config);

    const ctx2 = createToolContext({
      worktree: ws.tmpDir,
      directory: ws.tmpDir,
      sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
    });
    parseToolResult(await hydrate.execute({ policyMode: 'team', profileId: 'baseline' }, ctx2));

    const sessDir = sessionDir(fp.fingerprint, ctx2.sessionID);
    const state = await readState(sessDir);
    expect(state).not.toBeNull();
    expect(state!.policySnapshot.minimumActorAssuranceForApproval).toBe('claim_validated');
    expect(state!.policySnapshot.identityProviderMode).toBe('required');
    expect(state!.policySnapshot.identityProvider).toBeDefined();
    expect(state!.policySnapshot.actorClassification).toBeDefined();
    expect(state!.policySnapshot.audit).toBeDefined();
  });
});

/**
 * @module integration/tools/declare-contract-claim-identity
 * @description Claim identity contract for `/declare-contract` (PR #902 review).
 *
 * Manual claim ids are minted by the canonical identity authority in
 * `state/proofgraph-approval.ts`. These tests pin the resulting contract:
 *
 *   1. A manual declaration whose canonical identity already exists is
 *      rejected and never mutates state.
 *   2. The same statement declared by the plan or architecture domain is a
 *      DISTINCT claim by contract — it must NOT block a manual declaration.
 *      (Guards against re-introducing global statement identity.)
 *   3. Whitespace/casing variants of the same statement collapse into one
 *      canonical manual identity within a batch.
 *   4. The same normalization also detects a collision against an already
 *      persisted manual claim.
 *
 * @version v1
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
import {
  createTestWorkspace,
  createToolContext,
  parseToolResult,
  withTestEnv,
  type TestToolContext,
  type TestWorkspace,
} from '../test-helpers.js';
import { declare_contract, hydrate } from './index.js';
import { readState } from '../../adapters/persistence.js';
import { writeStateWithArtifacts } from './helpers.js';
import { MANUAL_CLAIM_SCOPE, mintProofGraphClaimId } from '../../state/proofgraph-approval.js';
import { TEST_EXECUTION_OBSERVATION } from '../../state/evidence-test-constants.js';

const NOW = '2026-01-01T00:00:00.000Z';
const SHA = 'a'.repeat(64);
const CHECK = 'test';

let ws: TestWorkspace;
let ctx: TestToolContext;
let cleanupEnv: () => void;

beforeEach(async () => {
  cleanupEnv = withTestEnv({ FLOWGUARD_POLICY_PATH: undefined });
  ws = await createTestWorkspace();
  ctx = createToolContext({
    worktree: ws.tmpDir,
    directory: ws.tmpDir,
    sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
  });
});

afterEach(async () => {
  cleanupEnv();
  await ws.cleanup();
});

function manualId(statement: string): string {
  return mintProofGraphClaimId({
    flow: 'manual',
    authoritySectionId: MANUAL_CLAIM_SCOPE,
    statement,
  });
}

/** Seed an IMPL_VALIDATION session with the one attempt the check needs. */
async function seedImplValidation(digest = 'impl-digest-1'): Promise<string> {
  await hydrate.execute({ policyMode: 'solo' }, ctx);
  const { computeFingerprint, sessionDir: resolveSessionDir } =
    await import('../../adapters/workspace/index.js');
  const fp = await computeFingerprint(ws.tmpDir);
  const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
  const state = await readState(sessDir);
  await writeStateWithArtifacts(sessDir, {
    ...state!,
    phase: 'IMPL_VALIDATION',
    activeChecks: [CHECK],
    ticket: {
      text: 'approved ticket',
      digest: 'ticket-digest',
      source: 'user',
      createdAt: NOW,
    },
    implementation: { changedFiles: ['a.ts'], domainFiles: [], digest, executedAt: NOW },
    validationAttempts: [
      {
        attemptId: crypto.randomUUID(),
        scope: 'implementation',
        implementationDigest: digest,
        executionObservation: TEST_EXECUTION_OBSERVATION,
        result: {
          checkId: CHECK,
          passed: true,
          detail: '',
          executedAt: NOW,
          kind: 'test',
          command: 'npm test',
          exitCode: 0,
          executionMs: 5,
          outputDigest: SHA,
          timedOut: false,
          outcome: 'supported' as const,
        },
      },
    ],
    verificationCandidates: [],
  });
  return sessDir;
}

type SeedClaim = {
  readonly claimId: string;
  readonly statement: string;
};

async function seedProofContract(sessDir: string, claims: readonly SeedClaim[]): Promise<void> {
  const state = await readState(sessDir);
  await writeStateWithArtifacts(sessDir, {
    ...state!,
    proofContract: {
      version: 'contract.v2',
      claims: claims.map((claim) => ({
        claimId: claim.claimId,
        statement: claim.statement,
        signalClass: 'hypothesis' as const,
        critical: false,
        provenance: null,
        evidenceRefs: [],
        counterexampleRefs: [],
      })),
    },
  });
}

function claimInput(statement: string) {
  return {
    statement,
    checkId: CHECK,
    critical: false,
    claimScope: 'specific_behavior' as const,
  };
}

describe('declare_contract claim identity', () => {
  it('blocks a declaration whose canonical manual identity already exists', async () => {
    const sessDir = await seedImplValidation();
    const statement = 'An already persisted manual claim.';
    await seedProofContract(sessDir, [{ claimId: manualId(statement), statement }]);
    const before = await readState(sessDir);

    const result = parseToolResult(
      await declare_contract.execute({ claims: [claimInput(statement)] }, ctx),
    );

    expect(result.code).toBe('PROOFGRAPH_CLAIM_CONTRACT_INCOMPLETE');
    expect(String(result.message)).toContain('statement');
    expect(String(result.message)).toContain(manualId(statement));
    expect(await readState(sessDir)).toEqual(before);
  });

  it.each(['plan', 'architecture'] as const)(
    'does NOT block a manual declaration that shares a statement with a %s-domain claim',
    async (domain) => {
      const sessDir = await seedImplValidation();
      const statement = 'A statement the approved authority also declares.';
      const authorityClaimId = mintProofGraphClaimId({
        flow: domain,
        authoritySectionId: 'step-1',
        statement,
      });
      await seedProofContract(sessDir, [{ claimId: authorityClaimId, statement }]);

      const result = parseToolResult(
        await declare_contract.execute({ claims: [claimInput(statement)] }, ctx),
      );

      expect(result.error).toBeUndefined();
      const persisted = await readState(sessDir);
      expect(persisted!.proofContract?.claims).toHaveLength(2);
      expect(persisted!.proofContract?.claims[0]?.claimId).toBe(authorityClaimId);
      const manualClaim = persisted!.proofContract!.claims[1]!;
      expect(manualClaim.claimId).toBe(manualId(statement));
      expect(manualClaim.claimId).not.toBe(authorityClaimId);
    },
  );

  it('blocks normalized duplicate statements within one batch', async () => {
    const sessDir = await seedImplValidation();
    const before = await readState(sessDir);

    const result = parseToolResult(
      await declare_contract.execute(
        {
          claims: [
            claimInput('User   data MUST be encrypted'),
            claimInput(' user data must   be encrypted '),
          ],
        },
        ctx,
      ),
    );

    expect(result.code).toBe('PROOFGRAPH_CLAIM_CONTRACT_INCOMPLETE');
    expect(String(result.message)).toContain('statement');
    expect(await readState(sessDir)).toEqual(before);
  });

  it('blocks a normalized collision against a persisted manual claim', async () => {
    const sessDir = await seedImplValidation();
    const existingStatement = 'User   data MUST be encrypted';
    await seedProofContract(sessDir, [
      { claimId: manualId(existingStatement), statement: existingStatement },
    ]);
    const before = await readState(sessDir);

    const result = parseToolResult(
      await declare_contract.execute(
        { claims: [claimInput(' user data must   be encrypted ')] },
        ctx,
      ),
    );

    expect(result.code).toBe('PROOFGRAPH_CLAIM_CONTRACT_INCOMPLETE');
    expect(String(result.message)).toContain(manualId(existingStatement));
    expect(await readState(sessDir)).toEqual(before);
  });
});

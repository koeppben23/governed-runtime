/**
 * @module audit/proofgraph/mutation-binder.test
 * @description Binding session-state MutationAttempt records to declared claims (#762).
 *
 * The binder reads from `state.mutationAttempts` (FlowGuard-attested records) and
 * never trusts a freely-editable filesystem envelope.
 */
import { describe, it, expect } from 'vitest';
import { bindMutationEvidence, MUTATION_PROVIDER_VERSION } from './mutation-binder.js';
import type { VerifiedProfileVerdict } from './mutation-binder.js';
import { makeState } from '../../fixtures.js';
import { ProofProviderResult } from '../../state/proofgraph.js';
import type { SessionState } from '../../state/schema.js';

const NOW = '2026-01-01T00:00:00.000Z';
const CLAIM = '00000000-0000-4000-8000-000000000001';
const ATTEMPT_ID = '00000000-0000-4000-8000-0000000000a1';
const PROFILE = 'proofgraph-evaluator';
const RECORDED_DIGEST = 'recorded-impl-digest';
const PROJ_DIGEST = 'a'.repeat(64);
const AUTHORITY_REF = {
  kind: 'canonical_authority' as const,
  authorityId: 'ticket',
  digest: 'authority',
};

function stateWithAttemptRef(
  attemptId: string,
  attemptInState = true,
  implDigest = 'impl-current',
): SessionState {
  return makeState('IMPL_VALIDATION', {
    implementation: {
      changedFiles: ['a.ts'],
      domainFiles: [],
      digest: implDigest,
      executedAt: NOW,
    },
    proofContract: {
      version: 'contract.v1',
      claims: [
        {
          claimId: CLAIM,
          statement: 'the evaluator semantics are pinned by tests',
          signalClass: 'fact',
          critical: true,
          provenance: AUTHORITY_REF,
          evidenceRefs: [{ kind: 'mutation_attempt', attemptId, profileId: PROFILE }],
          counterexampleRefs: [],
        },
      ],
    },
    mutationAttempts: attemptInState
      ? [
          {
            attemptId,
            implementationDigest: RECORDED_DIGEST,
            command: 'npm run mutation',
            startedAt: '2026-01-01T00:00:00.000Z',
            completedAt: '2026-01-01T00:05:00.000Z',
            exitCode: 0,
            artifactDigest: 'b'.repeat(64),
            projectionDigest: PROJ_DIGEST,
            reportPath: 'reports/mutation/mutation.json',
            providerVersion: MUTATION_PROVIDER_VERSION,
          },
        ]
      : [],
  });
}

function verdicts(
  attemptId: string,
  killed = 5,
  survivors = 0,
  covered = true,
  profileId: string = PROFILE,
): ReadonlyMap<string, ReadonlyMap<string, VerifiedProfileVerdict>> {
  return new Map([
    [attemptId, new Map([[profileId, { survivorCount: survivors, killedCount: killed, covered }]])],
  ]);
}

describe('bindMutationEvidence', () => {
  it('binds a survivor-free MutationAttempt as passing fault_injection evidence', () => {
    const [r] = bindMutationEvidence(
      stateWithAttemptRef(ATTEMPT_ID),
      verdicts(ATTEMPT_ID, 5, 0),
      NOW,
    );
    expect(r).toMatchObject({
      claimId: CLAIM,
      providerKind: 'fault_injection',
      status: 'pass',
      binding: { kind: 'implementation', digest: RECORDED_DIGEST },
      input: { command: 'npm run mutation' },
      resultDigest: PROJ_DIGEST,
      executedAt: '2026-01-01T00:05:00.000Z',
    });
  });

  it('binds surviving mutants as FAILING evidence', () => {
    const [r] = bindMutationEvidence(
      stateWithAttemptRef(ATTEMPT_ID),
      verdicts(ATTEMPT_ID, 5, 2),
      NOW,
    );
    expect(r!.status).toBe('fail');
    expect(r!.detail).toContain('2 surviving');
  });

  it('binds to the RECORDED digest, NOT the current state implementation digest', () => {
    const [r] = bindMutationEvidence(
      stateWithAttemptRef(ATTEMPT_ID, true, 'different-current-digest'),
      verdicts(ATTEMPT_ID),
      NOW,
    );
    expect(r).toMatchObject({
      binding: { kind: 'implementation', digest: RECORDED_DIGEST },
    });
  });

  it('preserves the recorded completedAt timestamp', () => {
    const state = stateWithAttemptRef(ATTEMPT_ID);
    // MutationAttempt can't be mutated after creation, but we verify the stored timestamp.
    const [r] = bindMutationEvidence(state, verdicts(ATTEMPT_ID), '9999-01-01T00:00:00.000Z');
    expect(r!.executedAt).toBe('2026-01-01T00:05:00.000Z');
  });

  it('emits unavailable when the referenced MutationAttempt is not in state', () => {
    const [r] = bindMutationEvidence(
      stateWithAttemptRef(ATTEMPT_ID, false),
      verdicts(ATTEMPT_ID),
      NOW,
    );
    expect(r!.status).toBe('unavailable');
    expect(r!.detail).toContain('not found in session state');
  });

  it('emits unavailable when verdicts have no entry for the attempt', () => {
    const [r] = bindMutationEvidence(stateWithAttemptRef(ATTEMPT_ID), new Map(), NOW);
    expect(r!.status).toBe('unavailable');
    expect(r!.detail).toContain('no digest-verified verdict');
  });

  it('emits unavailable for mutation_profile refs (no concrete attempt)', () => {
    const state = makeState('IMPL_VALIDATION', {
      proofContract: {
        version: 'contract.v1',
        claims: [
          {
            claimId: CLAIM,
            statement: 'x',
            signalClass: 'fact',
            critical: true,
            provenance: AUTHORITY_REF,
            evidenceRefs: [{ kind: 'mutation_profile', profileId: 'proofgraph-evaluator' }],
            counterexampleRefs: [],
          },
        ],
      },
    });
    const [r] = bindMutationEvidence(state, new Map(), NOW);
    expect(r!.status).toBe('unavailable');
    expect(r!.detail).toContain('use flowguard_record_mutation_evidence');
  });

  it('emits nothing for claims that do not reference mutation evidence', () => {
    const state = makeState('IMPL_VALIDATION', {
      proofContract: {
        version: 'contract.v1',
        claims: [
          {
            claimId: CLAIM,
            statement: 'x',
            signalClass: 'fact',
            critical: true,
            provenance: AUTHORITY_REF,
            evidenceRefs: [{ kind: 'content', digest: 'd' }],
            counterexampleRefs: [],
          },
        ],
      },
      mutationAttempts: [
        {
          attemptId: ATTEMPT_ID,
          implementationDigest: RECORDED_DIGEST,
          command: 'npm run mutation',
          startedAt: NOW,
          completedAt: NOW,
          exitCode: 0,
          artifactDigest: 'b'.repeat(64),
          projectionDigest: PROJ_DIGEST,
          reportPath: 'reports/mutation/mutation.json',
          providerVersion: MUTATION_PROVIDER_VERSION,
        },
      ],
    });
    expect(bindMutationEvidence(state, verdicts(ATTEMPT_ID), NOW)).toEqual([]);
  });

  describe('exit code semantics', () => {
    function stateWithExitCode(exitCode: number): SessionState {
      return makeState('IMPL_VALIDATION', {
        implementation: {
          changedFiles: ['a.ts'],
          domainFiles: [],
          digest: 'impl-current',
          executedAt: NOW,
        },
        proofContract: {
          version: 'contract.v1',
          claims: [
            {
              claimId: CLAIM,
              statement: 'x',
              signalClass: 'fact',
              critical: true,
              provenance: AUTHORITY_REF,
              evidenceRefs: [
                { kind: 'mutation_attempt', attemptId: ATTEMPT_ID, profileId: PROFILE },
              ],
              counterexampleRefs: [],
            },
          ],
        },
        mutationAttempts: [
          {
            attemptId: ATTEMPT_ID,
            implementationDigest: RECORDED_DIGEST,
            command: 'npm run mutation',
            startedAt: NOW,
            completedAt: NOW,
            exitCode,
            artifactDigest: 'b'.repeat(64),
            projectionDigest: PROJ_DIGEST,
            reportPath: 'reports/mutation/mutation.json',
            providerVersion: MUTATION_PROVIDER_VERSION,
          },
        ],
      });
    }

    it('non-zero mutation exit code yields error, never pass', () => {
      const [r] = bindMutationEvidence(
        stateWithExitCode(1),
        verdicts(ATTEMPT_ID, 5, 0, true, PROFILE),
        NOW,
      );
      expect(r!.status).toBe('error');
      expect(r!.detail).toContain('exited with code 1');
    });

    it('non-zero exit code yields error even when the report had no survivors', () => {
      // 0 survivors + non-zero exit = error, not pass
      const [r] = bindMutationEvidence(
        stateWithExitCode(127),
        verdicts(ATTEMPT_ID, 10, 0, true, PROFILE),
        NOW,
      );
      expect(r!.status).toBe('error');
      expect(r!.detail).toContain('exited with code 127');
    });

    it('zero exit code with survivors yields fail', () => {
      const [r] = bindMutationEvidence(
        stateWithExitCode(0),
        verdicts(ATTEMPT_ID, 5, 3, true, PROFILE),
        NOW,
      );
      expect(r!.status).toBe('fail');
    });

    it('zero exit code without survivors yields pass', () => {
      const [r] = bindMutationEvidence(
        stateWithExitCode(0),
        verdicts(ATTEMPT_ID, 5, 0, true, PROFILE),
        NOW,
      );
      expect(r!.status).toBe('pass');
    });

    it('error results satisfy the strict provider schema', () => {
      const [r] = bindMutationEvidence(
        stateWithExitCode(1),
        verdicts(ATTEMPT_ID, 5, 0, true, PROFILE),
        NOW,
      );
      expect(() => ProofProviderResult.parse(r)).not.toThrow();
    });
  });

  describe('schema compliance', () => {
    it('emits results that satisfy the strict provider schema', () => {
      for (const r of bindMutationEvidence(
        stateWithAttemptRef(ATTEMPT_ID),
        verdicts(ATTEMPT_ID),
        NOW,
      )) {
        expect(() => ProofProviderResult.parse(r)).not.toThrow();
      }
    });
  });
});

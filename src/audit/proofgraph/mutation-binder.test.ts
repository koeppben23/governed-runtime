/**
 * @module audit/proofgraph/mutation-binder.test
 * @description Binding recorded mutation verdicts to declared claims (#762).
 */
import { describe, it, expect } from 'vitest';
import { bindMutationEvidence, MUTATION_PROVIDER_VERSION } from './mutation-binder.js';
import type { MutationEvaluation } from './mutation-binder.js';
import { summarizeMutationProfile, MutationReport } from './mutation-report.js';
import type { MutationProfile } from './mutation-report.js';
import { ProofProviderResult } from '../../state/proofgraph.js';
import { makeState } from '../../fixtures.js';
import type { SessionState } from '../../state/schema.js';

const NOW = '2026-01-01T00:00:00.000Z';
const CLAIM = '00000000-0000-4000-8000-000000000001';
const IMPL_DIGEST = 'impl-current';
const EVALUATOR = 'src/audit/proofgraph/evaluate.ts';
const AUTHORITY_REF = {
  kind: 'canonical_authority' as const,
  authorityId: 'ticket',
  digest: 'authority',
};
const PROFILE: MutationProfile = {
  profileId: 'proofgraph-evaluator',
  locations: [EVALUATOR],
  command: 'npm run mutation',
};

function stateWithProfile(profileId = PROFILE.profileId, withImpl = true): SessionState {
  return makeState('IMPL_VALIDATION', {
    ...(withImpl
      ? {
          implementation: {
            changedFiles: ['a.ts'],
            domainFiles: [],
            digest: IMPL_DIGEST,
            executedAt: NOW,
          },
        }
      : {}),
    proofContract: {
      version: 'contract.v1',
      claims: [
        {
          claimId: CLAIM,
          statement: 'the evaluator semantics are pinned by tests',
          signalClass: 'fact' as const,
          critical: true,
          provenance: AUTHORITY_REF,
          evidenceRefs: [{ kind: 'mutation_profile' as const, profileId }],
          counterexampleRefs: [],
        },
      ],
    },
  });
}

function evaluation(statuses: string[]): MutationEvaluation {
  const report = MutationReport.parse({
    schemaVersion: '1.0',
    files: {
      [EVALUATOR]: {
        mutants: statuses.map((status, i) => ({
          id: String(i),
          mutatorName: 'ConditionalExpression',
          status,
        })),
      },
    },
  });
  return { profile: PROFILE, summary: summarizeMutationProfile(report, PROFILE) };
}

describe('bindMutationEvidence', () => {
  it('binds a survivor-free profile as passing fault_injection evidence', () => {
    const [r] = bindMutationEvidence(stateWithProfile(), [evaluation(['Killed', 'Killed'])], NOW);
    expect(r).toMatchObject({
      claimId: CLAIM,
      providerKind: 'fault_injection',
      providerVersion: MUTATION_PROVIDER_VERSION,
      status: 'pass',
      binding: { kind: 'implementation', digest: IMPL_DIGEST },
      input: { command: 'npm run mutation' },
      source: {
        location: 'mutation-profile:proofgraph-evaluator',
        stableId: 'proofgraph-evaluator',
      },
    });
  });

  it('binds surviving mutants as FAILING evidence', () => {
    const [r] = bindMutationEvidence(stateWithProfile(), [evaluation(['Killed', 'Survived'])], NOW);
    expect(r!.status).toBe('fail');
    expect(r!.detail).toContain('1 surviving');
  });

  it('emits unavailable when no report was recorded (never a pass-by-fallback)', () => {
    const [r] = bindMutationEvidence(stateWithProfile(), [{ profile: PROFILE }], NOW);
    expect(r!.status).toBe('unavailable');
    expect(r!.detail).toContain('no recorded mutation results');
  });

  it('emits unavailable when the report does not cover the profile', () => {
    const uncovered = MutationReport.parse({ schemaVersion: '1.0', files: {} });
    const [r] = bindMutationEvidence(
      stateWithProfile(),
      [{ profile: PROFILE, summary: summarizeMutationProfile(uncovered, PROFILE) }],
      NOW,
    );
    expect(r!.status).toBe('unavailable');
  });

  it('emits unavailable for an unknown profile reference', () => {
    const [r] = bindMutationEvidence(stateWithProfile('nope'), [evaluation(['Killed'])], NOW);
    expect(r!.status).toBe('unavailable');
    expect(r!.detail).toContain('unknown mutation profile');
  });

  it('emits unavailable when there is no implementation revision to bind to', () => {
    const [r] = bindMutationEvidence(
      stateWithProfile(PROFILE.profileId, false),
      [evaluation(['Killed'])],
      NOW,
    );
    expect(r!.status).toBe('unavailable');
    expect(r!.detail).toContain('no implementation revision');
  });

  it('emits nothing for claims that do not reference a mutation profile', () => {
    const state = makeState('IMPL_VALIDATION', {
      proofContract: {
        version: 'contract.v1',
        claims: [
          {
            claimId: CLAIM,
            statement: 'x',
            signalClass: 'fact' as const,
            critical: true,
            provenance: AUTHORITY_REF,
            evidenceRefs: [{ kind: 'content' as const, digest: 'd' }],
            counterexampleRefs: [],
          },
        ],
      },
    });
    expect(bindMutationEvidence(state, [evaluation(['Killed'])], NOW)).toEqual([]);
  });

  it('emits results that satisfy the strict provider schema', () => {
    const cases: MutationEvaluation[][] = [
      [evaluation(['Killed'])],
      [evaluation(['Survived'])],
      [{ profile: PROFILE }],
    ];
    for (const evaluations of cases) {
      for (const r of bindMutationEvidence(stateWithProfile(), evaluations, NOW)) {
        expect(() => ProofProviderResult.parse(r)).not.toThrow();
      }
    }
  });
});

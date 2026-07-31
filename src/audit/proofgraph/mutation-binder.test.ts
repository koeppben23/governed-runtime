/**
 * @module audit/proofgraph/mutation-binder.test
 * @description Binding recorded mutation verdicts to declared claims (#762).
 *
 * These tests verify that mutation evidence is NEVER bound to the current
 * session implementation digest. The binder must use the RECORDED digest and
 * timestamps from the recorded envelope.
 */
import { describe, it, expect } from 'vitest';
import { bindMutationEvidence, MUTATION_PROVIDER_VERSION } from './mutation-binder.js';
import type { MutationEvaluation } from './mutation-binder.js';
import {
  summarizeMutationProfile,
  RecordedMutationEvidence,
  MutationReport,
} from './mutation-report.js';
import type {
  MutationProfile,
  RecordedMutationEvidence as RecordedMutationEvidenceType,
} from './mutation-report.js';
import { ProofProviderResult } from '../../state/proofgraph.js';
import { makeState } from '../../fixtures.js';
import type { SessionState } from '../../state/schema.js';

const NOW = '2026-01-01T00:00:00.000Z';
const CLAIM = '00000000-0000-4000-8000-000000000001';
const EVALUATOR = 'src/audit/proofgraph/evaluate.ts';
const RECORDED_DIGEST = 'recorded-impl-digest';
const CURRENT_DIGEST = 'impl-current';
const REPORT_DIGEST = 'a'.repeat(64);
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

function envelope(
  implementationDigest: string = RECORDED_DIGEST,
  overrides: Partial<RecordedMutationEvidenceType> = {},
): RecordedMutationEvidenceType {
  return RecordedMutationEvidence.parse({
    version: 'mutation-evidence.v1',
    implementationDigest,
    command: 'npm run mutation',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:05:00.000Z',
    reportDigest: REPORT_DIGEST,
    reportPath: 'reports/mutation/mutation.json',
    providerVersion: MUTATION_PROVIDER_VERSION,
    ...overrides,
  });
}

function stateWithProfile(
  profileId = PROFILE.profileId,
  implDigest: string | null = CURRENT_DIGEST,
): SessionState {
  const implementation = implDigest
    ? {
        implementation: {
          changedFiles: ['a.ts'],
          domainFiles: [],
          digest: implDigest,
          executedAt: NOW,
        },
      }
    : {};
  return makeState('IMPL_VALIDATION', {
    ...implementation,
    proofContract: {
      version: 'contract.v1',
      claims: [
        {
          claimId: CLAIM,
          statement: 'the evaluator semantics are pinned by tests',
          signalClass: 'fact',
          critical: true,
          provenance: AUTHORITY_REF,
          evidenceRefs: [{ kind: 'mutation_profile', profileId }],
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
  describe('with a recorded envelope', () => {
    it('binds a survivor-free profile as passing fault_injection evidence using the RECORDED digest', () => {
      const [r] = bindMutationEvidence(
        stateWithProfile(),
        [evaluation(['Killed', 'Killed'])],
        envelope(),
        NOW,
      );
      expect(r).toMatchObject({
        claimId: CLAIM,
        providerKind: 'fault_injection',
        providerVersion: MUTATION_PROVIDER_VERSION,
        status: 'pass',
        binding: { kind: 'implementation', digest: RECORDED_DIGEST },
        input: { command: 'npm run mutation' },
        source: {
          location: 'mutation-profile:proofgraph-evaluator',
          stableId: 'proofgraph-evaluator',
        },
        resultDigest: REPORT_DIGEST,
        executedAt: '2026-01-01T00:05:00.000Z',
      });
    });

    it('binds surviving mutants as FAILING evidence', () => {
      const [r] = bindMutationEvidence(
        stateWithProfile(),
        [evaluation(['Killed', 'Survived'])],
        envelope(),
        NOW,
      );
      expect(r!.status).toBe('fail');
      expect(r!.detail).toContain('1 surviving');
      expect(r!.executedAt).toBe('2026-01-01T00:05:00.000Z');
    });

    it('binds to the RECORDED digest, NOT the current state implementation digest', () => {
      // The state has a DIFFERENT implementation digest than the envelope.
      const [r] = bindMutationEvidence(
        stateWithProfile(PROFILE.profileId, 'different-current-digest'),
        [evaluation(['Killed'])],
        envelope(RECORDED_DIGEST),
        NOW,
      );
      expect(r).toMatchObject({ binding: { kind: 'implementation', digest: RECORDED_DIGEST } });
    });

    it('preserves the recorded completedAt timestamp, never the evaluation timestamp', () => {
      const env = envelope(RECORDED_DIGEST, { completedAt: '2025-11-15T12:00:00.000Z' });
      const [r] = bindMutationEvidence(
        stateWithProfile(),
        [evaluation(['Killed'])],
        env,
        '9999-01-01T00:00:00.000Z',
      );
      expect(r!.executedAt).toBe('2025-11-15T12:00:00.000Z');
    });

    it('emits unavailable when no report was recorded (never a pass-by-fallback)', () => {
      const [r] = bindMutationEvidence(stateWithProfile(), [{ profile: PROFILE }], envelope(), NOW);
      expect(r!.status).toBe('unavailable');
      expect(r!.detail).toContain('no recorded mutation results');
    });

    it('emits unavailable when the report does not cover the profile', () => {
      const uncovered = MutationReport.parse({ schemaVersion: '1.0', files: {} });
      const [r] = bindMutationEvidence(
        stateWithProfile(),
        [{ profile: PROFILE, summary: summarizeMutationProfile(uncovered, PROFILE) }],
        envelope(),
        NOW,
      );
      expect(r!.status).toBe('unavailable');
    });

    it('emits unavailable for an unknown profile reference', () => {
      const [r] = bindMutationEvidence(
        stateWithProfile('nope'),
        [evaluation(['Killed'])],
        envelope(),
        NOW,
      );
      expect(r!.status).toBe('unavailable');
      expect(r!.detail).toContain('unknown mutation profile');
    });

    it('emits nothing for claims that do not reference a mutation profile', () => {
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
      });
      expect(bindMutationEvidence(state, [evaluation(['Killed'])], envelope(), NOW)).toEqual([]);
    });
  });

  describe('without a recorded envelope (legacy / unbound)', () => {
    it('returns unavailable for every mutation_profile reference (no pass-by-fallback)', () => {
      const results = bindMutationEvidence(
        stateWithProfile(),
        [evaluation(['Killed', 'Killed'])],
        null,
        NOW,
      );
      expect(results).toHaveLength(1);
      expect(results[0]!.status).toBe('unavailable');
      expect(results[0]!.detail).toContain('unbound legacy mutation report');
      expect(results[0]!.detail).toContain('mutation-evidence.v1');
    });

    it('does not crash or pass when there are no evaluations', () => {
      const results = bindMutationEvidence(stateWithProfile(), [], null, NOW);
      expect(results).toHaveLength(1);
      expect(results[0]!.status).toBe('unavailable');
    });

    it('uses evaluatedAt for the unavailable result timestamp', () => {
      const [r] = bindMutationEvidence(
        stateWithProfile(),
        [evaluation(['Killed'])],
        null,
        '2026-06-01T00:00:00.000Z',
      );
      expect(r!.executedAt).toBe('2026-06-01T00:00:00.000Z');
    });
  });

  describe('schema compliance', () => {
    it('emits pass/fail results that satisfy the strict provider schema', () => {
      const cases: { evals: MutationEvaluation[]; env: RecordedMutationEvidenceType | null }[] = [
        { evals: [evaluation(['Killed'])], env: envelope() },
        { evals: [evaluation(['Survived'])], env: envelope() },
        { evals: [{ profile: PROFILE }], env: envelope() },
        { evals: [evaluation(['Killed'])], env: null },
      ];
      for (const { evals, env } of cases) {
        for (const r of bindMutationEvidence(stateWithProfile(), evals, env, NOW)) {
          expect(() => ProofProviderResult.parse(r)).not.toThrow();
        }
      }
    });
  });
});

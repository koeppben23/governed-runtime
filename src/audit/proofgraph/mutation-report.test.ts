/**
 * @module audit/proofgraph/mutation-report.test
 * @description Survivor reporting for selected semantic mutation profiles (#762).
 *
 * Deterministic and fixture-driven on purpose: acceptance criterion 12 requires
 * survivor reporting to be TESTED without depending on an unreliable per-PR
 * global mutation run. No mutation tool is executed here.
 */
import { describe, it, expect } from 'vitest';
import {
  MutationReport,
  RecordedMutationEvidence,
  summarizeMutationProfile,
  computeReportDigest,
  verifyReportDigest,
  type MutationProfile,
} from './mutation-report.js';

const EVALUATOR = 'src/audit/proofgraph/evaluate.ts';
const GATE = 'src/audit/proofgraph/gate.ts';

const PROFILE: MutationProfile = {
  profileId: 'proofgraph-evaluator',
  locations: [EVALUATOR],
  command: 'npm run mutation',
};

function mutant(id: string, status: string, mutatorName = 'ConditionalExpression') {
  return { id, mutatorName, status, location: { start: { line: 1 } } };
}

/** Minimal fixture in the mutation-testing-elements shape Stryker emits. */
function report(files: Record<string, ReturnType<typeof mutant>[]>): MutationReport {
  return MutationReport.parse({
    schemaVersion: '1.0',
    files: Object.fromEntries(Object.entries(files).map(([path, mutants]) => [path, { mutants }])),
  });
}

describe('MutationReport parsing', () => {
  it('parses a Stryker-shaped report and ignores unconsumed foreign fields', () => {
    const parsed = MutationReport.parse({
      schemaVersion: '1.0',
      projectRoot: '/repo',
      thresholds: { high: 85, low: 80, break: 80 },
      files: {
        [EVALUATOR]: {
          language: 'typescript',
          source: 'export const x = 1;',
          mutants: [{ ...mutant('0', 'Killed'), replacement: '{}', coveredBy: ['1'] }],
        },
      },
    });
    expect(parsed.files[EVALUATOR]!.mutants[0]!.status).toBe('Killed');
  });

  it('fails closed on a malformed report (missing schemaVersion)', () => {
    expect(() => MutationReport.parse({ files: {} })).toThrow();
  });

  it('fails closed on an unknown mutant status', () => {
    expect(() => report({ [EVALUATOR]: [mutant('0', 'Exploded')] })).toThrow();
  });
});

describe('summarizeMutationProfile', () => {
  it('reports no survivors when every mutant was detected', () => {
    const s = summarizeMutationProfile(
      report({ [EVALUATOR]: [mutant('0', 'Killed'), mutant('1', 'Timeout')] }),
      PROFILE,
    );
    expect(s).toMatchObject({ covered: true, killedCount: 2, survivorCount: 0, excludedCount: 0 });
    expect(s.survivors).toEqual([]);
  });

  it('reports a Survived mutant as a survivor', () => {
    const s = summarizeMutationProfile(
      report({ [EVALUATOR]: [mutant('0', 'Killed'), mutant('1', 'Survived', 'BlockStatement')] }),
      PROFILE,
    );
    expect(s.survivorCount).toBe(1);
    expect(s.survivors[0]).toEqual({
      mutantId: '1',
      location: EVALUATOR,
      mutatorName: 'BlockStatement',
      status: 'Survived',
    });
  });

  it('treats NoCoverage as a survivor (no test exercised the mutant)', () => {
    const s = summarizeMutationProfile(
      report({ [EVALUATOR]: [mutant('0', 'NoCoverage')] }),
      PROFILE,
    );
    expect(s.survivorCount).toBe(1);
    expect(s.survivors[0]!.status).toBe('NoCoverage');
  });

  it('excludes CompileError/RuntimeError/Ignored instead of counting them as detected', () => {
    const s = summarizeMutationProfile(
      report({
        [EVALUATOR]: [
          mutant('0', 'CompileError'),
          mutant('1', 'RuntimeError'),
          mutant('2', 'Ignored'),
        ],
      }),
      PROFILE,
    );
    expect(s).toMatchObject({ killedCount: 0, survivorCount: 0, excludedCount: 3 });
  });

  it('reports covered=false when the report does not include the profile locations', () => {
    const s = summarizeMutationProfile(report({ [GATE]: [mutant('0', 'Killed')] }), PROFILE);
    expect(s.covered).toBe(false);
    expect(s.killedCount).toBe(0);
  });

  it('only counts mutants inside the profile (does not leak other files)', () => {
    const s = summarizeMutationProfile(
      report({ [EVALUATOR]: [mutant('0', 'Killed')], [GATE]: [mutant('9', 'Survived')] }),
      PROFILE,
    );
    expect(s).toMatchObject({ killedCount: 1, survivorCount: 0 });
  });

  it('is deterministic: identical reports yield an identical result digest', () => {
    const build = () => report({ [EVALUATOR]: [mutant('1', 'Survived'), mutant('0', 'Killed')] });
    expect(summarizeMutationProfile(build(), PROFILE).resultDigest).toBe(
      summarizeMutationProfile(build(), PROFILE).resultDigest,
    );
  });

  it('changes the result digest when survivor status changes', () => {
    const killed = summarizeMutationProfile(
      report({ [EVALUATOR]: [mutant('0', 'Killed')] }),
      PROFILE,
    );
    const survived = summarizeMutationProfile(
      report({ [EVALUATOR]: [mutant('0', 'Survived')] }),
      PROFILE,
    );
    expect(killed.resultDigest).not.toBe(survived.resultDigest);
  });

  it('sorts survivors deterministically across files', () => {
    const multi: MutationProfile = { ...PROFILE, locations: [GATE, EVALUATOR] };
    const s = summarizeMutationProfile(
      report({ [GATE]: [mutant('2', 'Survived')], [EVALUATOR]: [mutant('1', 'Survived')] }),
      multi,
    );
    expect(s.survivors.map((x) => x.location)).toEqual([EVALUATOR, GATE]);
  });
});

describe('RecordedMutationEvidence envelope', () => {
  it('parses a valid mutation-evidence.v1 envelope', () => {
    const parsed = RecordedMutationEvidence.parse({
      version: 'mutation-evidence.v1',
      implementationDigest: 'a'.repeat(64),
      command: 'npm run mutation',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:05:00.000Z',
      reportDigest: 'b'.repeat(64),
      reportPath: 'reports/mutation/mutation.json',
      providerVersion: 'semantic-mutation.v1',
    });
    expect(parsed.version).toBe('mutation-evidence.v1');
    expect(parsed.implementationDigest).toBe('a'.repeat(64));
  });

  it('fails closed on a missing required field (strict)', () => {
    expect(() => RecordedMutationEvidence.parse({ version: 'mutation-evidence.v1' })).toThrow();
  });

  it('fails closed on extra unknown fields (strict)', () => {
    expect(() =>
      RecordedMutationEvidence.parse({
        version: 'mutation-evidence.v1',
        implementationDigest: 'a'.repeat(64),
        command: 'npm run mutation',
        startedAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-01T00:05:00.000Z',
        reportDigest: 'b'.repeat(64),
        reportPath: 'reports/mutation/mutation.json',
        providerVersion: 'semantic-mutation.v1',
        injected: true,
      }),
    ).toThrow();
  });
});

describe('computeReportDigest', () => {
  it('is deterministic: same report yields the same digest', () => {
    const r = report({ [EVALUATOR]: [mutant('0', 'Killed')] });
    expect(computeReportDigest(r)).toBe(computeReportDigest(r));
  });

  it('differs when the report content changes', () => {
    const a = report({ [EVALUATOR]: [mutant('0', 'Killed')] });
    const b = report({ [EVALUATOR]: [mutant('0', 'Survived')] });
    expect(computeReportDigest(a)).not.toBe(computeReportDigest(b));
  });
});

describe('verifyReportDigest', () => {
  function envelope(digest: string): RecordedMutationEvidence {
    return RecordedMutationEvidence.parse({
      version: 'mutation-evidence.v1',
      implementationDigest: 'a'.repeat(64),
      command: 'npm run mutation',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:05:00.000Z',
      reportDigest: digest,
      reportPath: 'reports/mutation/mutation.json',
      providerVersion: 'semantic-mutation.v1',
    });
  }

  it('returns true when the report digest matches', () => {
    const r = report({ [EVALUATOR]: [mutant('0', 'Killed')] });
    expect(verifyReportDigest(envelope(computeReportDigest(r)), r)).toBe(true);
  });

  it('returns false for a tampered report', () => {
    const orig = report({ [EVALUATOR]: [mutant('0', 'Killed')] });
    const env = envelope(computeReportDigest(orig));
    const tampered = report({ [EVALUATOR]: [mutant('0', 'Survived')] });
    expect(verifyReportDigest(env, tampered)).toBe(false);
  });
});

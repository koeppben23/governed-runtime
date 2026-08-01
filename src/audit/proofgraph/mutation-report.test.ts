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
  summarizeMutationProfile,
  computeProjectionDigest,
  computeArtifactDigest,
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
    expect(s).toMatchObject({
      covered: true,
      killedCount: 2,
      survivorCount: 0,
      excludedCount: 0,
    });
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
    // No evaluated mutants → the verdict is NOT valid evidence.
    expect(s.covered).toBe(false);
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

  it('is deterministic: identical reports yield an identical projection digest', () => {
    const build = () => report({ [EVALUATOR]: [mutant('1', 'Survived'), mutant('0', 'Killed')] });
    expect(summarizeMutationProfile(build(), PROFILE).projectionDigest).toBe(
      summarizeMutationProfile(build(), PROFILE).projectionDigest,
    );
  });

  it('changes the projection digest when survivor status changes', () => {
    const killed = summarizeMutationProfile(
      report({ [EVALUATOR]: [mutant('0', 'Killed')] }),
      PROFILE,
    );
    const survived = summarizeMutationProfile(
      report({ [EVALUATOR]: [mutant('0', 'Survived')] }),
      PROFILE,
    );
    expect(killed.projectionDigest).not.toBe(survived.projectionDigest);
  });

  it('sorts survivors deterministically across files', () => {
    const multi: MutationProfile = { ...PROFILE, locations: [GATE, EVALUATOR] };
    const s = summarizeMutationProfile(
      report({ [GATE]: [mutant('2', 'Survived')], [EVALUATOR]: [mutant('1', 'Survived')] }),
      multi,
    );
    expect(s.survivors.map((x) => x.location)).toEqual([EVALUATOR, GATE]);
  });

  it('reports covered=false when the file exists but has zero mutants', () => {
    const s = summarizeMutationProfile(report({ [EVALUATOR]: [] }), PROFILE);
    expect(s.covered).toBe(false);
  });

  it('reports covered=true when NoCoverage is present (it is still a survivor)', () => {
    const s = summarizeMutationProfile(
      report({ [EVALUATOR]: [mutant('0', 'NoCoverage')] }),
      PROFILE,
    );
    expect(s.covered).toBe(true);
    expect(s.survivorCount).toBe(1);
  });

  it('reports covered=true with at least one killed mutant and no survivors', () => {
    const s = summarizeMutationProfile(report({ [EVALUATOR]: [mutant('0', 'Killed')] }), PROFILE);
    expect(s.covered).toBe(true);
    expect(s).toMatchObject({ killedCount: 1, survivorCount: 0 });
  });

  it('reports covered=false for a surface that is absent from the report', () => {
    const s = summarizeMutationProfile(report({}), PROFILE);
    expect(s.covered).toBe(false);
  });
});

describe('computeProjectionDigest', () => {
  it('is deterministic: same report yields the same digest', () => {
    const r = report({ [EVALUATOR]: [mutant('0', 'Killed')] });
    expect(computeProjectionDigest(r)).toBe(computeProjectionDigest(r));
  });

  it('differs when the report content changes', () => {
    const a = report({ [EVALUATOR]: [mutant('0', 'Killed')] });
    const b = report({ [EVALUATOR]: [mutant('0', 'Survived')] });
    expect(computeProjectionDigest(a)).not.toBe(computeProjectionDigest(b));
  });

  it('ignores unconsumed foreign fields (determinism vs Stryker noise)', () => {
    const parsed = MutationReport.parse({
      schemaVersion: '1.0',
      projectRoot: '/repo',
      thresholds: { high: 85, low: 80, break: 80 },
      files: {
        [EVALUATOR]: { language: 'typescript', source: '', mutants: [mutant('0', 'Killed')] },
      },
    });
    const minimal = report({ [EVALUATOR]: [mutant('0', 'Killed')] });
    expect(computeProjectionDigest(parsed)).toBe(computeProjectionDigest(minimal));
  });
});

describe('computeArtifactDigest', () => {
  it('covers the raw JSON bytes, not just the parsed subset', () => {
    const withExtra = JSON.stringify({
      schemaVersion: '1.0',
      projectRoot: '/repo',
      files: { [EVALUATOR]: { language: 'typescript', source: '', mutants: [] } },
    });
    const minimal = JSON.stringify({
      schemaVersion: '1.0',
      files: { [EVALUATOR]: { mutants: [] } },
    });
    expect(computeArtifactDigest(withExtra)).not.toBe(computeArtifactDigest(minimal));
  });

  it('is deterministic for identical raw input', () => {
    const raw = JSON.stringify({
      schemaVersion: '1.0',
      files: { [EVALUATOR]: { mutants: [mutant('0', 'Killed')] } },
    });
    expect(computeArtifactDigest(raw)).toBe(computeArtifactDigest(raw));
  });
});

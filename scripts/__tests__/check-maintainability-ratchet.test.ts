import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import {
  BASELINE_VERSION,
  TARGETS,
  applyMonotonicUpdate,
  buildBaseline,
  checkBaselineLineage,
  collectMetricSuppressions,
  diffMaintainability,
  functionIdentityAt,
  validateBaseline,
} from '../check-maintainability-ratchet.mjs';

interface Finding {
  file: string;
  function: string;
  rule: string;
  value: number;
}

interface Suppression {
  file: string;
  function: string;
  rule: string;
}

interface Baseline {
  version: number;
  targets: Record<string, number>;
  entries: Finding[];
  metricSuppressions: Suppression[];
}

function baselineOf(entries: Finding[] = [], metricSuppressions: Suppression[] = []): Baseline {
  return {
    version: BASELINE_VERSION,
    targets: { ...TARGETS },
    entries,
    metricSuppressions,
  };
}

function finding(file: string, fn: string, rule: string, value: number): Finding {
  return { file, function: fn, rule, value };
}

function suppression(file: string, fn: string, rule: string): Suppression {
  return { file, function: fn, rule };
}

function sourceFileOf(code: string): ts.SourceFile {
  return ts.createSourceFile('fixture.ts', code, ts.ScriptTarget.Latest, true);
}

describe('diffMaintainability', () => {
  it('accepts an exact baseline snapshot', () => {
    const base = baselineOf([finding('src/a.ts', 'function:foo', 'complexity', 18)]);
    const current = baselineOf([finding('src/a.ts', 'function:foo', 'complexity', 18)]);
    expect(diffMaintainability(base, current)).toEqual([]);
  });

  it('fails on a new finding above the target', () => {
    const problems = diffMaintainability(
      baselineOf(),
      baselineOf([finding('src/a.ts', 'function:bar', 'complexity', 13)]),
    );
    expect(problems.map((p) => p.kind)).toEqual(['new']);
  });

  it('fails on a worsened finding', () => {
    const problems = diffMaintainability(
      baselineOf([finding('src/a.ts', 'function:foo', 'complexity', 18)]),
      baselineOf([finding('src/a.ts', 'function:foo', 'complexity', 19)]),
    );
    expect(problems).toEqual([
      expect.objectContaining({ kind: 'worsened', baselineValue: 18, value: 19 }),
    ]);
  });

  it('fails on an improvement until the baseline is lowered', () => {
    const problems = diffMaintainability(
      baselineOf([finding('src/a.ts', 'function:foo', 'complexity', 18)]),
      baselineOf([finding('src/a.ts', 'function:foo', 'complexity', 16)]),
    );
    expect(problems).toEqual([
      expect.objectContaining({ kind: 'improved', baselineValue: 18, value: 16 }),
    ]);
  });

  it('fails on a resolved finding until the baseline entry is removed', () => {
    const problems = diffMaintainability(
      baselineOf([finding('src/a.ts', 'function:foo', 'complexity', 18)]),
      baselineOf(),
    );
    expect(problems).toEqual([expect.objectContaining({ kind: 'resolved', baselineValue: 18 })]);
  });

  it('fails on new and removed metric suppressions', () => {
    const added = diffMaintainability(
      baselineOf(),
      baselineOf([], [suppression('src/a.ts', 'function:foo', 'complexity')]),
    );
    expect(added.map((p) => p.kind)).toEqual(['new-suppression']);

    const removed = diffMaintainability(
      baselineOf([], [suppression('src/a.ts', 'function:foo', 'complexity')]),
      baselineOf(),
    );
    expect(removed.map((p) => p.kind)).toEqual(['stale-suppression']);
  });

  it('is line-shift tolerant because identity is line-free', () => {
    const before = sourceFileOf('function foo(a: number, b: number) { return a + b; }');
    const after = sourceFileOf('\n\n\nfunction foo(a: number, b: number) { return a + b; }');
    expect(functionIdentityAt(before, 1, 1)).toBe('function:foo');
    expect(functionIdentityAt(after, 4, 1)).toBe('function:foo');

    const base = baselineOf([finding('src/a.ts', 'function:foo', 'complexity', 18)]);
    const current = baselineOf([finding('src/a.ts', 'function:foo', 'complexity', 18)]);
    expect(diffMaintainability(base, current)).toEqual([]);
  });
});

describe('functionIdentityAt', () => {
  it('keeps two sibling anonymous functions distinguishable', () => {
    const sourceFile = sourceFileOf('const fns = [() => 1, () => 2];');
    const first = functionIdentityAt(sourceFile, 1, 14);
    const second = functionIdentityAt(sourceFile, 1, 23);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second);
  });

  it('keeps same-named nested helpers distinguishable through the enclosing path', () => {
    const sourceFile = sourceFileOf(
      [
        'function a() {',
        '  function helper() { return 1; }',
        '  return helper();',
        '}',
        'function b() {',
        '  function helper() { return 2; }',
        '  return helper();',
        '}',
      ].join('\n'),
    );
    expect(functionIdentityAt(sourceFile, 2, 3)).toBe('function:a > function:helper');
    expect(functionIdentityAt(sourceFile, 6, 3)).toBe('function:b > function:helper');
  });

  it('distinguishes methods of sibling anonymous classes', () => {
    const sourceFile = sourceFileOf(
      'const x = [class { run() { return 1; } }, class { run() { return 2; } }];',
    );
    const first = functionIdentityAt(sourceFile, 1, 20);
    const second = functionIdentityAt(sourceFile, 1, 51);
    expect(first).toContain('anonymousClass#0');
    expect(second).toContain('anonymousClass#1');
    expect(first).not.toBe(second);
  });

  it('names methods with their class and function bindings with their variable', () => {
    const sourceFile = sourceFileOf(
      ['class A { run() { return 1; } }', 'const f = function named() { return 2; };'].join('\n'),
    );
    expect(functionIdentityAt(sourceFile, 1, 11)).toBe('method:A.run');
    expect(functionIdentityAt(sourceFile, 2, 11)).toBe('function-expression:f');
  });
});

describe('collectMetricSuppressions', () => {
  it('expands a shared directive into one entry per metric rule', () => {
    const sourceFile = sourceFileOf(
      [
        '// eslint-disable-next-line complexity, max-lines-per-function',
        'export function resolveStructuredFindings(value: string) { return value; }',
      ].join('\n'),
    );
    expect(collectMetricSuppressions(sourceFile, 'src/x.ts')).toEqual([
      { file: 'src/x.ts', function: 'function:resolveStructuredFindings', rule: 'complexity' },
      {
        file: 'src/x.ts',
        function: 'function:resolveStructuredFindings',
        rule: 'max-lines-per-function',
      },
    ]);
  });

  it('ignores directives that do not name a metric rule', () => {
    const sourceFile = sourceFileOf(
      ['// eslint-disable-next-line no-console', 'export function f() { return 1; }'].join('\n'),
    );
    expect(collectMetricSuppressions(sourceFile, 'src/x.ts')).toEqual([]);
  });

  it('treats a bare disable as suppressing every metric rule (fail-closed)', () => {
    const sourceFile = sourceFileOf('/* eslint-disable */\nexport function f() { return 1; }');
    expect(
      collectMetricSuppressions(sourceFile, 'src/x.ts')
        .map((e) => e.rule)
        .sort(),
    ).toEqual(['complexity', 'max-lines-per-function', 'max-params']);
  });
});

describe('applyMonotonicUpdate', () => {
  it('refuses new findings, worsened values, and new suppressions', () => {
    const base = baselineOf([finding('src/a.ts', 'function:foo', 'complexity', 18)]);
    const current = baselineOf(
      [
        finding('src/a.ts', 'function:foo', 'complexity', 19),
        finding('src/a.ts', 'function:bar', 'complexity', 13),
      ],
      [suppression('src/a.ts', 'function:bar', 'complexity')],
    );
    const { violations, next } = applyMonotonicUpdate(base, current);
    expect(violations.map((v) => v.kind).sort()).toEqual(['new', 'new-suppression', 'worsened']);
    expect(next.entries).toEqual([]);
    expect(next.metricSuppressions).toEqual([]);
  });

  it('locks improvements and removals into the next baseline', () => {
    const base = baselineOf(
      [
        finding('src/a.ts', 'function:foo', 'complexity', 18),
        finding('src/a.ts', 'function:old', 'complexity', 15),
      ],
      [suppression('src/a.ts', 'function:foo', 'max-params')],
    );
    const current = baselineOf([finding('src/a.ts', 'function:foo', 'complexity', 16)], []);
    const { violations, next } = applyMonotonicUpdate(base, current);
    expect(violations).toEqual([]);
    expect(next.entries).toEqual([finding('src/a.ts', 'function:foo', 'complexity', 16)]);
    expect(next.metricSuppressions).toEqual([]);
  });
});

describe('buildBaseline', () => {
  it('sorts entries deterministically and pins the targets', () => {
    const built = buildBaseline({
      targets: { ...TARGETS },
      entries: [
        finding('src/b.ts', 'function:z', 'complexity', 13),
        finding('src/a.ts', 'function:y', 'max-params', 6),
        finding('src/a.ts', 'function:y', 'complexity', 20),
      ],
      metricSuppressions: [
        suppression('src/b.ts', 'function:z', 'max-params'),
        suppression('src/a.ts', 'function:y', 'complexity'),
      ],
    });
    expect(built.version).toBe(BASELINE_VERSION);
    expect(built.targets).toEqual({ complexity: 12, maxLinesPerFunction: 80, maxParams: 5 });
    expect(built.entries.map((e) => `${e.file}:${e.rule}`)).toEqual([
      'src/a.ts:complexity',
      'src/a.ts:max-params',
      'src/b.ts:complexity',
    ]);
    expect(built.metricSuppressions.map((e) => e.file)).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

describe('checkBaselineLineage', () => {
  it('fails the PR bypass: base 18, head baseline 19, head code 19', () => {
    const base = baselineOf([finding('src/a.ts', 'function:foo', 'complexity', 18)]);
    const head = baselineOf([finding('src/a.ts', 'function:foo', 'complexity', 19)]);
    const current = baselineOf([finding('src/a.ts', 'function:foo', 'complexity', 19)]);

    // The snapshot comparison alone cannot see the manually raised baseline.
    expect(diffMaintainability(head, current)).toEqual([]);
    // The lineage comparison against the PR base does.
    expect(checkBaselineLineage(base, head).map((v) => v.kind)).toEqual(['worsened']);
  });

  it('refuses new findings and new suppressions relative to the base', () => {
    const base = baselineOf([finding('src/a.ts', 'function:foo', 'complexity', 18)]);
    const head = baselineOf(
      [
        finding('src/a.ts', 'function:foo', 'complexity', 18),
        finding('src/a.ts', 'function:bar', 'complexity', 13),
      ],
      [suppression('src/a.ts', 'function:foo', 'max-params')],
    );
    expect(
      checkBaselineLineage(base, head)
        .map((v) => v.kind)
        .sort(),
    ).toEqual(['new', 'new-suppression']);
  });

  it('allows lowering and removing debt relative to the base', () => {
    const base = baselineOf(
      [
        finding('src/a.ts', 'function:foo', 'complexity', 18),
        finding('src/a.ts', 'function:bar', 'complexity', 15),
      ],
      [suppression('src/a.ts', 'function:foo', 'max-params')],
    );
    const head = baselineOf([finding('src/a.ts', 'function:foo', 'complexity', 16)]);
    expect(checkBaselineLineage(base, head)).toEqual([]);
  });
});

describe('validateBaseline', () => {
  it('accepts a well-formed baseline', () => {
    expect(
      validateBaseline(
        baselineOf(
          [finding('src/a.ts', 'function:foo', 'complexity', 18)],
          [suppression('src/a.ts', 'function:foo', 'max-params')],
        ),
      ),
    ).toEqual([]);
  });

  it('rejects duplicate identities, unknown rules, and values at or below target', () => {
    const duplicate = validateBaseline(
      baselineOf([
        finding('src/a.ts', 'function:foo', 'complexity', 18),
        finding('src/a.ts', 'function:foo', 'complexity', 19),
      ]),
    );
    expect(duplicate.join('; ')).toContain('duplicate');

    const unknown = validateBaseline(
      baselineOf([finding('src/a.ts', 'function:foo', 'no-console', 18)]),
    );
    expect(unknown.join('; ')).toContain('unknown rule');

    const belowTarget = validateBaseline(
      baselineOf([finding('src/a.ts', 'function:foo', 'complexity', 12)]),
    );
    expect(belowTarget.join('; ')).toContain('at or below target');

    const duplicateSuppression = validateBaseline(
      baselineOf(
        [],
        [
          suppression('src/a.ts', 'function:foo', 'complexity'),
          suppression('src/a.ts', 'function:foo', 'complexity'),
        ],
      ),
    );
    expect(duplicateSuppression.join('; ')).toContain('duplicate');
  });

  it('rejects mismatched targets and versions', () => {
    const wrongTargets = { ...baselineOf(), targets: { ...TARGETS, complexity: 99 } };
    expect(validateBaseline(wrongTargets).join('; ')).toContain('targets');
    const wrongVersion = { ...baselineOf(), version: 99 };
    expect(validateBaseline(wrongVersion).join('; ')).toContain('version');
  });
});

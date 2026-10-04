/**
 * @module architecture/production-zero-debt
 * @description Whole-tree fitness functions for the production zero-debt
 * syntax invariants:
 *
 * - native `Error` constructions (`new Error(...)`, `new globalThis.Error(...)`,
 *   including values that are never thrown directly) are zero;
 * - non-null assertions (`NonNullExpression`) are zero.
 *
 * These invariants are enforced at the ESLint/config layer (the non-null rule
 * is pinned to the production file class by `type-aware-lint-scope.test.ts`).
 * This guard proves the current stock is actually zero over every production
 * file and fails when a new occurrence is introduced anywhere in the tree, not
 * just in a diff. `collectProductionSources` is the single source authority for
 * what counts as production source.
 */

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

import { collectProductionSources } from './production-source.js';

const SRC = join(process.cwd(), 'src');

/** Production source files with a display path relative to `src/`. */
function sources(): Array<{ rel: string; content: string }> {
  return collectProductionSources(SRC).map((file) => ({ rel: file.rel, content: file.content }));
}

function positionOf(source: ts.SourceFile, node: ts.Node): string {
  const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `${line + 1}:${character + 1}`;
}

/** `new Error(...)` / `new globalThis.Error(...)` occurrences. */
export function nativeErrorConstructions(content: string, rel: string): string[] {
  const source = ts.createSourceFile(rel, content, ts.ScriptTarget.Latest, true);
  const findings: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node)) {
      const callee = node.expression.getText(source);
      if (callee === 'Error' || callee === 'globalThis.Error') {
        findings.push(`${rel}:${positionOf(source, node)}`);
      }
    }
    node.forEachChild(visit);
  };
  visit(source);
  return findings;
}

/** `foo!` non-null assertion occurrences. */
export function nonNullAssertions(content: string, rel: string): string[] {
  const source = ts.createSourceFile(rel, content, ts.ScriptTarget.Latest, true);
  const findings: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNonNullExpression(node)) {
      findings.push(`${rel}:${positionOf(source, node)}`);
    }
    node.forEachChild(visit);
  };
  visit(source);
  return findings;
}

describe('production zero-debt syntax invariants', () => {
  const files = sources();

  it('scans the complete non-vacuous production set', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it('contains no native Error constructions', () => {
    const findings = files.flatMap((file) => nativeErrorConstructions(file.content, file.rel));
    expect(findings, findings.join('\n')).toEqual([]);
  });

  it('contains no non-null assertions', () => {
    const findings = files.flatMap((file) => nonNullAssertions(file.content, file.rel));
    expect(findings, findings.join('\n')).toEqual([]);
  });

  describe('negative fixtures — prove the detectors fire', () => {
    it('detects native Error constructions in every value position', () => {
      const content = [
        'throw new Error("boom");',
        'const wrapped = Object.assign(new Error("boom"), { code: "X" });',
        'void Promise.reject(new globalThis.Error("boom"));',
        'class SpecificError extends Error { constructor(readonly code: string) { super(code); } }',
      ].join('\n');
      const findings = nativeErrorConstructions(content, 'fixture.ts');
      expect(findings).toHaveLength(3);
      expect(findings.every((finding) => finding.startsWith('fixture.ts:'))).toBe(true);
      expect(nativeErrorConstructions('void globalThis.Error("no-new");', 'fixture.ts')).toEqual(
        [],
      );
    });

    it('detects non-null assertions', () => {
      expect(nonNullAssertions('const value = map.get(key)!;\n', 'fixture.ts')).toEqual([
        'fixture.ts:1:15',
      ]);
      expect(nonNullAssertions('const value = map.get(key);\n', 'fixture.ts')).toEqual([]);
    });
  });
});

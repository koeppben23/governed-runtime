/**
 * @module architecture/explicit-any-discipline
 * @description Whole-tree fitness function for the production `any` invariant:
 *
 * Production source may contain `any` in EXACTLY two documented tool-boundary
 * exceptions, identified structurally (path + enclosing AST context), never by
 * line number:
 *
 * 1. `integration/tools/helpers.ts`, the `ToolDefinition.execute` method
 *    signature — the args shape is defined at runtime by each tool's Zod
 *    schema, so it cannot be typed at the definition level;
 * 2. `integration/tools/mutation/record-mutation-evidence.ts`, the `execute`
 *    method declaration implementing that contract, where both `args` and
 *    `context` arrive from the host boundary.
 *
 * Every occurrence must carry its inline `@typescript-eslint/no-explicit-any`
 * disable comment. `collectProductionSources` is the single source authority
 * for what counts as production source; this guard is AST-based so `any` text
 * inside strings or comments (for example profile help content) never counts
 * and never passes by accident.
 *
 * @version v1
 */

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

import { collectProductionSources } from './production-source.js';

const SRC = join(process.cwd(), 'src');

/** One production `any` keyword with its structural location. */
export interface AnySite {
  readonly file: string;
  readonly exception: string;
  readonly parameter: string;
  readonly justified: boolean;
}

const NO_EXECUTE_CONTEXT = '<no execute context>';
const NO_PARAMETER = '<no parameter>';

/**
 * The only two production `any` exceptions. A new exception requires a visible
 * edit of this list in the same change as the code it excuses.
 */
const ALLOWED_EXCEPTIONS = [
  'integration/tools/helpers.ts:MethodSignature:execute',
  'integration/tools/mutation/record-mutation-evidence.ts:MethodDeclaration:execute',
] as const;

/** The exact `any` parameter sites inside those two exceptions. */
const ALLOWED_SITES: readonly AnySite[] = [
  {
    file: 'integration/tools/helpers.ts',
    exception: ALLOWED_EXCEPTIONS[0],
    parameter: 'args',
    justified: true,
  },
  {
    file: 'integration/tools/mutation/record-mutation-evidence.ts',
    exception: ALLOWED_EXCEPTIONS[1],
    parameter: 'args',
    justified: true,
  },
  {
    file: 'integration/tools/mutation/record-mutation-evidence.ts',
    exception: ALLOWED_EXCEPTIONS[1],
    parameter: 'context',
    justified: true,
  },
];

function enclosingExecute(node: ts.Node): ts.MethodSignature | ts.MethodDeclaration | undefined {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (
      (ts.isMethodSignature(current) || ts.isMethodDeclaration(current)) &&
      current.name?.getText() === 'execute'
    ) {
      return current;
    }
  }
  return undefined;
}

function enclosingParameter(node: ts.Node): ts.ParameterDeclaration | undefined {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isParameter(current)) return current;
  }
  return undefined;
}

function hasInlineDisable(
  content: string,
  owner: ts.MethodSignature | ts.MethodDeclaration,
): boolean {
  const comments = ts.getLeadingCommentRanges(content, owner.getFullStart()) ?? [];
  return comments.some((range) => content.slice(range.pos, range.end).includes('no-explicit-any'));
}

/** Every `any` keyword in `content`, resolved to its structural location. */
export function anySites(content: string, rel: string): AnySite[] {
  const source = ts.createSourceFile(rel, content, ts.ScriptTarget.Latest, true);
  const sites: AnySite[] = [];
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      const owner = enclosingExecute(node);
      const parameter = enclosingParameter(node);
      sites.push({
        file: rel,
        exception: owner
          ? `${rel}:${ts.SyntaxKind[owner.kind]}:${owner.name?.getText() ?? '<anonymous>'}`
          : NO_EXECUTE_CONTEXT,
        parameter: parameter?.name.getText() ?? NO_PARAMETER,
        justified: owner ? hasInlineDisable(content, owner) : false,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

describe('production explicit-any discipline', () => {
  const files = collectProductionSources(SRC);

  it('scans the complete non-vacuous production set', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it('limits production any to the two documented tool boundary exceptions', () => {
    const sites = files.flatMap((file) => anySites(file.content, file.rel));
    expect(sites, JSON.stringify(sites, null, 2)).toEqual(ALLOWED_SITES);
  });

  it('keeps every exception justified by its inline no-explicit-any disable', () => {
    const unjustified = ALLOWED_SITES.filter((site) => !site.justified);
    expect(unjustified).toEqual([]);
    const seen = new Set(ALLOWED_SITES.map((site) => site.exception));
    expect([...seen].sort()).toEqual([...ALLOWED_EXCEPTIONS].sort());
  });

  describe('negative fixtures — prove the detector fires', () => {
    it('detects any outside the documented execute boundary', () => {
      expect(
        anySites('function f(value: any): void {}\nconst g = (x: any) => x;\n', 'fixture.ts'),
      ).toEqual([
        {
          file: 'fixture.ts',
          exception: NO_EXECUTE_CONTEXT,
          parameter: 'value',
          justified: false,
        },
        { file: 'fixture.ts', exception: NO_EXECUTE_CONTEXT, parameter: 'x', justified: false },
      ]);
    });

    it('requires the inline disable comment for an execute-context any', () => {
      const withoutDisable = 'const tool = {\n  async execute(args: any) {}\n};\n';
      expect(anySites(withoutDisable, 'fixture.ts')).toEqual([
        {
          file: 'fixture.ts',
          exception: 'fixture.ts:MethodDeclaration:execute',
          parameter: 'args',
          justified: false,
        },
      ]);
      const withDisable =
        'const tool = {\n  // eslint-disable-next-line @typescript-eslint/no-explicit-any\n  async execute(args: any) {}\n};\n';
      expect(anySites(withDisable, 'fixture.ts')[0]?.justified).toBe(true);
    });

    it('ignores any text inside comments and strings', () => {
      expect(anySites('// value: any\nconst label = "args: any";\n', 'fixture.ts')).toEqual([]);
    });
  });
});

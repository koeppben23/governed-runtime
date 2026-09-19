/**
 * @module architecture/domain-vocabulary-ssot
 * @description Default-deny guard for closed domain vocabularies that already
 * have a canonical authority: `TaskClass` (`state/schema.ts`) and `LoopVerdict`
 * (`state/evidence-primitives.ts`).
 *
 * The guard protects the DEFINITION and MEMBERSHIP of a vocabulary, not its
 * value usage. Exhaustive control flow over a canonically typed value is a
 * legitimate consumer and is never flagged — this deliberately diverges from
 * `actor-assurance-ssot`, which also guards ordinal/rank semantics.
 *
 * FLAG (competing definitions / membership authorities):
 *   - full literal union / tuple / array / inline `z.enum([...])`
 *   - `new Set([...])` holding the full literal vocabulary
 *   - same-subject membership cascade `x === A || x === B || x === C`
 *   - re-declaration of the authority type/const outside the authority
 *
 * DO NOT FLAG (semantic usage; pinned by fixtures):
 *   - individual comparisons and exhaustive `switch` / if-else
 *   - partial subsets (unions, tuples, arrays, `z.enum`)
 *   - object/Record/`z.object` keys, business mappings and ordinals
 *   - prose, comments, `new Map(...)`, and `.options`-derived sets
 *
 * @version v1
 */

import { join } from 'node:path';

import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { LoopVerdict } from '../../state/evidence-primitives.js';
import { TaskClass } from '../../state/schema.js';
import { collectProductionSources } from './production-source.js';

const SRC_ROOT = join(process.cwd(), 'src');

interface Vocabulary {
  readonly name: string;
  readonly values: ReadonlySet<string>;
  readonly authority: string;
}

const VOCABULARIES: readonly Vocabulary[] = [
  {
    name: 'TaskClass',
    values: new Set<string>(TaskClass.options),
    authority: 'state/schema.ts',
  },
  {
    name: 'LoopVerdict',
    values: new Set<string>(LoopVerdict.options),
    authority: 'state/evidence-primitives.ts',
  },
];

interface Violation {
  readonly rule: string;
  readonly line: number;
  readonly snippet: string;
}

function stringLiteralsIn(node: ts.Node): string[] {
  const out: string[] = [];
  const walk = (current: ts.Node): void => {
    if (ts.isStringLiteralLike(current)) {
      out.push(current.text);
      return;
    }
    current.forEachChild(walk);
  };
  walk(node);
  return out;
}

function unionLiteralTexts(node: ts.UnionTypeNode): string[] {
  const out: string[] = [];
  for (const member of node.types) {
    if (ts.isLiteralTypeNode(member) && ts.isStringLiteralLike(member.literal)) {
      out.push(member.literal.text);
    }
  }
  return out;
}

function tupleLiteralTexts(node: ts.TupleTypeNode): string[] {
  const out: string[] = [];
  for (const element of node.elements) {
    if (ts.isLiteralTypeNode(element) && ts.isStringLiteralLike(element.literal)) {
      out.push(element.literal.text);
    }
  }
  return out;
}

function coversVocabulary(texts: readonly string[], vocabulary: Vocabulary): boolean {
  const found = new Set(texts.filter((text) => vocabulary.values.has(text)));
  return [...vocabulary.values].every((value) => found.has(value));
}

function isZodEnumArgument(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    ts.isCallExpression(parent) &&
    ts.isPropertyAccessExpression(parent.expression) &&
    parent.expression.name.text === 'enum' &&
    parent.expression.expression.getText(parent.getSourceFile()) === 'z'
  );
}

function isInsideNewExpression(node: ts.Node, name: string): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isNewExpression(current) &&
      current.expression.getText(current.getSourceFile()) === name
    ) {
      return true;
    }
    if (ts.isBlock(current) || ts.isSourceFile(current) || ts.isFunctionLike(current)) return false;
    current = current.parent;
  }
  return false;
}

function isLogicalBinary(node: ts.Node): node is ts.BinaryExpression {
  return (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
  );
}

function isEqualityBinary(node: ts.Node): node is ts.BinaryExpression {
  return (
    ts.isBinaryExpression(node) &&
    (
      [
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
      ] as readonly ts.SyntaxKind[]
    ).includes(node.operatorToken.kind)
  );
}

interface Comparison {
  readonly subject: string;
  readonly value: string;
}

function collectComparisons(node: ts.Node, vocabulary: Vocabulary): Comparison[] {
  const out: Comparison[] = [];
  const walk = (current: ts.Node): void => {
    if (isEqualityBinary(current)) {
      const { left, right } = current;
      const literal = ts.isStringLiteralLike(left)
        ? left
        : ts.isStringLiteralLike(right)
          ? right
          : undefined;
      if (literal && vocabulary.values.has(literal.text)) {
        const subject = literal === left ? right : left;
        const subjectText = subject.getText(current.getSourceFile());
        if (!ts.isStringLiteralLike(subject) && subjectText !== literal.text) {
          out.push({ subject: subjectText, value: literal.text });
        }
      }
    }
    current.forEachChild(walk);
  };
  walk(node);
  return out;
}

/** Structural detection over one parsed production file for one vocabulary. */
function findViolations(content: string, rel: string, vocabulary: Vocabulary): Violation[] {
  const sourceFile = ts.createSourceFile(
    rel,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const out: Violation[] = [];

  const report = (node: ts.Node, rule: string, detail: string): void => {
    out.push({
      rule,
      line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
      snippet: `${detail}: ${node.getText(sourceFile).replace(/\s+/g, ' ').slice(0, 120)}`,
    });
  };

  const namedDeclaration = (node: ts.Node): string | undefined => {
    if (
      ts.isTypeAliasDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isEnumDeclaration(node)
    ) {
      return node.name?.text;
    }
    if (
      (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    ) {
      return node.name.text;
    }
    return undefined;
  };

  const walk = (node: ts.Node): void => {
    const declaredName = namedDeclaration(node);
    if (declaredName === vocabulary.name) {
      report(node, `${vocabulary.name}-redeclaration`, 're-declared vocabulary symbol');
    }

    if (ts.isUnionTypeNode(node) && coversVocabulary(unionLiteralTexts(node), vocabulary)) {
      report(node, `${vocabulary.name}-full-union`, 'full literal union');
    }
    if (ts.isTupleTypeNode(node) && coversVocabulary(tupleLiteralTexts(node), vocabulary)) {
      report(node, `${vocabulary.name}-full-tuple`, 'full literal tuple');
    }
    if (ts.isArrayLiteralExpression(node)) {
      // `new Map([...])` is a business mapping, and `.options` is the canonical
      // derivation; neither is a competing vocabulary definition.
      if (
        !isInsideNewExpression(node, 'Map') &&
        coversVocabulary(stringLiteralsIn(node), vocabulary)
      ) {
        report(
          node,
          isZodEnumArgument(node)
            ? `${vocabulary.name}-inline-zod-enum`
            : isInsideNewExpression(node, 'Set')
              ? `${vocabulary.name}-full-membership-set`
              : `${vocabulary.name}-full-array`,
          isZodEnumArgument(node)
            ? 'inline z.enum vocabulary'
            : isInsideNewExpression(node, 'Set')
              ? 'full vocabulary membership set'
              : 'full vocabulary array',
        );
      }
    }
    if (
      isLogicalBinary(node) &&
      !isLogicalBinary(node.parent) &&
      coversVocabulary(
        collectComparisons(node, vocabulary).map((comparison) => comparison.value),
        vocabulary,
      )
    ) {
      const comparisons = collectComparisons(node, vocabulary);
      const subjects = new Set(comparisons.map((comparison) => comparison.subject));
      if (subjects.size === 1) {
        report(node, `${vocabulary.name}-membership-cascade`, 'same-subject membership cascade');
      }
    }

    ts.forEachChild(node, walk);
  };

  walk(sourceFile);
  return out;
}

function formatViolations(rel: string, violations: readonly Violation[]): string[] {
  return violations.map((v) => `${rel}:${v.line} [${v.rule}] ${v.snippet}`);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('domain vocabulary SSOT (default-deny)', () => {
  it('pins the detector constants to the canonical authorities', () => {
    expect(TaskClass.options).toEqual(['TRIVIAL', 'STANDARD', 'HIGH-RISK']);
    expect(LoopVerdict.options).toEqual(['accept', 'changes_requested', 'unable_to_review']);
  });

  it('finds no competing vocabulary definition in production source', () => {
    const sources = collectProductionSources(SRC_ROOT);
    expect(sources.length).toBeGreaterThan(200);
    for (const vocabulary of VOCABULARIES) {
      expect(
        sources.some(({ rel }) => rel === vocabulary.authority),
        `${vocabulary.authority} missing from the production scan`,
      ).toBe(true);
      const violations = sources
        .filter(({ rel }) => rel !== vocabulary.authority)
        .flatMap(({ rel, content }) =>
          formatViolations(rel, findViolations(content, rel, vocabulary)),
        );
      expect(violations, violations.join('\n')).toEqual([]);
    }
  });

  describe('negative fixtures — prove every detector fires', () => {
    const taskClass = VOCABULARIES[0] as Vocabulary;
    const loopVerdict = VOCABULARIES[1] as Vocabulary;

    it('flags full literal unions', () => {
      const rules = findViolations(
        `type V = 'accept' | 'changes_requested' | 'unable_to_review';`,
        'fixture.ts',
        loopVerdict,
      ).map((v) => v.rule);
      expect(rules).toEqual(['LoopVerdict-full-union']);
    });

    it('flags full literal tuples and arrays', () => {
      expect(
        findViolations(
          `type V = ['TRIVIAL', 'STANDARD', 'HIGH-RISK'];`,
          'fixture.ts',
          taskClass,
        ).map((v) => v.rule),
      ).toEqual(['TaskClass-full-tuple']);
      expect(
        findViolations(
          `const classes = ['TRIVIAL', 'STANDARD', 'HIGH-RISK'];`,
          'fixture.ts',
          taskClass,
        ).map((v) => v.rule),
      ).toEqual(['TaskClass-full-array']);
    });

    it('flags inline z.enum vocabulary and full membership sets', () => {
      expect(
        findViolations(
          `z.enum(['accept', 'changes_requested', 'unable_to_review'])`,
          'fixture.ts',
          loopVerdict,
        ).map((v) => v.rule),
      ).toEqual(['LoopVerdict-inline-zod-enum']);
      expect(
        findViolations(
          `new Set(['TRIVIAL', 'STANDARD', 'HIGH-RISK'])`,
          'fixture.ts',
          taskClass,
        ).map((v) => v.rule),
      ).toEqual(['TaskClass-full-membership-set']);
    });

    it('flags same-subject membership cascades', () => {
      const rules = findViolations(
        `if (raw === 'TRIVIAL' || raw === 'STANDARD' || raw === 'HIGH-RISK') {}`,
        'fixture.ts',
        taskClass,
      ).map((v) => v.rule);
      expect(rules).toEqual(['TaskClass-membership-cascade']);
    });

    it('flags re-declared vocabulary symbols', () => {
      expect(
        findViolations(`type LoopVerdict = string;`, 'fixture.ts', loopVerdict).map((v) => v.rule),
      ).toEqual(['LoopVerdict-redeclaration']);
    });
  });

  describe('non-fail fixtures — usage is not a competing definition', () => {
    const taskClass = VOCABULARIES[0] as Vocabulary;
    const loopVerdict = VOCABULARIES[1] as Vocabulary;

    it('allows exhaustive switch and if-else control flow', () => {
      const switchFixture = [
        `switch (verdict) {`,
        `  case 'accept': return 1;`,
        `  case 'changes_requested': return 2;`,
        `  case 'unable_to_review': return 3;`,
        `}`,
      ].join('\n');
      expect(findViolations(switchFixture, 'fixture.ts', loopVerdict)).toEqual([]);

      const ifFixture = [
        `if (verdict === 'accept') return 1;`,
        `if (verdict === 'changes_requested') return 2;`,
        `if (verdict === 'unable_to_review') return 3;`,
      ].join('\n');
      expect(findViolations(ifFixture, 'fixture.ts', loopVerdict)).toEqual([]);
    });

    it('allows partial subsets and individual comparisons', () => {
      expect(
        findViolations(`type Mode = 'accept' | 'changes_requested';`, 'fixture.ts', loopVerdict),
      ).toEqual([]);
      expect(
        findViolations(`z.enum(['accept', 'changes_requested'])`, 'fixture.ts', loopVerdict),
      ).toEqual([]);
      expect(findViolations(`if (verdict === 'accept') {}`, 'fixture.ts', loopVerdict)).toEqual([]);
      expect(
        findViolations(
          `if (v === 'unable_to_review' || v === 'accept') {}`,
          'fixture.ts',
          loopVerdict,
        ),
      ).toEqual([]);
    });

    it('allows keyed maps, business mappings, prose, and options-derived sets', () => {
      const keyed = [
        `const order: Record<TaskClass, number> = { TRIVIAL: 0, STANDARD: 1, 'HIGH-RISK': 2 };`,
        `const prose = 'Classify as TRIVIAL, STANDARD, or HIGH-RISK';`,
        `const verdicts = new Set(LoopVerdict.options);`,
        `const mapping = new Map([['accept', 1], ['changes_requested', 2], ['unable_to_review', 3]]);`,
      ].join('\n');
      expect(findViolations(keyed, 'fixture.ts', taskClass)).toEqual([]);
      expect(findViolations(keyed, 'fixture.ts', loopVerdict)).toEqual([]);
    });
  });
});

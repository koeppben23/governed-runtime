/**
 * @module architecture/actor-assurance-ssot
 * @description Default-deny guard for the actor-assurance vocabulary authority.
 *
 * Exactly one module owns the tier vocabulary, the derived union, the closed Zod
 * schema, and the ordinal order: `shared/actor-assurance.ts`. The tuple IS the
 * ordering (index-based), so vocabulary, schema, and ordinal cannot diverge.
 *
 * Detection is STRUCTURAL: production files are parsed with the TypeScript
 * compiler API and every syntactic construct that could enumerate all three
 * tiers is inspected — object/array literals, `z.enum([...])`, unions, tuple
 * types, switch cases, `new Map(...)`, `.set(...)` chains, and comparison
 * cascades over one subject. Comments are trivia and are inert by construction,
 * and there is no line-distance parameter that a larger construct could evade.
 *
 * Invariants:
 *   A1 The tier vocabulary is defined exactly once. Named definitions
 *      (`ACTOR_ASSURANCE_TIERS`, `type ActorAssurance`) and array literals that
 *      contain all three tiers exist only in the authority. This also catches a
 *      second, differently-named tier tuple.
 *   A2 No production module defines a full three-tier union type. Order does
 *      not matter and a trailing `| null` does not hide it. Legitimate subsets
 *      (for example the two-tier approval minimum) are not flagged.
 *   A3 No production module defines a literal `z.enum([...])` of the tiers.
 *      The identifier form `z.enum(ACTOR_ASSURANCE_TIERS)` is the only
 *      admissible spelling outside the authority and is not flagged.
 *   A4 No production module defines a parallel ordinal structure
 *      (`ASSURANCE_ORDINAL`, a local `assuranceOrdinal`, or a
 *      `Record<ActorAssurance, number>`) or otherwise enumerates all three
 *      tiers in one construct (object/Map rank tables, switch cases, if/else
 *      cascades, array tuples). The schema vocabulary and ordinal order are
 *      additionally asserted against the single tuple at runtime.
 *   A5 The scan is default-wide over production source via
 *      `production-source.ts` (`isTestSourcePath`) with no directory allowlist.
 *   A6 Negative fixtures prove every detector, including long switches, inline
 *      comments, comment-prefixed code, distributed single-tier assignments,
 *      subset unions/enums, and the identifier-form schema.
 *
 * @version v2
 */

import { join } from 'node:path';

import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  ACTOR_ASSURANCE_TIERS,
  ActorAssuranceSchema,
  compareActorAssurance,
  isActorAssurance,
  isAssuranceAtLeast,
} from '../../shared/actor-assurance.js';
import { collectProductionSources, type ProductionSourceFile } from './production-source.js';

const SRC_ROOT = join(process.cwd(), 'src');

/** The sole module permitted to define the actor-assurance vocabulary. */
const AUTHORITY = 'shared/actor-assurance.ts';

/** Canonical tier names, in order. Used for detection only — never re-exported. */
const TIERS = ['best_effort', 'claim_validated', 'idp_verified'] as const;

const TIER_SET: ReadonlySet<string> = new Set(TIERS);

interface Violation {
  readonly rel: string;
  readonly line: number;
  readonly snippet: string;
  readonly rule: string;
}

function isTier(text: string): boolean {
  return TIER_SET.has(text);
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

function objectPropertyNames(node: ts.ObjectLiteralExpression): string[] {
  const out: string[] = [];
  for (const property of node.properties) {
    const name = property.name;
    if (!name) continue;
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
      out.push(name.text);
    }
  }
  return out;
}

function unionLiteralTypes(node: ts.UnionTypeNode): string[] {
  const out: string[] = [];
  for (const member of node.types) {
    if (ts.isLiteralTypeNode(member) && ts.isStringLiteralLike(member.literal)) {
      out.push(member.literal.text);
    }
  }
  return out;
}

function tupleTypeLiterals(node: ts.TupleTypeNode): string[] {
  const out: string[] = [];
  for (const element of node.elements) {
    if (ts.isLiteralTypeNode(element) && ts.isStringLiteralLike(element.literal)) {
      out.push(element.literal.text);
    }
  }
  return out;
}

function containsAllTiers(texts: readonly string[]): boolean {
  const found = new Set(texts.filter(isTier));
  return TIERS.every((tier) => found.has(tier));
}

function isZodEnumArgument(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    ts.isCallExpression(parent) &&
    ts.isPropertyAccessExpression(parent.expression) &&
    parent.expression.expression.getText(parent.getSourceFile()) === 'z' &&
    parent.expression.name.text === 'enum'
  );
}

function isInsideNewMap(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isNewExpression(current) &&
      current.expression.getText(current.getSourceFile()) === 'Map'
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

interface SubjectGroup {
  readonly tiers: Set<string>;
  readonly line: number;
}

function addToGroup(
  groups: Map<string, SubjectGroup>,
  subject: string,
  tier: string,
  line: number,
): void {
  const group = groups.get(subject) ?? { tiers: new Set<string>(), line };
  group.tiers.add(tier);
  groups.set(subject, group);
}

function groupViolations(
  groups: Map<string, SubjectGroup>,
  rel: string,
  rule: string,
  description: string,
): Violation[] {
  const out: Violation[] = [];
  for (const [subject, group] of groups) {
    if (!TIERS.every((tier) => group.tiers.has(tier))) continue;
    out.push({
      rel,
      line: group.line,
      snippet: `${description} '${subject}'`,
      rule,
    });
  }
  return out;
}

/** Structural detection over one parsed production file. */
function findViolations(content: string, rel: string): Violation[] {
  const sourceFile = ts.createSourceFile(
    rel,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const out: Violation[] = [];
  const setGroups = new Map<string, SubjectGroup>();
  const comparisonGroups = new Map<string, SubjectGroup>();

  const report = (node: ts.Node, rule: string, detail: string): void => {
    out.push({
      rel,
      line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
      snippet: `${detail}: ${node.getText(sourceFile).replace(/\s+/g, ' ').slice(0, 120)}`.trim(),
      rule,
    });
  };

  const walk = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'ACTOR_ASSURANCE_TIERS'
    ) {
      report(node, 'duplicate-assurance-vocabulary', 're-declared tier vocabulary');
    }
    if (
      (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
      node.name.text === 'ActorAssurance'
    ) {
      report(node, 'duplicate-assurance-vocabulary', 're-declared tier type');
    }
    if (
      (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      (node.name.text === 'ASSURANCE_ORDINAL' || node.name.text === 'assuranceOrdinal')
    ) {
      report(node, 'duplicate-assurance-ordinal', 'parallel ordinal definition');
    }
    if (
      ts.isTypeReferenceNode(node) &&
      node.getText(sourceFile).replace(/\s+/g, '') === 'Record<ActorAssurance,number>'
    ) {
      report(node, 'duplicate-assurance-ordinal', 'parallel ordinal type');
    }
    if (ts.isUnionTypeNode(node) && containsAllTiers(unionLiteralTypes(node))) {
      report(node, 'duplicate-assurance-union', 'full tier union');
    }
    if (ts.isTupleTypeNode(node) && containsAllTiers(tupleTypeLiterals(node))) {
      report(node, 'duplicate-assurance-literal-set', 'tier tuple type');
    }
    if (ts.isArrayLiteralExpression(node)) {
      const literals = stringLiteralsIn(node);
      if (containsAllTiers(literals) && !isInsideNewMap(node)) {
        report(
          node,
          isZodEnumArgument(node)
            ? 'duplicate-assurance-zod-enum'
            : 'duplicate-assurance-literal-set',
          isZodEnumArgument(node) ? 'literal z.enum tier list' : 'tier array literal',
        );
      }
    }
    if (ts.isObjectLiteralExpression(node) && containsAllTiers(objectPropertyNames(node))) {
      report(node, 'duplicate-assurance-tier-enumeration', 'tier key enumeration');
    }
    if (ts.isSwitchStatement(node)) {
      const caseLiterals = node.caseBlock.clauses.flatMap((clause) =>
        ts.isCaseClause(clause) && ts.isStringLiteralLike(clause.expression)
          ? [clause.expression.text]
          : [],
      );
      if (containsAllTiers(caseLiterals)) {
        report(node, 'duplicate-assurance-tier-enumeration', 'tier switch enumeration');
      }
    }
    if (
      ts.isNewExpression(node) &&
      node.expression.getText(sourceFile) === 'Map' &&
      containsAllTiers(stringLiteralsIn(node))
    ) {
      report(node, 'duplicate-assurance-tier-enumeration', 'tier Map enumeration');
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'set'
    ) {
      const args = node.arguments;
      const first = args[0];
      if (first && ts.isStringLiteralLike(first) && isTier(first.text)) {
        addToGroup(
          setGroups,
          node.expression.expression.getText(sourceFile),
          first.text,
          sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        );
      }
      if (containsAllTiers(stringLiteralsIn(node))) {
        report(node, 'duplicate-assurance-tier-enumeration', 'tier set-chain enumeration');
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      (
        [
          ts.SyntaxKind.EqualsEqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsEqualsToken,
          ts.SyntaxKind.EqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsToken,
        ] as readonly ts.SyntaxKind[]
      ).includes(node.operatorToken.kind)
    ) {
      const left = node.left;
      const right = node.right;
      const literal = ts.isStringLiteralLike(left)
        ? left
        : ts.isStringLiteralLike(right)
          ? right
          : undefined;
      if (literal && isTier(literal.text)) {
        const subject = literal === left ? right : left;
        const subjectText = subject.getText(sourceFile);
        if (subjectText !== literal.text) {
          addToGroup(
            comparisonGroups,
            subjectText,
            literal.text,
            sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          );
        }
      }
    }

    node.forEachChild(walk);
  };

  sourceFile.forEachChild(walk);

  out.push(
    ...groupViolations(
      setGroups,
      rel,
      'duplicate-assurance-tier-enumeration',
      'tier .set enumeration on',
    ),
  );
  out.push(
    ...groupViolations(
      comparisonGroups,
      rel,
      'duplicate-assurance-tier-enumeration',
      'tier comparison cascade on',
    ),
  );

  return out;
}

/** Path-exempt scan: the authority may define the vocabulary; every other file may not. */
function scanFiles(files: readonly ProductionSourceFile[]): Violation[] {
  const out: Violation[] = [];
  for (const file of files) {
    if (file.rel === AUTHORITY) continue;
    out.push(...findViolations(file.content, file.rel));
  }
  return out;
}

const productionFiles = collectProductionSources(SRC_ROOT);

describe('actor assurance SSOT (default-deny)', () => {
  it('A1-A4: no production module duplicates the vocabulary, union, schema, or ordinal', () => {
    const violations = scanFiles(productionFiles);
    if (violations.length > 0) {
      console.error('Actor assurance SSOT violations:', violations);
    }
    expect(violations).toEqual([]);
  });

  it('A4: schema vocabulary and ordinal order derive from the single tuple', () => {
    // toEqual (not ===): the schema and the tuple are distinct array instances.
    expect(ActorAssuranceSchema.options).toEqual([...ACTOR_ASSURANCE_TIERS]);

    for (let index = 1; index < ACTOR_ASSURANCE_TIERS.length; index++) {
      const weaker = ACTOR_ASSURANCE_TIERS[index - 1]!;
      const stronger = ACTOR_ASSURANCE_TIERS[index]!;
      expect(compareActorAssurance(stronger, weaker)).toBeGreaterThan(0);
      expect(isAssuranceAtLeast(weaker, stronger)).toBe(false);
      expect(isAssuranceAtLeast(stronger, weaker)).toBe(true);
    }

    expect(isAssuranceAtLeast(undefined, ACTOR_ASSURANCE_TIERS[0])).toBe(false);
    for (const tier of ACTOR_ASSURANCE_TIERS) {
      expect(isActorAssurance(tier)).toBe(true);
    }
    expect(isActorAssurance('verified')).toBe(false);
  });

  it('A5: the production scan is default-wide and excludes test sources', () => {
    const rels = productionFiles.map((file) => file.rel);
    expect(rels).toContain(AUTHORITY);
    expect(rels).toContain('identity/actor-info.ts');
    expect(rels.some((rel) => rel.startsWith('config/'))).toBe(true);
    expect(rels.some((rel) => rel.startsWith('state/'))).toBe(true);
    expect(rels.some((rel) => rel.startsWith('rails/'))).toBe(true);
    expect(rels.some((rel) => rel.startsWith('integration/'))).toBe(true);
    expect(rels).not.toContain('architecture/__tests__/actor-assurance-ssot.test.ts');
    expect(rels).not.toContain('shared/actor-assurance.test.ts');
  });

  describe('negative fixtures — prove every detector', () => {
    const findAll = (content: string, rel = 'config/rogue.ts'): Violation[] =>
      findViolations(content, rel);

    it('fires on a multiline type union outside the authority', () => {
      const fixture = [
        'type Rogue =',
        "  | 'best_effort'",
        "  | 'claim_validated'",
        "  | 'idp_verified';",
      ].join('\n');
      expect(findAll(fixture).some((v) => v.rule === 'duplicate-assurance-union')).toBe(true);
    });

    it('fires on a permuted union and on a union with a | null suffix', () => {
      expect(
        findAll("type A = 'idp_verified' | 'best_effort' | 'claim_validated';").some(
          (v) => v.rule === 'duplicate-assurance-union',
        ),
      ).toBe(true);
      expect(
        findAll("type A = 'best_effort' | 'claim_validated' | 'idp_verified' | null;").some(
          (v) => v.rule === 'duplicate-assurance-union',
        ),
      ).toBe(true);
    });

    it('does NOT fire on a subset union or on single literals', () => {
      expect(findAll("type Subset = 'claim_validated' | 'idp_verified';")).toEqual([]);
      expect(findAll("const assurance = 'best_effort';")).toEqual([]);
      expect(
        findAll("const message = 'A verified actor with assurance=claim_validated is required';"),
      ).toEqual([]);
    });

    it('does NOT fire on comments — JSDoc or inline — that mention the tiers', () => {
      const jsdoc = [
        '/**',
        " * 'best_effort' | 'claim_validated' | 'idp_verified'",
        ' */',
        'export const x = 1;',
      ].join('\n');
      expect(findAll(jsdoc)).toEqual([]);

      const inline = "const x = 1; // 'best_effort' | 'claim_validated' | 'idp_verified'";
      expect(findAll(inline)).toEqual([]);

      const blockInline = "const x = 1; /* 'best_effort' | 'claim_validated' | 'idp_verified' */";
      expect(findAll(blockInline)).toEqual([]);
    });

    it('still fires on code that is preceded by a block comment on the same line', () => {
      const prefixed = [
        '/* explanation */ const ranks = {',
        '  best_effort: 0,',
        '  claim_validated: 1,',
        '  idp_verified: 2,',
        '};',
      ].join('\n');
      expect(findAll(prefixed).some((v) => v.rule === 'duplicate-assurance-tier-enumeration')).toBe(
        true,
      );
    });

    it('fires on a re-declared named vocabulary and on a re-declared type alias', () => {
      const vocabulary = findAll("export const ACTOR_ASSURANCE_TIERS = ['best_effort'] as const;");
      expect(vocabulary.some((v) => v.rule === 'duplicate-assurance-vocabulary')).toBe(true);
      const alias = findAll("export type ActorAssurance = 'best_effort';");
      expect(alias.some((v) => v.rule === 'duplicate-assurance-vocabulary')).toBe(true);
    });

    it('fires on a differently-named full tier array literal and tuple type', () => {
      expect(
        findAll("const tiers = ['best_effort', 'claim_validated', 'idp_verified'];").some(
          (v) => v.rule === 'duplicate-assurance-literal-set',
        ),
      ).toBe(true);
      expect(
        findAll("type Tiers = ['best_effort', 'claim_validated', 'idp_verified'];").some(
          (v) => v.rule === 'duplicate-assurance-literal-set',
        ),
      ).toBe(true);
    });

    it('fires on literal z.enum tier lists (single-line, multiline, permuted)', () => {
      expect(
        findAll("z.enum(['best_effort', 'claim_validated', 'idp_verified'])").some(
          (v) => v.rule === 'duplicate-assurance-zod-enum',
        ),
      ).toBe(true);
      expect(
        findAll(
          ['z.enum([', "  'best_effort',", "  'claim_validated',", "  'idp_verified',", '])'].join(
            '\n',
          ),
        ).some((v) => v.rule === 'duplicate-assurance-zod-enum'),
      ).toBe(true);
      expect(
        findAll("z.enum(['idp_verified', 'best_effort', 'claim_validated'])").some(
          (v) => v.rule === 'duplicate-assurance-zod-enum',
        ),
      ).toBe(true);
    });

    it('does NOT fire on the identifier-form schema or on a subset enum', () => {
      expect(findAll('z.enum(ACTOR_ASSURANCE_TIERS)')).toEqual([]);
      expect(findAll("z.enum(['claim_validated', 'idp_verified'])")).toEqual([]);
    });

    it('fires on parallel ordinal structures', () => {
      expect(
        findAll('const ASSURANCE_ORDINAL = { best_effort: 0 };').some(
          (v) => v.rule === 'duplicate-assurance-ordinal',
        ),
      ).toBe(true);
      expect(
        findAll('function assuranceOrdinal(value) { return 0; }').some(
          (v) => v.rule === 'duplicate-assurance-ordinal',
        ),
      ).toBe(true);
      expect(
        findAll('const ranks: Record<ActorAssurance, number> = {};').some(
          (v) => v.rule === 'duplicate-assurance-ordinal',
        ),
      ).toBe(true);
    });

    it('fires on an object rank table with bare or quoted tier keys', () => {
      const bare = [
        'const assuranceRank = {',
        '  best_effort: 0,',
        '  claim_validated: 1,',
        '  idp_verified: 2,',
        '} as const;',
      ].join('\n');
      expect(findAll(bare).some((v) => v.rule === 'duplicate-assurance-tier-enumeration')).toBe(
        true,
      );

      const quoted = [
        'const assuranceRank = {',
        "  'best_effort': 0,",
        "  'claim_validated': 1,",
        "  'idp_verified': 2,",
        '};',
      ].join('\n');
      expect(findAll(quoted).some((v) => v.rule === 'duplicate-assurance-tier-enumeration')).toBe(
        true,
      );
    });

    it('fires on Map rank tables, including sequential .set calls', () => {
      const map = [
        'const assuranceRank = new Map([',
        "  ['best_effort', 0],",
        "  ['claim_validated', 1],",
        "  ['idp_verified', 2],",
        ']);',
      ].join('\n');
      expect(findAll(map).some((v) => v.rule === 'duplicate-assurance-tier-enumeration')).toBe(
        true,
      );

      const chain = [
        'const ranks = new Map();',
        "ranks.set('best_effort', 0).set('claim_validated', 1).set('idp_verified', 2);",
      ].join('\n');
      expect(findAll(chain).some((v) => v.rule === 'duplicate-assurance-tier-enumeration')).toBe(
        true,
      );

      const sequential = [
        'const ranks = new Map();',
        "ranks.set('best_effort', 0);",
        "ranks.set('claim_validated', 1);",
        "ranks.set('idp_verified', 2);",
      ].join('\n');
      expect(
        findAll(sequential).some((v) => v.rule === 'duplicate-assurance-tier-enumeration'),
      ).toBe(true);
    });

    it('fires on a switch over all three tiers regardless of case-body length', () => {
      const longSwitch = [
        'switch (tier) {',
        "  case 'best_effort': {",
        '    const a = compute();',
        '    log(a);',
        '    audit(a);',
        '    break;',
        '  }',
        '  // several lines of real logic between the cases',
        '  const intermediate = prepare();',
        '  consume(intermediate);',
        "  case 'claim_validated': {",
        '    const b = compute();',
        '    log(b);',
        '    audit(b);',
        '    break;',
        '  }',
        '  // more real logic',
        '  const other = prepare();',
        '  consume(other);',
        "  case 'idp_verified': {",
        '    const c = compute();',
        '    log(c);',
        '    audit(c);',
        '    break;',
        '  }',
        '}',
      ].join('\n');
      expect(
        findAll(longSwitch).some((v) => v.rule === 'duplicate-assurance-tier-enumeration'),
      ).toBe(true);
    });

    it('fires on an if/else cascade over all three tiers', () => {
      const cascade = [
        "if (tier === 'best_effort') return 0;",
        "if (tier === 'claim_validated') return 1;",
        "if (tier === 'idp_verified') return 2;",
      ].join('\n');
      expect(findAll(cascade).some((v) => v.rule === 'duplicate-assurance-tier-enumeration')).toBe(
        true,
      );
    });

    it('does NOT fire on distributed single-tier assignments or tier mentions in messages', () => {
      // A resolution function assigns one tier per branch across the file, and
      // recovery messages mention a tier name inside prose — neither is a
      // second enumeration authority.
      const distributed = [
        "const fallback = 'idp_verified';",
        ...Array.from({ length: 14 }, () => ''),
        "const claim = 'claim_validated';",
        ...Array.from({ length: 14 }, () => ''),
        "const best = 'best_effort';",
        "const message = 'A verified actor with assurance=claim_validated is required';",
        'const single = { best_effort: 0 } as const;',
      ].join('\n');
      expect(findAll(distributed)).toEqual([]);
    });

    it('does NOT fire in the authority itself (path exemption)', () => {
      const authorityUnion = [
        'export const ACTOR_ASSURANCE_TIERS = [',
        "  'best_effort',",
        "  'claim_validated',",
        "  'idp_verified',",
        '] as const;',
        "export type ActorAssurance = 'best_effort' | 'claim_validated' | 'idp_verified';",
      ].join('\n');
      expect(scanFiles([{ rel: AUTHORITY, content: authorityUnion }])).toEqual([]);
      // The same content elsewhere is a violation.
      expect(
        scanFiles([{ rel: 'config/rogue.ts', content: authorityUnion }]).length,
      ).toBeGreaterThan(0);
    });
  });
});

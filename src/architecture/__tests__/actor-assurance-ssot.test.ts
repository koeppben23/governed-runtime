/**
 * @module architecture/actor-assurance-ssot
 * @description Default-deny guard for the actor-assurance vocabulary authority.
 *
 * Exactly one module owns the tier vocabulary, the derived union, the closed Zod
 * schema, and the ordinal order: `shared/actor-assurance.ts`. The tuple IS the
 * ordering (index-based), so vocabulary, schema, and ordinal cannot diverge.
 *
 * Invariants:
 *   A1 The tier vocabulary is defined exactly once. Named definitions
 *      (`ACTOR_ASSURANCE_TIERS`, `type ActorAssurance`) and array literals that
 *      contain all three tiers exist only in the authority. This also catches a
 *      second, differently-named tier tuple.
 *   A2 No production module defines the full three-tier union as a type union.
 *      The detector is content-wide (multiline-capable); order does not matter
 *      and a trailing `| null` does not hide it. Legitimate subsets (for
 *      example the two-tier approval minimum) are not flagged.
 *   A3 No production module defines a literal `z.enum([...])` of the tiers.
 *      The identifier form `z.enum(ACTOR_ASSURANCE_TIERS)` is the only
 *      admissible spelling outside the authority and is not flagged.
 *   A4 No production module defines a parallel ordinal structure or otherwise
 *      re-enumerates all three tiers in one construct (`ASSURANCE_ORDINAL`, a
 *      local `assuranceOrdinal`, `Record<ActorAssurance, number>`, object/Map
 *      rank tables, switch cases, if/else cascades). Enumeration detection uses
 *      exact quoted tier literals and bare `tier:` keys within a bounded source
 *      window, so recovery messages that merely mention a tier name and
 *      single-tier assignments do not flag. The schema vocabulary and ordinal
 *      order are additionally asserted against the single tuple at runtime.
 *   A5 The scan is default-wide over production source via
 *      `production-source.ts` (`isTestSourcePath`) with no directory allowlist.
 *   A6 Negative fixtures prove every detector, including multiline unions,
 *      permuted unions, `| null` suffixes, comment non-flagging, subset
 *      non-flagging, and the identifier-form enum.
 *
 * Comments are inert: the detectors run on a comment-stripped code view so a
 * documented tier list cannot trip the union/literal detectors.
 *
 * @version v1
 */

import { join } from 'node:path';

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

const TIER_ALTERNATION = TIERS.join('|');

interface Violation {
  readonly rel: string;
  readonly line: number;
  readonly snippet: string;
  readonly rule: string;
}

type Detector = (view: string, rel: string) => Violation[];

/**
 * Comment-stripped code view. Lines whose trimmed start is a comment marker
 * (`*`, `//`, `/*`) are blanked while line numbers stay aligned, so multiline
 * unions and enums in code are still detected across newlines.
 */
function codeView(content: string): string {
  return content
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart();
      return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')
        ? ''
        : line;
    })
    .join('\n');
}

function lineAt(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

function collectMatches(view: string, pattern: RegExp, rel: string, rule: string): Violation[] {
  const out: Violation[] = [];
  for (const match of view.matchAll(pattern)) {
    out.push({
      rel,
      line: lineAt(view, match.index ?? 0),
      snippet: match[0].replace(/\s+/g, ' ').trim(),
      rule,
    });
  }
  return out;
}

function tierNamesIn(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(new RegExp(`\\b(${TIER_ALTERNATION})\\b`, 'g'))) {
    found.add(match[1]!);
  }
  return found;
}

function containsAllTiers(text: string): boolean {
  const found = tierNamesIn(text);
  return TIERS.every((tier) => found.has(tier));
}

/** A1: named vocabulary definitions outside the authority. */
function findDuplicateVocabulary(view: string, rel: string): Violation[] {
  return [
    ...collectMatches(
      view,
      /\b(?:export\s+)?const\s+ACTOR_ASSURANCE_TIERS\b/g,
      rel,
      'duplicate-assurance-vocabulary',
    ),
    // A type alias DEFINITION requires `=`; an inline type import (`type X`)
    // inside named braces is not a definition.
    ...collectMatches(
      view,
      /\b(?:export\s+)?type\s+ActorAssurance\s*=/g,
      rel,
      'duplicate-assurance-vocabulary',
    ),
    ...collectMatches(
      view,
      /\b(?:export\s+)?interface\s+ActorAssurance\b/g,
      rel,
      'duplicate-assurance-vocabulary',
    ),
  ];
}

/** A1: array literals that re-declare the full tier set under any name. */
function findDuplicateLiteralSets(view: string, rel: string): Violation[] {
  const out: Violation[] = [];
  for (const match of view.matchAll(/\[([^[\]]*)\]/g)) {
    if (!containsAllTiers(match[1] ?? '')) continue;
    out.push({
      rel,
      line: lineAt(view, match.index ?? 0),
      snippet: match[0].replace(/\s+/g, ' ').trim(),
      rule: 'duplicate-assurance-literal-set',
    });
  }
  return out;
}

/** A2: full three-tier unions, multiline-capable, order-independent. */
function findDuplicateUnions(view: string, rel: string): Violation[] {
  const tierLiteral = `['"](?:${TIER_ALTERNATION})['"]`;
  const pattern = new RegExp(`(?:${tierLiteral}\\s*\\|\\s*)+${tierLiteral}`, 'g');
  const out: Violation[] = [];
  for (const match of view.matchAll(pattern)) {
    if (!containsAllTiers(match[0])) continue;
    out.push({
      rel,
      line: lineAt(view, match.index ?? 0),
      snippet: match[0].replace(/\s+/g, ' ').trim(),
      rule: 'duplicate-assurance-union',
    });
  }
  return out;
}

/** A3: literal z.enum([...]) tier lists, multiline-capable, order-independent. */
function findDuplicateZodEnums(view: string, rel: string): Violation[] {
  const out: Violation[] = [];
  for (const match of view.matchAll(/z\.enum\s*\(\s*\[([^\]]*)\]/g)) {
    const body = match[1] ?? '';
    const found = new Set([...body.matchAll(/['"]([^'"]+)['"]/g)].map((entry) => entry[1]!));
    if (!TIERS.every((tier) => found.has(tier))) continue;
    out.push({
      rel,
      line: lineAt(view, match.index ?? 0),
      snippet: match[0].replace(/\s+/g, ' ').trim(),
      rule: 'duplicate-assurance-zod-enum',
    });
  }
  return out;
}

/** A4: parallel ordinal structures outside the authority. */
function findDuplicateOrdinals(view: string, rel: string): Violation[] {
  return [
    ...collectMatches(view, /\bASSURANCE_ORDINAL\b/g, rel, 'duplicate-assurance-ordinal'),
    ...collectMatches(
      view,
      /\b(?:function|const)\s+assuranceOrdinal\b/g,
      rel,
      'duplicate-assurance-ordinal',
    ),
    ...collectMatches(
      view,
      /\bRecord<\s*ActorAssurance\s*,\s*number\s*>/g,
      rel,
      'duplicate-assurance-ordinal',
    ),
  ];
}

/**
 * A4: any construct outside the authority that enumerates all three tiers
 * within one bounded source window — object/Map rank tables, switch cases,
 * if/else cascades, or array tuples. Tokens are exact quoted tier literals or
 * bare `tier:` keys, so a recovery message that merely contains a tier word and
 * a distributed single-tier assignment are not counted.
 */
const MAX_TIER_ENUMERATION_SPAN_LINES = 12;

function exactTierTokens(view: string): Array<{ line: number; tier: string }> {
  const tokens: Array<{ line: number; tier: string }> = [];
  view.split('\n').forEach((text, index) => {
    const literals = new RegExp(`(['"])(${TIER_ALTERNATION})\\1`, 'g');
    for (const match of text.matchAll(literals)) {
      tokens.push({ line: index + 1, tier: match[2]! });
    }
    const bareKeys = new RegExp(`\\b(${TIER_ALTERNATION})\\s*:`, 'g');
    for (const match of text.matchAll(bareKeys)) {
      tokens.push({ line: index + 1, tier: match[1]! });
    }
  });
  return tokens.sort((left, right) => left.line - right.line);
}

function findTierEnumerations(view: string, rel: string): Violation[] {
  const tokens = exactTierTokens(view);
  for (let start = 0; start < tokens.length; start++) {
    const first = tokens[start]!;
    const seen = new Set<string>();
    for (let end = start; end < tokens.length; end++) {
      const token = tokens[end]!;
      if (token.line - first.line >= MAX_TIER_ENUMERATION_SPAN_LINES) break;
      seen.add(token.tier);
      if (TIERS.every((tier) => seen.has(tier))) {
        return [
          {
            rel,
            line: first.line,
            snippet: `enumerates ${TIERS.join(' + ')} within ${MAX_TIER_ENUMERATION_SPAN_LINES} source lines`,
            rule: 'duplicate-assurance-tier-enumeration',
          },
        ];
      }
    }
  }
  return [];
}

const DETECTORS: readonly Detector[] = [
  findDuplicateVocabulary,
  findDuplicateLiteralSets,
  findDuplicateUnions,
  findDuplicateZodEnums,
  findDuplicateOrdinals,
  findTierEnumerations,
];

function detect(content: string, rel: string, detector: Detector): Violation[] {
  return detector(codeView(content), rel);
}

/** Path-exempt scan: the authority may define the vocabulary; every other file may not. */
function scanFiles(files: readonly ProductionSourceFile[]): Violation[] {
  const out: Violation[] = [];
  for (const file of files) {
    if (file.rel === AUTHORITY) continue;
    for (const detector of DETECTORS) {
      out.push(...detect(file.content, file.rel, detector));
    }
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
    const rogue = (content: string): ProductionSourceFile[] => [
      { rel: 'config/rogue.ts', content },
    ];

    const findAll = (content: string, rel = 'config/rogue.ts'): Violation[] =>
      DETECTORS.flatMap((detector) => detect(content, rel, detector));

    it('fires on a multiline type union outside the authority', () => {
      const fixture = rogue(
        ['type Rogue =', "  | 'best_effort'", "  | 'claim_validated'", "  | 'idp_verified';"].join(
          '\n',
        ),
      );
      const violations = findAll(fixture[0]!.content);
      expect(violations.map((violation) => violation.rule)).toContain('duplicate-assurance-union');
    });

    it('fires on a permuted union and on a union with a | null suffix', () => {
      expect(
        findAll("type A = 'idp_verified' | 'best_effort' | 'claim_validated';").some(
          (violation) => violation.rule === 'duplicate-assurance-union',
        ),
      ).toBe(true);
      expect(
        findAll("minimum: 'best_effort' | 'claim_validated' | 'idp_verified' | null;").some(
          (violation) => violation.rule === 'duplicate-assurance-union',
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

    it('does NOT fire on a comment documenting the union', () => {
      const fixture = rogue(
        [
          '/**',
          " * 'best_effort' | 'claim_validated' | 'idp_verified'",
          ' */',
          'export const x = 1;',
        ].join('\n'),
      );
      expect(findAll(fixture[0]!.content)).toEqual([]);
    });

    it('fires on a re-declared named vocabulary and on a re-declared type alias', () => {
      const vocabulary = findAll("export const ACTOR_ASSURANCE_TIERS = ['best_effort'] as const;");
      expect(vocabulary.some((v) => v.rule === 'duplicate-assurance-vocabulary')).toBe(true);
      const alias = findAll("export type ActorAssurance = 'best_effort';");
      expect(alias.some((v) => v.rule === 'duplicate-assurance-vocabulary')).toBe(true);
    });

    it('fires on a differently-named full tier array literal', () => {
      const violations = findAll(
        "const tiers = ['best_effort', 'claim_validated', 'idp_verified'];",
      );
      expect(violations.some((v) => v.rule === 'duplicate-assurance-literal-set')).toBe(true);
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

    it('fires on a Map rank table', () => {
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

      const sequential = [
        'const assuranceRank = new Map();',
        "assuranceRank.set('best_effort', 0);",
        "assuranceRank.set('claim_validated', 1);",
        "assuranceRank.set('idp_verified', 2);",
      ].join('\n');
      expect(
        findAll(sequential).some((v) => v.rule === 'duplicate-assurance-tier-enumeration'),
      ).toBe(true);
    });

    it('fires on a switch or if/else cascade over all three tiers', () => {
      const switchFixture = [
        'switch (tier) {',
        "  case 'best_effort':",
        '    return 0;',
        "  case 'claim_validated':",
        '    return 1;',
        "  case 'idp_verified':",
        '    return 2;',
        '}',
      ].join('\n');
      expect(
        findAll(switchFixture).some((v) => v.rule === 'duplicate-assurance-tier-enumeration'),
      ).toBe(true);

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

/**
 * @module architecture/review-obligation-open-primitive-ssot
 * @description Default-deny guard for the review-obligation open-work primitive.
 *
 * `state/review-dispatch.ts` owns the single semantic definition of an OPEN
 * review obligation: `pending` (awaiting dispatch) or `fulfilled` (evidence
 * bound, awaiting verdict/consumption). Terminal states — `consumed` and the
 * deterministically blocked `blocked` — are never open work. A blocked
 * obligation stays visible as a failed historical outcome, but it must never
 * block open-work gates (mutating host-tool gates, reduced-ceremony
 * eligibility).
 *
 * The original defect was caused by eight local reconstructions of this
 * predicate. Local reconstruction is therefore forbidden:
 *
 *   A1 `isOpenReviewObligation` is declared exactly once, in the authority.
 *   A2 `status !== 'consumed'` open checks may not be re-implemented outside
 *      the authority (D1).
 *   A3 Local open sets combining `'pending'` and `'fulfilled'` may not be
 *      re-implemented outside the authority (D2).
 *   A4 The removed selector names must never reappear in production source.
 *   A5 Detectors are proven by negative fixtures so a broken walk cannot make
 *      the guard pass silently.
 *
 * Legitimate status queries for settlement, continuation, history, and schema
 * coherence are NOT forbidden: the detectors only match the open-work idioms.
 *
 * @version v1
 */

import { join } from 'node:path';

import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { collectProductionSources } from '../support/production-source.js';

const SRC_ROOT = join(process.cwd(), 'src');

/** The sole authority allowed to define the open-review-obligation semantic. */
const AUTHORITY = 'state/review-dispatch.ts';
const PRIMITIVE = 'isOpenReviewObligation';

/** Removed local selectors that must not be reintroduced. */
const REMOVED_SELECTORS = [
  'findLatestUnconsumedObligation',
  'findUnconsumedPlanObligation',
  'findPendingImplObligation',
] as const;

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

function isDotStatus(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'status' &&
    !ts.isPropertyAccessExpression(node.name)
  );
}

/** D1: `x.status !== 'consumed'` (either operand order). */
function hasConsumedOpenCheck(content: string): boolean {
  const source = ts.createSourceFile('guard.ts', content, ts.ScriptTarget.Latest, true);
  let found = false;
  walk(source, (node) => {
    if (found || !ts.isBinaryExpression(node)) return;
    const op = node.operatorToken.kind;
    if (
      op !== ts.SyntaxKind.ExclamationEqualsToken &&
      op !== ts.SyntaxKind.ExclamationEqualsEqualsToken
    ) {
      return;
    }
    const left = node.left;
    const right = node.right;
    const consumedLiteral = (n: ts.Node): boolean => ts.isStringLiteral(n) && n.text === 'consumed';
    if (
      (isDotStatus(left) && consumedLiteral(right)) ||
      (isDotStatus(right) && consumedLiteral(left))
    ) {
      found = true;
    }
  });
  return found;
}

/** D2: a `.status` expression combining both `'pending'` and `'fulfilled'`. */
function hasLocalOpenSet(content: string): boolean {
  const source = ts.createSourceFile('guard.ts', content, ts.ScriptTarget.Latest, true);
  let found = false;
  walk(source, (node) => {
    if (found || !ts.isBinaryExpression(node)) return;
    const literals = new Set<string>();
    let referencesStatus = false;
    walk(node, (child) => {
      if (ts.isStringLiteral(child)) literals.add(child.text);
      if (isDotStatus(child)) referencesStatus = true;
    });
    if (referencesStatus && literals.has('pending') && literals.has('fulfilled')) found = true;
  });
  return found;
}

function detectLocalOpenReconstruction(content: string): boolean {
  return hasConsumedOpenCheck(content) || hasLocalOpenSet(content);
}

/** All identifier references (not property names). */
function identifierReferences(content: string): string[] {
  const source = ts.createSourceFile('guard.ts', content, ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  walk(source, (node) => {
    if (ts.isIdentifier(node)) names.push(node.text);
  });
  return names;
}

/** Function/const declarations of a named symbol. */
function declarationsOf(content: string, name: string): number {
  const source = ts.createSourceFile('guard.ts', content, ts.ScriptTarget.Latest, true);
  let count = 0;
  walk(source, (node) => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      count += 1;
    }
  });
  return count;
}

describe('review-obligation open primitive SSOT', () => {
  const files = collectProductionSources(SRC_ROOT);

  it('A1 — isOpenReviewObligation is declared exactly once, in the authority', () => {
    const declarations = files.filter((file) => declarationsOf(file.content, PRIMITIVE) > 0);
    expect(declarations.map((file) => file.rel)).toEqual([AUTHORITY]);
    expect(
      declarationsOf(files.find((file) => file.rel === AUTHORITY)?.content ?? '', PRIMITIVE),
    ).toBe(1);
  });

  it('A2/A3 — no local open-work reconstruction outside the authority', () => {
    const offenders = files
      .filter((file) => file.rel !== AUTHORITY)
      .filter((file) => detectLocalOpenReconstruction(file.content))
      .map((file) => file.rel)
      .sort();
    expect(offenders).toEqual([]);
  });

  it('A4 — the removed local selectors never reappear in production source', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const names = new Set(identifierReferences(file.content));
      for (const removed of REMOVED_SELECTORS) {
        if (names.has(removed)) offenders.push(`${file.rel}:${removed}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('A5 — negative fixtures prove both detectors fire', () => {
    expect(detectLocalOpenReconstruction("const open = (o) => o.status !== 'consumed';")).toBe(
      true,
    );
    expect(
      detectLocalOpenReconstruction(
        "const open = (o) => o.status === 'pending' || o.status === 'fulfilled';",
      ),
    ).toBe(true);
    expect(
      detectLocalOpenReconstruction(
        "const done = (o) => o.status === 'fulfilled' || o.status === 'consumed';",
      ),
    ).toBe(false);
    expect(detectLocalOpenReconstruction("type S = 'pending' | 'fulfilled';")).toBe(false);
    expect(
      detectLocalOpenReconstruction(
        "const ok = (o) => o.status === 'pending' && o.consumedAt == null;",
      ),
    ).toBe(false);
  });
});

/**
 * @module state/risk-declaration
 * @description Canonical ticket risk declaration: deterministic parsing,
 * digest integrity and the single effective task-class resolution.
 *
 * A ticket may bind a minimum risk class by declaring it explicitly in its
 * canonical content (`Risk:` / `Risikoklasse:` / `Risk Class:` followed by
 * TRIVIAL, STANDARD or HIGH-RISK). The declaration is parsed once at ticket
 * capture and persisted next to the ticket text it was derived from; every
 * consumer re-verifies that the stored declaration still equals the parser
 * result over the ticket text and that the ticket digest hashes that text.
 *
 * The effective class is the conservative maximum of:
 * - the runtime-computed minimum over the known file set (provisional before
 *   `/implement`, final over the complete actual changed files after it),
 * - the ticket-declared floor (declared class, or the highest class of a
 *   conflict between valid declarations),
 * - an optional escalation claim (`claimedTaskClass`, raise-only).
 *
 * Nothing can lower a declared minimum, and missing declarations or claims
 * never block: the runtime-computed minimum governs.
 *
 * @version v1
 */

import { z } from 'zod';

import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { hashText } from '../shared/hashing.js';
import { TaskClass, TASK_CLASS_ORDER, maxTaskClass } from './task-class.js';

/**
 * Parsed ticket risk declaration, bound to the ticket text it was derived from
 * via `TicketEvidence.digest`.
 */
export const TicketRiskDeclaration = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('absent') }).strict(),
    z.object({ kind: z.literal('declared'), taskClass: TaskClass }).strict(),
    z.object({ kind: z.literal('conflict'), values: z.array(TaskClass).min(2) }).strict(),
    z.object({ kind: z.literal('invalid'), raw: z.string().min(1) }).strict(),
  ])
  .readonly();
export type TicketRiskDeclaration = z.infer<typeof TicketRiskDeclaration>;

/**
 * Declaration line grammar: an optional bullet/heading, optional Markdown
 * emphasis around the key, then `Risk` / `Risk Class` / `Risikoklasse`
 * followed by `:` or `=`, then the value and optional trailing rationale.
 * The value is captured even when empty so an explicit but valueless
 * declaration is reported as invalid instead of silently disappearing.
 */
const DECLARATION_LINE =
  /^\s*(?:[-*+]\s+|#{1,6}\s+)?(?:\*\*|__)?\s*(?:risk(?:\s*class)?|risikoklasse)\s*(?:\*\*|__)?\s*[:=][ \t]*(.*)$/i;

/**
 * CommonMark fences: an opening fence may be indented by at most three spaces
 * and carry an info string; a closing fence is the delimiter plus whitespace
 * only (an info string never closes a fence).
 */
const OPEN_FENCE = /^ {0,3}(`{3,}|~{3,})/;
const CLOSE_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** Placeholder reported for an explicit declaration without a value. */
const EMPTY_DECLARATION_RAW = '(no value)';

function parseDeclarationValue(raw: string): TaskClass | null {
  const cleaned = raw.replace(/[*_`]/g, ' ').trim().toUpperCase();
  // Longest forms first so `HIGH RISK` is not shadowed by a leading token. The
  // class token must end at a word boundary: `STANDARDIZED` is not STANDARD.
  if (/^HIGH[\s-]RISK(?![\w-])/.test(cleaned)) return 'HIGH-RISK';
  if (/^TRIVIAL(?![\w-])/.test(cleaned)) return 'TRIVIAL';
  if (/^STANDARD(?![\w-])/.test(cleaned)) return 'STANDARD';
  return null;
}

/**
 * Deterministic parse of the canonical ticket text. Only lines whose key
 * starts the line count (prose that merely mentions a risk class does not).
 * Fenced code blocks and quoted blockquote lines are examples, not binding
 * declarations. An explicit declaration without a value and any other
 * unparseable explicit declaration make the whole declaration invalid — a
 * malformed `Risk:` must not silently degrade to "no declaration".
 */
interface DeclarationLineScan {
  readonly fence: string | null;
  readonly skip: boolean;
}

function isClosingFence(line: string, fence: string): boolean {
  const match = CLOSE_FENCE.exec(line);
  const token = match === null ? undefined : match[1];
  return token !== undefined && token[0] === fence[0] && token.length >= fence.length;
}

/** Fence/quote state machine step for one line. */
function scanDeclarationLine(line: string, fence: string | null): DeclarationLineScan {
  if (fence !== null) {
    // Only a bare closing fence ends the block; an info-string lookalike
    // (````js`) is content and cannot close it.
    return { fence: isClosingFence(line, fence) ? null : fence, skip: true };
  }
  const match = OPEN_FENCE.exec(line);
  const token = match === null ? undefined : match[1];
  if (token !== undefined) return { fence: token, skip: true };
  if (/^\s*>/.test(line)) return { fence: null, skip: true };
  // CommonMark indented code block (four spaces or a tab) is an example, not
  // a binding declaration.
  if (/^(?: {4,}|\t)/.test(line)) return { fence: null, skip: true };
  return { fence: null, skip: false };
}

function collectDeclarationLines(text: string): {
  readonly values: TaskClass[];
  readonly invalidRaw: string[];
} {
  const values: TaskClass[] = [];
  const invalidRaw: string[] = [];
  let fence: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const scan = scanDeclarationLine(line, fence);
    fence = scan.fence;
    if (scan.skip) continue;
    const match = DECLARATION_LINE.exec(line);
    if (match === null) continue;
    const raw = (match[1] ?? '').trim();
    const parsed = parseDeclarationValue(raw);
    if (parsed === null) invalidRaw.push(raw === '' ? EMPTY_DECLARATION_RAW : raw);
    else values.push(parsed);
  }
  return { values, invalidRaw };
}

export function parseTicketRiskDeclaration(text: string): TicketRiskDeclaration {
  const { values, invalidRaw } = collectDeclarationLines(text);
  if (invalidRaw.length > 0) {
    return { kind: 'invalid', raw: invalidRaw.join('; ') };
  }
  if (values.length === 0) {
    return { kind: 'absent' };
  }
  const unique = [...new Set(values)].sort((a, b) => TASK_CLASS_ORDER[b] - TASK_CLASS_ORDER[a]);
  const [soleDeclared] = unique;
  if (unique.length === 1 && soleDeclared !== undefined) {
    return { kind: 'declared', taskClass: soleDeclared };
  }
  return { kind: 'conflict', values: unique };
}

/**
 * Conservative floor contributed by the declaration: the declared class, the
 * highest valid class of a conflict, or no floor for absent/invalid.
 */
export function ticketRiskDeclarationFloor(declaration: TicketRiskDeclaration): TaskClass | null {
  switch (declaration.kind) {
    case 'declared':
      return declaration.taskClass;
    case 'conflict':
      return declaration.values.reduce((max, value) => maxTaskClass(max, value));
    case 'absent':
    case 'invalid':
      return null;
  }
}

/**
 * Single effective task-class resolution. `computed` is the runtime minimum
 * over the known file set; `declaration` and `escalated` can only raise it.
 */
export function resolveEffectiveTaskClass(input: {
  readonly computed: TaskClass;
  readonly declaration: TicketRiskDeclaration;
  readonly escalated?: TaskClass | undefined;
}): TaskClass {
  let effective = input.computed;
  const declaredFloor = ticketRiskDeclarationFloor(input.declaration);
  if (declaredFloor !== null) effective = maxTaskClass(effective, declaredFloor);
  if (input.escalated !== undefined) effective = maxTaskClass(effective, input.escalated);
  return effective;
}

/**
 * Integrity of the persisted declaration: the digest must hash the stored
 * text AND the stored declaration must equal the parser result over that
 * text. The digest alone does not prove the declaration matches the text.
 */
export function verifyTicketRiskDeclarationIntegrity(ticket: {
  readonly text: string;
  readonly digest: string;
  readonly riskDeclaration: TicketRiskDeclaration;
}): boolean {
  if (ticket.digest !== hashText(ticket.text)) return false;
  return (
    canonicalJsonStringify(parseTicketRiskDeclaration(ticket.text)) ===
    canonicalJsonStringify(ticket.riskDeclaration)
  );
}

/**
 * @module integration/review/review-navigation-index
 * @description Deterministic, advisory navigation projection over the frozen
 *              reviewer material.
 *
 * This builder is a pure function over three immutable inputs:
 *   1. the digest-verified `reviewMaterial` of an obligation,
 *   2. the obligation's frozen subject scope and control-plane target paths,
 *   3. the attempt-bound Discovery snapshot.
 *
 * It never reads mutable session state, never calls a tool, never binds
 * evidence, and never persists anything. Its output is navigation only: the
 * raw frozen material remains the authoritative review subject.
 *
 * @version v1
 */

import type {
  RepositoryDiscoverySnapshot,
  ReviewMaterial,
  ReviewSubjectScope,
} from '../../../state/evidence.js';
import type { VerificationCandidate } from '../../../state/discovery-schemas.js';
import { hashCanonicalReviewContent } from '../../../shared/review-subject.js';
import { NO_TICKET_MATERIAL_TEXT, REVIEW_MATERIAL_SECTIONS } from './reviewer-context.js';

export const REVIEW_NAVIGATION_VERSION = 'review-navigation.v1';

/** Section headings whose syntactic list items are navigable requirements. */
export const NAVIGATION_REQUIREMENT_HEADINGS: ReadonlySet<string> = new Set([
  'acceptance criteria',
  'required change',
  'required changes',
  'requirements',
  'constraints',
  'do not change',
  'out of scope',
  'verification',
  'testing',
]);

const MAX_REQUIREMENTS = 24;
const MAX_REQUIREMENT_CHARS = 400;
const MAX_REQUIREMENT_TOTAL_CHARS = 6000;
const MAX_FILE_HINTS = 24;
const MAX_FILE_HINT_CHARS = 220;

export type NavigationUnavailableReason =
  | 'unsupported_scope'
  | 'material_digest_mismatch'
  | 'subject_digest_mismatch'
  | 'ticket_section_missing'
  | 'ticket_section_malformed'
  | 'plan_section_missing'
  | 'implementation_metadata_missing'
  | 'implementation_metadata_malformed'
  | 'implementation_digest_mismatch';

export type FileHintOrigin =
  'frozen_subject_scope' | 'explicit_ticket_reference' | 'explicit_plan_reference' | 'changed_file';

export interface NavigationRequirement {
  readonly sourceKind: 'ticket';
  readonly sourceSection: string;
  readonly sourceSpan: { readonly start: number; readonly end: number };
  readonly exactText: string;
}

export interface NavigationFileHint {
  readonly path: string;
  readonly origin: FileHintOrigin;
}

export interface NavigationVerificationEntry {
  readonly checkId: string;
  readonly candidateId?: string;
  readonly command?: string;
  readonly status: 'candidate_only' | 'recorded_result_present';
  /** Present only when the recorded result is bound to the reviewed implementation digest. */
  readonly recordedSubjectBound?: true;
}

export interface ReviewNavigationIndexV1 {
  readonly version: typeof REVIEW_NAVIGATION_VERSION;
  readonly source: {
    readonly obligationId: string;
    readonly subjectDigest: string;
    readonly materialDigest: string;
    readonly spanEncoding: 'utf16_code_units';
  };
  readonly requirements: readonly NavigationRequirement[];
  readonly fileHints: readonly NavigationFileHint[];
  readonly verification: readonly NavigationVerificationEntry[];
  readonly coverage: {
    readonly truncated: boolean;
    readonly omittedEntries: number;
    readonly notes: readonly string[];
  };
}

export type ReviewNavigationIndexResult =
  | { readonly kind: 'ok'; readonly index: ReviewNavigationIndexV1 }
  | {
      readonly kind: 'unavailable';
      readonly reason: NavigationUnavailableReason;
    };

export interface ReviewNavigationIndexInput {
  readonly obligationId: string;
  readonly subjectDigest: string;
  readonly reviewMaterial: ReviewMaterial;
  readonly reviewSubjectScope: ReviewSubjectScope | undefined;
  /** Immutable plan target paths from the obligation control-plane metadata. */
  readonly targetPaths?: readonly string[] | undefined;
  /** Attempt-bound Discovery snapshot; candidates only, never executions. */
  readonly discoverySnapshot?: RepositoryDiscoverySnapshot | null | undefined;
}

// ─── Material sections ───────────────────────────────────────────────────────

interface MaterialLine {
  readonly text: string;
  readonly start: number;
}

function materialLines(content: string): MaterialLine[] {
  const lines: MaterialLine[] = [];
  let start = 0;
  for (const text of content.split('\n')) {
    lines.push({ text, start });
    start += text.length + 1;
  }
  return lines;
}

function sectionBody(content: string, heading: string): string | null {
  const lines = materialLines(content);
  const marker = `## ${heading}`;
  const start = lines.findIndex((line) => line.text === marker);
  if (start === -1) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s/.test(lines[index]?.text ?? '')) {
      end = index;
      break;
    }
  }
  const body = lines.slice(start + 1, end).map((line) => line.text);
  while (body[0] === '') body.shift();
  while (body[body.length - 1] === '') body.pop();
  return body.join('\n');
}

function parseJsonSection(
  content: string,
  heading: string,
): { readonly kind: 'ok'; readonly value: unknown } | { readonly kind: 'missing' | 'malformed' } {
  const body = sectionBody(content, heading);
  if (body === null) return { kind: 'missing' };
  try {
    return { kind: 'ok', value: JSON.parse(body) as unknown };
  } catch {
    return { kind: 'malformed' };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ─── Requirement extraction ──────────────────────────────────────────────────

interface RequirementCandidate {
  readonly sourceSection: string;
  readonly start: number;
  readonly end: number;
}

function normalizedHeading(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Syntactic heading match only: the exact allowlisted phrase, or the phrase
 * followed by a parenthetical/colon qualifier (e.g. "Required Changes (both
 * mandatory)"). No heading is interpreted semantically.
 */
function isRequirementHeading(text: string): boolean {
  const normalized = normalizedHeading(text);
  for (const heading of NAVIGATION_REQUIREMENT_HEADINGS) {
    if (
      normalized === heading ||
      normalized.startsWith(`${heading} (`) ||
      normalized.startsWith(`${heading}:`)
    ) {
      return true;
    }
  }
  return false;
}

function isFence(line: string): boolean {
  return /^(```|~~~)/.test(line.trimStart());
}

function isListStart(line: string): boolean {
  return /^\s{0,3}(?:[-*+]|\d+[.)])\s+/.test(line);
}

function isChecklist(line: string): boolean {
  return /^\s{0,3}(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s+/.test(line);
}

function updateHeadingStack(stack: string[], line: string): boolean {
  const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
  if (heading === null) return false;
  const level = heading[1]?.length ?? 1;
  stack.length = Math.min(stack.length, level - 1);
  stack[level - 1] = heading[2] ?? '';
  return true;
}

function selectedRequirementLine(stack: readonly string[], line: string): boolean {
  return stack.some((item) => isRequirementHeading(item)) || isChecklist(line);
}

function listIndent(line: string): number {
  return /^\s*/.exec(line)?.[0].length ?? 0;
}

function listItemEnd(lines: readonly MaterialLine[], index: number): number {
  let end = index;
  for (let next = index + 1; next < lines.length; next += 1) {
    const candidate = lines[next];
    if (candidate === undefined) break;
    if (candidate.text.trim() === '') break;
    if (isFence(candidate.text)) break;
    if (/^(#{1,6})\s+/.test(candidate.text)) break;
    if (isListStart(candidate.text)) break;
    end = next;
  }
  return end;
}

function requirementCandidateAt(
  lines: readonly MaterialLine[],
  index: number,
  headingStack: readonly string[],
): (RequirementCandidate & { readonly endLine: number }) | null {
  const line = lines[index];
  if (line === undefined) return null;
  if (!isListStart(line.text) || !selectedRequirementLine(headingStack, line.text)) return null;
  if (listIndent(line.text) > 3) return null;
  const endLine = listItemEnd(lines, index);
  const start = line.start + listIndent(line.text);
  const end = (lines[endLine]?.start ?? line.start) + (lines[endLine]?.text.length ?? 0);
  return {
    sourceSection: headingStack.filter((item) => item.length > 0).join(' / ') || 'checklist',
    start,
    end,
    endLine,
  };
}

/**
 * Extract syntactically unambiguous list/checklist items under allowlisted
 * ticket headings. Multi-line items are captured through their continuation
 * lines. No item is synthesized, summarized, or mapped to another artifact.
 */
function extractRequirements(text: string): readonly RequirementCandidate[] {
  const lines = materialLines(text);
  const requirements: RequirementCandidate[] = [];
  const headingStack: string[] = [];
  let fence: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) break;
    if (fence !== null) {
      if (line.text.trimStart().startsWith(fence)) fence = null;
      continue;
    }
    if (isFence(line.text)) {
      fence = line.text.trimStart().slice(0, 3);
      continue;
    }
    if (updateHeadingStack(headingStack, line.text)) continue;
    const requirement = requirementCandidateAt(lines, index, headingStack);
    if (requirement === null) continue;
    requirements.push(requirement);
    index = requirement.endLine;
  }
  return requirements;
}

// ─── File hints ──────────────────────────────────────────────────────────────

const FILE_EXTENSION = /\.(?:[a-z0-9]{1,12})$/i;

function isSafeRepositoryPath(token: string): boolean {
  const value = token.trim();
  if (value.length === 0 || value.length > MAX_FILE_HINT_CHARS) return false;
  if (/\s/.test(value)) return false;
  if (value.includes('://')) return false;
  if (value.startsWith('/') || value.startsWith('./') || value.includes('..')) return false;
  if (value.includes('\0')) return false;
  return value.includes('/') || FILE_EXTENSION.test(value);
}

function backtickedPaths(text: string): readonly string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(/`([^`\n]{1,220})`/g)) {
    const token = match[1]?.trim() ?? '';
    if (isSafeRepositoryPath(token)) paths.push(token);
  }
  return paths;
}

function addFileHints(
  target: Map<string, NavigationFileHint>,
  paths: readonly string[],
  origin: FileHintOrigin,
): void {
  for (const path of paths) {
    if (!isSafeRepositoryPath(path)) continue;
    target.set(`${path}\u0000${origin}`, { path, origin });
  }
}

// ─── Verification projection ─────────────────────────────────────────────────

function candidateEntries(
  candidates: readonly VerificationCandidate[],
  recorded: readonly { readonly kind?: unknown; readonly command?: unknown }[] | null,
): readonly NavigationVerificationEntry[] {
  return candidates.map((candidate) => {
    const base = {
      checkId: candidate.kind,
      candidateId: candidate.candidateId,
      command: candidate.command,
    };
    if (recorded === null) {
      return { ...base, status: 'candidate_only' as const };
    }
    const match = recorded.some(
      (item) => item.kind === candidate.kind && item.command === candidate.command,
    );
    return match
      ? { ...base, status: 'recorded_result_present' as const, recordedSubjectBound: true as const }
      : { ...base, status: 'candidate_only' as const };
  });
}

function recordedVerificationItems(
  content: string,
): readonly { readonly kind?: unknown; readonly command?: unknown }[] | null {
  const parsed = parseJsonSection(content, REVIEW_MATERIAL_SECTIONS.verificationEvidence);
  if (parsed.kind !== 'ok' || !Array.isArray(parsed.value)) return null;
  return parsed.value.filter(isRecord);
}

// ─── Builder ─────────────────────────────────────────────────────────────────

function unavailable(reason: NavigationUnavailableReason): ReviewNavigationIndexResult {
  return { kind: 'unavailable', reason };
}

function parseTicket(
  content: string,
  notes: Set<string>,
):
  | { readonly kind: 'ok'; readonly text: string | null }
  | { readonly kind: 'unavailable'; readonly reason: NavigationUnavailableReason } {
  const section = parseJsonSection(content, REVIEW_MATERIAL_SECTIONS.ticket);
  if (section.kind !== 'ok') {
    return {
      kind: 'unavailable',
      reason: section.kind === 'missing' ? 'ticket_section_missing' : 'ticket_section_malformed',
    };
  }
  if (section.value === NO_TICKET_MATERIAL_TEXT) {
    notes.add('no_ticket');
    return { kind: 'ok', text: null };
  }
  if (
    !isRecord(section.value) ||
    typeof section.value.text !== 'string' ||
    typeof section.value.digest !== 'string'
  ) {
    return { kind: 'unavailable', reason: 'ticket_section_malformed' };
  }
  return { kind: 'ok', text: section.value.text };
}

function parseImplementationPlan(
  content: string,
  implementationDigest: string,
  subjectDigest: string,
  notes: Set<string>,
): { readonly planBody: string | null; readonly failure?: NavigationUnavailableReason } {
  const metadata = parseJsonSection(content, REVIEW_MATERIAL_SECTIONS.implementationMetadata);
  if (metadata.kind !== 'ok') {
    return {
      planBody: null,
      failure:
        metadata.kind === 'missing'
          ? 'implementation_metadata_missing'
          : 'implementation_metadata_malformed',
    };
  }
  const digest = isRecord(metadata.value) ? metadata.value.digest : undefined;
  if (typeof digest !== 'string' || digest !== implementationDigest) {
    return { planBody: null, failure: 'implementation_digest_mismatch' };
  }
  if (digest !== subjectDigest) return { planBody: null, failure: 'subject_digest_mismatch' };
  const approved = parseJsonSection(content, REVIEW_MATERIAL_SECTIONS.approvedPlan);
  if (approved.kind !== 'ok' || approved.value === null) {
    notes.add('approved_plan_unavailable');
    return { planBody: null };
  }
  if (isRecord(approved.value) && typeof approved.value.body === 'string') {
    return { planBody: approved.value.body };
  }
  notes.add('approved_plan_unavailable');
  return { planBody: null };
}

function buildRequirements(
  ticketText: string | null,
  omitted: { count: number },
  notes: Set<string>,
): readonly NavigationRequirement[] {
  if (ticketText === null) return [];
  const requirements: NavigationRequirement[] = [];
  let totalChars = 0;
  for (const candidate of extractRequirements(ticketText)) {
    const exactText = ticketText.slice(candidate.start, candidate.end);
    if (exactText.length === 0) continue;
    if (
      exactText.length > MAX_REQUIREMENT_CHARS ||
      requirements.length >= MAX_REQUIREMENTS ||
      totalChars + exactText.length > MAX_REQUIREMENT_TOTAL_CHARS
    ) {
      omitted.count += 1;
      continue;
    }
    totalChars += exactText.length;
    requirements.push({
      sourceKind: 'ticket',
      sourceSection: candidate.sourceSection,
      sourceSpan: { start: candidate.start, end: candidate.end },
      exactText,
    });
  }
  if (requirements.length === 0) notes.add('no_requirement_sections');
  return requirements;
}

function buildFileHints(context: {
  readonly input: ReviewNavigationIndexInput;
  readonly isImplementation: boolean;
  readonly ticketText: string | null;
  readonly planBody: string | null;
  readonly omitted: { count: number };
  readonly notes: Set<string>;
}): readonly NavigationFileHint[] {
  const { input, isImplementation, ticketText, planBody, omitted, notes } = context;
  const hints = new Map<string, NavigationFileHint>();
  if (ticketText !== null) {
    addFileHints(hints, backtickedPaths(ticketText), 'explicit_ticket_reference');
  }
  if (planBody !== null) {
    addFileHints(hints, backtickedPaths(planBody), 'explicit_plan_reference');
  }
  addFileHints(hints, input.targetPaths ?? [], 'explicit_plan_reference');
  if (isImplementation) {
    const changed = parseJsonSection(
      input.reviewMaterial.content,
      REVIEW_MATERIAL_SECTIONS.changedFiles,
    );
    if (changed.kind === 'ok' && Array.isArray(changed.value)) {
      addFileHints(
        hints,
        changed.value.filter((item): item is string => typeof item === 'string'),
        'changed_file',
      );
    } else {
      notes.add('changed_files_unavailable');
    }
  }
  const all = [...hints.values()].sort(
    (left, right) => left.path.localeCompare(right.path) || left.origin.localeCompare(right.origin),
  );
  const bounded = all.slice(0, MAX_FILE_HINTS);
  omitted.count += all.length - bounded.length;
  return bounded;
}

function buildVerification(
  input: ReviewNavigationIndexInput,
  isImplementation: boolean,
  notes: Set<string>,
): readonly NavigationVerificationEntry[] {
  const candidates = input.discoverySnapshot?.verificationCandidates ?? [];
  if (candidates.length === 0) notes.add('verification_snapshot_unavailable');
  if (!isImplementation) return candidateEntries(candidates, []);
  const recorded = recordedVerificationItems(input.reviewMaterial.content);
  if (recorded === null) {
    notes.add('verification_evidence_unavailable');
    return [];
  }
  return candidateEntries(candidates, recorded);
}

function resolvePlanBody(
  input: ReviewNavigationIndexInput,
  scope: ReviewSubjectScope,
  isPlan: boolean,
  notes: Set<string>,
):
  | { readonly kind: 'ok'; readonly planBody: string | null }
  | { readonly kind: 'unavailable'; readonly reason: NavigationUnavailableReason } {
  if (isPlan) {
    const planBody = sectionBody(
      input.reviewMaterial.content,
      REVIEW_MATERIAL_SECTIONS.planArtifact,
    );
    return planBody === null
      ? { kind: 'unavailable', reason: 'plan_section_missing' }
      : { kind: 'ok', planBody };
  }
  if (scope.kind !== 'implementation') return { kind: 'unavailable', reason: 'unsupported_scope' };
  const parsed = parseImplementationPlan(
    input.reviewMaterial.content,
    scope.implementationDigest,
    input.subjectDigest,
    notes,
  );
  return parsed.failure !== undefined
    ? { kind: 'unavailable', reason: parsed.failure }
    : { kind: 'ok', planBody: parsed.planBody };
}

export function buildReviewNavigationIndex(
  input: ReviewNavigationIndexInput,
): ReviewNavigationIndexResult {
  const material = input.reviewMaterial;
  if (hashCanonicalReviewContent(material.content) !== material.materialDigest) {
    return unavailable('material_digest_mismatch');
  }
  if (material.subjectDigest !== input.subjectDigest) {
    return unavailable('subject_digest_mismatch');
  }
  const scope = input.reviewSubjectScope;
  const isPlan = scope?.kind === 'artifact' && scope.artifact.kind === 'plan';
  const isImplementation = scope?.kind === 'implementation';
  if (!isPlan && !isImplementation) return unavailable('unsupported_scope');

  const notes = new Set<string>();
  const omitted = { count: 0 };
  const ticket = parseTicket(material.content, notes);
  if (ticket.kind === 'unavailable') return unavailable(ticket.reason);

  const planResult = resolvePlanBody(input, scope, isPlan, notes);
  if (planResult.kind === 'unavailable') return unavailable(planResult.reason);
  const planBody = planResult.planBody;

  const requirements = buildRequirements(ticket.text, omitted, notes);
  const fileHints = buildFileHints({
    input,
    isImplementation,
    ticketText: ticket.text,
    planBody,
    omitted,
    notes,
  });
  const verification = buildVerification(input, isImplementation, notes);

  return {
    kind: 'ok',
    index: {
      version: REVIEW_NAVIGATION_VERSION,
      source: {
        obligationId: input.obligationId,
        subjectDigest: input.subjectDigest,
        materialDigest: material.materialDigest,
        spanEncoding: 'utf16_code_units',
      },
      requirements,
      fileHints,
      verification,
      coverage: {
        truncated: omitted.count > 0,
        omittedEntries: omitted.count,
        notes: [...notes].sort(),
      },
    },
  };
}

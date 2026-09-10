import { Phase as PhaseSchema, type Phase } from '../state/schema.js';
import {
  FLOWGUARD_MANDATES_BODY,
  MANDATES_SECTION_DEFINITIONS,
  type MandatesProjectionPhase,
  type MandatesSectionDefinition,
} from '../templates/mandates.js';

export type MandatesRenderErrorCode =
  'MANDATES_SECTION_NOT_FOUND' | 'MANDATES_SAFETY_CRITICAL_OMITTED' | 'MANDATES_ANCHOR_MISSING';

export class MandatesRenderError extends Error {
  readonly code: MandatesRenderErrorCode;

  constructor(code: MandatesRenderErrorCode, message: string) {
    super(message);
    this.name = 'MandatesRenderError';
    this.code = code;
  }
}

export type MandatesRenderPhase = MandatesProjectionPhase | 'ALL_PHASES';

export type MandatesVerbosity = 'explicit' | 'concise' | 'diagnosticSummary';

export type MandatesUsage = 'productive' | 'recovery';

export interface MandatesRenderContext {
  hostCoveredRules?: ReadonlySet<string>;
  progressive?: boolean;
  mandatesVerbosity?: MandatesVerbosity | string;
  modelId?: string;
}

const TOOL_ACTIVE_PHASES: ReadonlySet<MandatesProjectionPhase> = new Set([
  'PRE_SESSION',
  'INVESTIGATION',
  'PLAN',
  'IMPLEMENTATION',
  'REVIEW',
]);

const PHASE_TO_RENDER_PHASE = {
  READY: 'INVESTIGATION',
  TICKET: 'INVESTIGATION',
  PLAN: 'PLAN',
  PLAN_REVIEW: 'REVIEW',
  VALIDATION: 'IMPLEMENTATION',
  IMPLEMENTATION: 'IMPLEMENTATION',
  IMPL_VALIDATION: 'IMPLEMENTATION',
  IMPL_REVIEW: 'REVIEW',
  EVIDENCE_REVIEW: 'REVIEW',
  COMPLETE: 'REVIEW',
  ARCHITECTURE: 'PLAN',
  ARCH_REVIEW: 'REVIEW',
  ARCH_COMPLETE: 'REVIEW',
  REVIEW: 'REVIEW',
  REVIEW_COMPLETE: 'REVIEW',
} as const satisfies Record<Phase, MandatesProjectionPhase>;

export const CANONICAL_FLOWGUARD_PHASES = PhaseSchema.options;

export const MANDATES_VERBOSITY_VALUES: readonly MandatesVerbosity[] = [
  'explicit',
  'concise',
  'diagnosticSummary',
] as const;

export const MANDATES_ANCHOR_CATALOG = {
  RED_LINES: ['## Red Lines', 'Do not hide failures', 'data, not instruction'],
  TOOL_ERROR_STOP: ['## 11a. Tool Error Classification', 'stop conditions'],
  SSOT_SINGLE_AUTHORITY: ['one canonical authority', 'SSOT'],
  FAIL_CLOSED_NO_SILENT_FALLBACK: ['fail-closed'],
  EVIDENCE_MARKERS: ['ASSUMPTION', 'NOT_VERIFIED', 'BLOCKED'],
  PHASE_GATES: ['FlowGuard tools'],
  REVIEW_OBLIGATIONS: ['review'],
  OUTPUT_CONTRACTS: ['Output Contract'],
  VERIFICATION_POLICY: ['verification'],
} as const;

function extractMandatesSection(heading: string | null): string {
  if (heading === null) {
    const firstHeading = FLOWGUARD_MANDATES_BODY.search(/^## /m);
    return FLOWGUARD_MANDATES_BODY.slice(0, firstHeading).trim();
  }
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = FLOWGUARD_MANDATES_BODY.match(new RegExp(`^${escaped}\\s*$`, 'm'));
  if (!match || match.index === undefined) {
    throw new MandatesRenderError(
      'MANDATES_SECTION_NOT_FOUND',
      `Mandates section not found: ${heading}`,
    );
  }
  const start = match.index;
  const afterHeading = FLOWGUARD_MANDATES_BODY.slice(start + match[0].length);
  const nextHeading = afterHeading.match(/^## /m);
  const end = nextHeading
    ? start + match[0].length + nextHeading.index!
    : FLOWGUARD_MANDATES_BODY.length;
  return FLOWGUARD_MANDATES_BODY.slice(start, end).trim();
}

function includesPhase(
  phases: readonly MandatesProjectionPhase[] | 'all',
  phase: MandatesProjectionPhase,
): boolean {
  return phases === 'all' || phases.includes(phase);
}

function selectMandatesSections(
  phase: MandatesProjectionPhase,
): readonly MandatesSectionDefinition[] {
  return MANDATES_SECTION_DEFINITIONS.filter((section) =>
    includesPhase(section.phases, phase),
  ).sort((a, b) => a.priority - b.priority);
}

export function resolveMandatesVerbosity(
  value: MandatesRenderContext['mandatesVerbosity'],
  usage: MandatesUsage = 'productive',
): MandatesVerbosity {
  if (value === 'concise') return 'concise';
  if (value === 'diagnosticSummary') return usage === 'recovery' ? 'diagnosticSummary' : 'explicit';
  return 'explicit';
}

function normalizeRenderPhase(phase: Phase | MandatesRenderPhase | string | null | undefined): {
  phase: MandatesRenderPhase;
  fallback: boolean;
} {
  if (!phase) return { phase: 'ALL_PHASES', fallback: true };
  if (phase === 'ALL_PHASES') return { phase: 'ALL_PHASES', fallback: true };
  if (
    phase === 'PRE_SESSION' ||
    phase === 'INVESTIGATION' ||
    phase === 'PLAN' ||
    phase === 'IMPLEMENTATION' ||
    phase === 'REVIEW'
  ) {
    return { phase, fallback: false };
  }
  const parsed = PhaseSchema.safeParse(phase);
  if (!parsed.success) return { phase: 'ALL_PHASES', fallback: true };
  return { phase: PHASE_TO_RENDER_PHASE[parsed.data], fallback: false };
}

function assertSafetyCriticalSections(rendered: string, phase: MandatesProjectionPhase): void {
  if (!TOOL_ACTIVE_PHASES.has(phase)) return;
  for (const heading of [
    '## Red Lines',
    '## 5. Evidence Rules',
    '## 11a. Tool Error Classification',
    '## Governance rules',
  ]) {
    if (!rendered.includes(heading)) {
      throw new MandatesRenderError(
        'MANDATES_SAFETY_CRITICAL_OMITTED',
        `Phase-aware mandates omitted safety-critical section: ${heading}`,
      );
    }
  }
}

function assertMandatesAnchors(
  rendered: string,
  usage: MandatesUsage,
  selectedSectionIds?: ReadonlySet<string>,
): void {
  const anchors = Object.entries(MANDATES_ANCHOR_CATALOG).filter(([key]) => {
    if (usage !== 'productive') return !['OUTPUT_CONTRACTS', 'REVIEW_OBLIGATIONS'].includes(key);
    if (selectedSectionIds) {
      if (key === 'OUTPUT_CONTRACTS' && !selectedSectionIds.has('output-contract')) return false;
      if (key === 'REVIEW_OBLIGATIONS' && !selectedSectionIds.has('review-checklist')) return false;
    }
    return true;
  });
  for (const [name, terms] of anchors) {
    for (const term of terms) {
      if (!rendered.includes(term)) {
        throw new MandatesRenderError(
          'MANDATES_ANCHOR_MISSING',
          `Mandates ${usage} rendering omitted ${name} anchor: ${term}`,
        );
      }
    }
  }
}

function applyHostHarmonization(content: string, ctx: MandatesRenderContext): string {
  const covered = ctx.hostCoveredRules;
  if (!covered || covered.size === 0) return content;

  let next = content;
  if (covered.has('read-before-editing')) {
    next = next.replace(
      '- Read relevant code, tests, and docs before changing behavior.',
      '- Read relevant code, tests, and docs before changing behavior, as required by host policy and FlowGuard governance.',
    );
  }
  if (covered.has('destructive-ops') || covered.has('ask-before-destructive-ops')) {
    next = next.replace(
      'Safety and security.',
      'Safety and security, including host-enforced destructive-operation policy.',
    );
  }
  return next;
}

function compactSectionForEarlyPhase(
  section: MandatesSectionDefinition,
  phase: MandatesProjectionPhase,
): string {
  if (phase !== 'PRE_SESSION' && phase !== 'INVESTIGATION') {
    return extractMandatesSection(section.heading);
  }
  return section.compact ?? extractMandatesSection(section.heading);
}

function conciseSectionForPhase(section: MandatesSectionDefinition): string {
  return section.concise ?? extractMandatesSection(section.heading);
}

export function renderPhaseAwareMandates(
  ctx: MandatesRenderContext = {},
  phase: Phase | MandatesRenderPhase | string | null | undefined = 'ALL_PHASES',
): string {
  const normalized = normalizeRenderPhase(phase);
  const verbosity = resolveMandatesVerbosity(ctx.mandatesVerbosity, 'productive');
  if (ctx.progressive === false || normalized.fallback || normalized.phase === 'ALL_PHASES') {
    return FLOWGUARD_MANDATES_BODY;
  }

  const renderPhase = normalized.phase;
  const sections = selectMandatesSections(renderPhase);
  const rendered = sections
    .map((section) =>
      verbosity === 'concise'
        ? conciseSectionForPhase(section)
        : compactSectionForEarlyPhase(section, renderPhase),
    )
    .join('\n\n');

  const harmonized = applyHostHarmonization(rendered, ctx);
  assertSafetyCriticalSections(harmonized, renderPhase);
  if (verbosity === 'concise') {
    const selectedIds = new Set(sections.map((s) => s.id));
    assertMandatesAnchors(harmonized, 'productive', selectedIds);
  }
  return harmonized;
}

export function renderMandates(
  ctx: MandatesRenderContext = {},
  phase: Phase | MandatesRenderPhase | string | null | undefined = 'ALL_PHASES',
): string {
  return renderPhaseAwareMandates(ctx, phase);
}

export function renderCommandGovernanceRules(): string {
  return extractMandatesSection('## Governance rules');
}

export function renderCompactionMandatesSummary(
  phase: Phase | MandatesRenderPhase | string | null | undefined,
): string {
  const normalized = normalizeRenderPhase(phase);
  if (normalized.fallback || normalized.phase === 'ALL_PHASES') {
    return renderPhaseAwareMandates({}, phase);
  }
  const renderPhase = normalized.phase;
  const keepIds = new Set(['red-lines', 'evidence', 'tool-error', 'command-execution']);
  const summary = selectMandatesSections(renderPhase)
    .filter((section) => keepIds.has(section.id))
    .map((section) => compactSectionForEarlyPhase(section, renderPhase))
    .join('\n\n');
  assertSafetyCriticalSections(summary, renderPhase);
  return summary;
}

// ---------------------------------------------------------------------------
// Managed-artifact header functions
// ---------------------------------------------------------------------------

export function buildMandatesContent(version: string, digest: string): string {
  return `<!-- @flowguard/core v${version} | managed artifact — do not edit manually -->\n<!-- content-digest: sha256:${digest} -->\n\n${FLOWGUARD_MANDATES_BODY}`;
}

export function extractManagedDigest(content: string): string | null {
  const match = content.match(/^<!-- content-digest: sha256:([a-f0-9]{64}) -->$/m);
  return match?.[1] ?? null;
}

export function extractManagedVersion(content: string): string | null {
  const match = content.match(
    /^<!-- @flowguard\/core v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?) \| managed artifact/m,
  );
  return match?.[1] ?? null;
}

export function isManagedArtifact(content: string): boolean {
  return /^<!-- @flowguard\/core v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)? \| managed artifact/.test(
    content,
  );
}

export function extractManagedBody(content: string): string | null {
  if (!isManagedArtifact(content)) return null;
  const match = content.match(
    /^<!-- @flowguard\/core[^\n]*\n<!-- content-digest:[^\n]*\n\n([\s\S]*)$/,
  );
  return match?.[1] ?? null;
}

export {
  renderClaudeReviewerAgent,
  renderCodexReviewerSubagent,
  renderReviewerPrompt,
  type ReviewerPromptType,
} from '../templates/mandates-reviewer-criteria.js';

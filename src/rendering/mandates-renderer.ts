import { createHash } from 'node:crypto';
import { Phase as PhaseSchema, type Phase } from '../state/schema.js';
import {
  FLOWGUARD_MANDATES_FULL_BODY,
  FLOWGUARD_MANDATES_KERNEL,
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
  /** Host coverage is transport metadata only; it must never rewrite canonical mandate semantics. */
  hostCoveredRules?: ReadonlySet<string>;
  progressive?: boolean;
  mandatesVerbosity?: MandatesVerbosity | string;
  modelId?: string;
}

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
  TOOL_ERROR_STOP: [
    '## 11a. Tool Error Classification',
    'Never continue to the next workflow step',
  ],
  SSOT_SINGLE_AUTHORITY: ['one canonical authority', 'SSOT'],
  FAIL_CLOSED_NO_SILENT_FALLBACK: ['fail-closed'],
  EVIDENCE_MARKERS: ['ASSUMPTION', 'NOT_VERIFIED', 'BLOCKED'],
  PHASE_GATES: ['FlowGuard tools'],
  REVIEW_OBLIGATIONS: ['review'],
  OUTPUT_CONTRACTS: ['Output Contract'],
  VERIFICATION_POLICY: ['verification'],
} as const;

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

function selectProjectionSections(
  phase: MandatesProjectionPhase,
  verbosity: MandatesVerbosity,
): readonly MandatesSectionDefinition[] {
  const sections = selectMandatesSections(phase);
  if (verbosity === 'concise') {
    return sections.filter(
      (section) => section.safetyCritical === true || section.concise === true,
    );
  }
  if (phase === 'PRE_SESSION' || phase === 'INVESTIGATION') {
    return sections.filter(
      (section) => section.safetyCritical === true || section.earlyPhase === true,
    );
  }
  return sections;
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

function sectionRenderAnchor(section: MandatesSectionDefinition): string {
  return section.heading ?? '# FlowGuard Agent Rules';
}

function assertSafetyCriticalSections(
  rendered: string,
  selectedSections: readonly MandatesSectionDefinition[],
): void {
  for (const section of selectedSections.filter((candidate) => candidate.safetyCritical === true)) {
    const anchor = sectionRenderAnchor(section);
    if (!rendered.includes(anchor)) {
      throw new MandatesRenderError(
        'MANDATES_SAFETY_CRITICAL_OMITTED',
        `Mandates rendering omitted safety-critical section ${section.id}: ${anchor}`,
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

function renderSections(sections: readonly MandatesSectionDefinition[]): string {
  return sections.map((section) => section.content).join('\n\n');
}

export function renderPhaseAwareMandates(
  ctx: MandatesRenderContext = {},
  phase: Phase | MandatesRenderPhase | string | null | undefined = 'ALL_PHASES',
): string {
  const normalized = normalizeRenderPhase(phase);
  const verbosity = resolveMandatesVerbosity(ctx.mandatesVerbosity, 'productive');
  if (ctx.progressive === false || normalized.fallback || normalized.phase === 'ALL_PHASES') {
    return FLOWGUARD_MANDATES_FULL_BODY;
  }

  const sections = selectProjectionSections(normalized.phase, verbosity);
  const rendered = renderSections(sections);
  assertSafetyCriticalSections(rendered, sections);
  const selectedIds = new Set(sections.map((section) => section.id));
  assertMandatesAnchors(rendered, 'productive', selectedIds);
  return rendered;
}

export function renderMandates(
  ctx: MandatesRenderContext = {},
  phase: Phase | MandatesRenderPhase | string | null | undefined = 'ALL_PHASES',
): string {
  return renderPhaseAwareMandates(ctx, phase);
}

export function renderCommandGovernanceRules(): string {
  const section = MANDATES_SECTION_DEFINITIONS.find(
    (candidate) => candidate.id === 'command-execution',
  );
  if (!section) {
    throw new MandatesRenderError(
      'MANDATES_SECTION_NOT_FOUND',
      'Mandates section not found: command-execution',
    );
  }
  return section.content;
}

export function renderCompactionMandatesSummary(
  phase: Phase | MandatesRenderPhase | string | null | undefined,
): string {
  const normalized = normalizeRenderPhase(phase);
  if (normalized.fallback || normalized.phase === 'ALL_PHASES') {
    return FLOWGUARD_MANDATES_KERNEL;
  }
  const sections = selectMandatesSections(normalized.phase).filter(
    (section) => section.safetyCritical === true,
  );
  const summary = renderSections(sections);
  assertSafetyCriticalSections(summary, sections);
  assertMandatesAnchors(summary, 'recovery', new Set(sections.map((section) => section.id)));
  return summary;
}

// ---------------------------------------------------------------------------
// Managed-artifact envelope functions
// ---------------------------------------------------------------------------

export function buildMandatesContent(version: string, digest: string): string {
  return `<!-- @flowguard/core v${version} | managed artifact — do not edit manually -->\n<!-- content-digest: sha256:${digest} -->\n\n${FLOWGUARD_MANDATES_KERNEL}`;
}

interface ManagedArtifactEnvelope {
  readonly version: string;
  readonly digest: string;
  readonly body: string;
}

function parseManagedArtifactEnvelope(content: string): ManagedArtifactEnvelope | null {
  const match = content.match(
    /^<!-- @flowguard\/core v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?) \| managed artifact — do not edit manually -->\n<!-- content-digest: sha256:([a-f0-9]{64}) -->\n\n([\s\S]*)$/,
  );
  if (!match?.[1] || !match[2] || match[3] === undefined) return null;
  return { version: match[1], digest: match[2], body: match[3] };
}

export function extractManagedDigest(content: string): string | null {
  return parseManagedArtifactEnvelope(content)?.digest ?? null;
}

export function extractManagedVersion(content: string): string | null {
  return parseManagedArtifactEnvelope(content)?.version ?? null;
}

/**
 * Managed ownership requires a complete canonical envelope and a body whose
 * SHA-256 matches the declared digest. A look-alike prefix is never ownership.
 */
export function isManagedArtifact(content: string): boolean {
  const envelope = parseManagedArtifactEnvelope(content);
  if (!envelope) return false;
  const actualDigest = createHash('sha256').update(envelope.body, 'utf-8').digest('hex');
  return actualDigest === envelope.digest;
}

export function extractManagedBody(content: string): string | null {
  const envelope = parseManagedArtifactEnvelope(content);
  if (!envelope || !isManagedArtifact(content)) return null;
  return envelope.body;
}

export {
  renderClaudeReviewerAgent,
  renderCodexReviewerSubagent,
  renderReviewerPrompt,
  type ReviewerPromptType,
} from '../templates/mandates-reviewer-criteria.js';

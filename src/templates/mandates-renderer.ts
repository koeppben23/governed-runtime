import { Phase as PhaseSchema, type Phase } from '../state/schema.js';
import {
  FLOWGUARD_MANDATES_BODY,
  COMPACT_RED_LINES,
  COMPACT_HARD_INVARIANTS,
  COMPACT_EVIDENCE,
  COMPACT_TOOL_ERROR,
  COMPACT_RULE_CONFLICT,
  COMPACT_COMMAND_EXECUTION,
  CONCISE_GROUNDING,
  CONCISE_MISSION,
  CONCISE_RED_LINES,
  CONCISE_PRIORITY,
  CONCISE_LANGUAGE,
  CONCISE_TASK_ROUTER,
  CONCISE_HARD_INVARIANTS,
  CONCISE_EVIDENCE,
  CONCISE_TOOL_VERIFICATION,
  CONCISE_AMBIGUITY,
  CONCISE_OUTPUT_CONTRACT,
  CONCISE_IMPLEMENTATION_CHECKLIST,
  CONCISE_REVIEW_CHECKLIST,
  CONCISE_HIGH_RISK,
  CONCISE_TOOL_ERROR,
  CONCISE_RULE_CONFLICT,
  CONCISE_COMMAND_EXECUTION,
  CONCISE_EXTENDED_GUIDANCE,
  CONCISE_BEFORE_ACTING,
  CONCISE_BEFORE_COMPLETING,
} from './mandates.js';

export type MandatesRenderPhase =
  | 'PRE_SESSION'
  | 'INVESTIGATION'
  | 'PLAN'
  | 'IMPLEMENTATION'
  | 'REVIEW'
  | 'ALL_PHASES';

export type MandatesVerbosity = 'explicit' | 'concise' | 'diagnosticSummary';

export type MandatesUsage = 'productive' | 'recovery';

export interface MandatesRenderContext {
  hostCoveredRules?: ReadonlySet<string>;
  progressive?: boolean;
  mandatesVerbosity?: MandatesVerbosity | string;
  modelId?: string;
}

interface MandatesSectionDefinition {
  id: string;
  heading: string | null;
  phases: ReadonlySet<MandatesRenderPhase> | 'all';
  priority: number;
  safetyCritical?: boolean;
}

const ALL_RENDER_PHASES: ReadonlySet<MandatesRenderPhase> = new Set([
  'PRE_SESSION',
  'INVESTIGATION',
  'PLAN',
  'IMPLEMENTATION',
  'REVIEW',
]);

const TOOL_ACTIVE_PHASES: ReadonlySet<MandatesRenderPhase> = new Set([
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
  IMPL_REVIEW: 'REVIEW',
  EVIDENCE_REVIEW: 'REVIEW',
  COMPLETE: 'REVIEW',
  ARCHITECTURE: 'PLAN',
  ARCH_REVIEW: 'REVIEW',
  ARCH_COMPLETE: 'REVIEW',
  REVIEW: 'REVIEW',
  REVIEW_COMPLETE: 'REVIEW',
} as const satisfies Record<Phase, MandatesRenderPhase>;

export const CANONICAL_FLOWGUARD_PHASES = PhaseSchema.options;

export const MANDATES_VERBOSITY_VALUES: readonly MandatesVerbosity[] = [
  'explicit',
  'concise',
  'diagnosticSummary',
] as const;

export const MANDATES_ANCHOR_CATALOG = {
  RED_LINES: ['## Red Lines', 'Do not hide failures'],
  TOOL_ERROR_STOP: ['## 11a. Tool Error Classification', 'stop conditions'],
  SSOT_SINGLE_AUTHORITY: ['one canonical authority', 'SSOT'],
  FAIL_CLOSED_NO_SILENT_FALLBACK: ['fail-closed'],
  EVIDENCE_MARKERS: ['ASSUMPTION', 'NOT_VERIFIED', 'BLOCKED'],
  PHASE_GATES: ['FlowGuard tools'],
  REVIEW_OBLIGATIONS: ['review'],
  OUTPUT_CONTRACTS: ['Output Contract'],
  VERIFICATION_POLICY: ['verification'],
} as const;

const MANDATES_SECTION_DEFINITIONS: readonly MandatesSectionDefinition[] = [
  { id: 'grounding', heading: null, phases: 'all', priority: 0, safetyCritical: true },
  { id: 'mission', heading: '## 1. Mission', phases: ALL_RENDER_PHASES, priority: 10 },
  {
    id: 'red-lines',
    heading: '## Red Lines',
    phases: TOOL_ACTIVE_PHASES,
    priority: 20,
    safetyCritical: true,
  },
  { id: 'priority', heading: '## 2. Priority Ladder', phases: ALL_RENDER_PHASES, priority: 30 },
  { id: 'language', heading: '## Language Conventions', phases: ALL_RENDER_PHASES, priority: 40 },
  {
    id: 'task-router',
    heading: '## 3. Task Class Router',
    phases: new Set(['PRE_SESSION', 'INVESTIGATION', 'PLAN', 'IMPLEMENTATION', 'REVIEW']),
    priority: 50,
  },
  {
    id: 'hard-invariants',
    heading: '## 4. Hard Invariants',
    phases: ALL_RENDER_PHASES,
    priority: 60,
    safetyCritical: true,
  },
  {
    id: 'evidence',
    heading: '## 5. Evidence Rules',
    phases: TOOL_ACTIVE_PHASES,
    priority: 70,
    safetyCritical: true,
  },
  {
    id: 'tool-verification',
    heading: '## 6. Tool and Verification Policy',
    phases: new Set(['IMPLEMENTATION', 'REVIEW']),
    priority: 80,
    safetyCritical: true,
  },
  {
    id: 'ambiguity',
    heading: '## 7. Ambiguity Policy',
    phases: new Set(['PRE_SESSION', 'INVESTIGATION', 'PLAN', 'IMPLEMENTATION', 'REVIEW']),
    priority: 90,
  },
  {
    id: 'output-contract',
    heading: '## 8. Output Contract',
    phases: new Set(['PLAN', 'IMPLEMENTATION', 'REVIEW']),
    priority: 100,
  },
  {
    id: 'implementation-checklist',
    heading: '## 9. Implementation Checklist',
    phases: new Set(['PLAN', 'IMPLEMENTATION']),
    priority: 110,
  },
  {
    id: 'review-checklist',
    heading: '## 10. Review Checklist',
    phases: new Set(['REVIEW']),
    priority: 120,
  },
  {
    id: 'high-risk',
    heading: '## 11. High-Risk Extension',
    phases: new Set(['PLAN', 'IMPLEMENTATION', 'REVIEW']),
    priority: 130,
  },
  {
    id: 'tool-error',
    heading: '## 11a. Tool Error Classification',
    phases: TOOL_ACTIVE_PHASES,
    priority: 140,
    safetyCritical: true,
  },
  {
    id: 'rule-conflict',
    heading: '## 11b. Rule Conflict Resolution',
    phases: TOOL_ACTIVE_PHASES,
    priority: 150,
    safetyCritical: true,
  },
  {
    id: 'command-execution',
    heading: '## Governance rules',
    phases: TOOL_ACTIVE_PHASES,
    priority: 160,
    safetyCritical: true,
  },
  {
    id: 'extended-guidance',
    heading: '## 12. Extended Guidance',
    phases: ALL_RENDER_PHASES,
    priority: 170,
  },
  {
    id: 'before-acting',
    heading: '## Before Acting Rule',
    phases: ALL_RENDER_PHASES,
    priority: 180,
  },
  {
    id: 'before-completing',
    heading: '## Before Completing Rule',
    phases: new Set(['PLAN', 'IMPLEMENTATION', 'REVIEW']),
    priority: 190,
  },
];

function extractMandatesSection(heading: string | null): string {
  if (heading === null) {
    const firstHeading = FLOWGUARD_MANDATES_BODY.search(/^## /m);
    return FLOWGUARD_MANDATES_BODY.slice(0, firstHeading).trim();
  }
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = FLOWGUARD_MANDATES_BODY.match(new RegExp(`^${escaped}\\s*$`, 'm'));
  if (!match || match.index === undefined) {
    throw new Error(`Mandates section not found: ${heading}`);
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
  phases: ReadonlySet<MandatesRenderPhase> | 'all',
  phase: MandatesRenderPhase,
): boolean {
  return phases === 'all' || phases.has(phase);
}

function selectMandatesSections(phase: MandatesRenderPhase): readonly MandatesSectionDefinition[] {
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

function assertSafetyCriticalSections(rendered: string, phase: MandatesRenderPhase): void {
  if (!TOOL_ACTIVE_PHASES.has(phase)) return;
  for (const heading of [
    '## Red Lines',
    '## 5. Evidence Rules',
    '## 11a. Tool Error Classification',
    '## Governance rules',
  ]) {
    if (!rendered.includes(heading)) {
      throw new Error(`Phase-aware mandates omitted safety-critical section: ${heading}`);
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
        throw new Error(`Mandates ${usage} rendering omitted ${name} anchor: ${term}`);
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
  phase: MandatesRenderPhase,
): string {
  if (phase !== 'PRE_SESSION' && phase !== 'INVESTIGATION') {
    return extractMandatesSection(section.heading);
  }
  switch (section.id) {
    case 'red-lines':
      return COMPACT_RED_LINES;
    case 'hard-invariants':
      return COMPACT_HARD_INVARIANTS;
    case 'evidence':
      return COMPACT_EVIDENCE;
    case 'tool-error':
      return COMPACT_TOOL_ERROR;
    case 'rule-conflict':
      return COMPACT_RULE_CONFLICT;
    case 'command-execution':
      return COMPACT_COMMAND_EXECUTION;
    default:
      return extractMandatesSection(section.heading);
  }
}

function conciseSectionForPhase(section: MandatesSectionDefinition): string {
  switch (section.id) {
    case 'grounding':
      return CONCISE_GROUNDING;
    case 'mission':
      return CONCISE_MISSION;
    case 'red-lines':
      return CONCISE_RED_LINES;
    case 'priority':
      return CONCISE_PRIORITY;
    case 'language':
      return CONCISE_LANGUAGE;
    case 'task-router':
      return CONCISE_TASK_ROUTER;
    case 'hard-invariants':
      return CONCISE_HARD_INVARIANTS;
    case 'evidence':
      return CONCISE_EVIDENCE;
    case 'tool-verification':
      return CONCISE_TOOL_VERIFICATION;
    case 'ambiguity':
      return CONCISE_AMBIGUITY;
    case 'output-contract':
      return CONCISE_OUTPUT_CONTRACT;
    case 'implementation-checklist':
      return CONCISE_IMPLEMENTATION_CHECKLIST;
    case 'review-checklist':
      return CONCISE_REVIEW_CHECKLIST;
    case 'high-risk':
      return CONCISE_HIGH_RISK;
    case 'tool-error':
      return CONCISE_TOOL_ERROR;
    case 'rule-conflict':
      return CONCISE_RULE_CONFLICT;
    case 'command-execution':
      return CONCISE_COMMAND_EXECUTION;
    case 'extended-guidance':
      return CONCISE_EXTENDED_GUIDANCE;
    case 'before-acting':
      return CONCISE_BEFORE_ACTING;
    case 'before-completing':
      return CONCISE_BEFORE_COMPLETING;
    default:
      return extractMandatesSection(section.heading);
  }
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

  const sections = selectMandatesSections(normalized.phase);
  const rendered = sections
    .map((section) =>
      verbosity === 'concise'
        ? conciseSectionForPhase(section)
        : compactSectionForEarlyPhase(section, normalized.phase),
    )
    .join('\n\n');

  const harmonized = applyHostHarmonization(rendered, ctx);
  assertSafetyCriticalSections(harmonized, normalized.phase);
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
  const keepIds = new Set(['red-lines', 'evidence', 'tool-error', 'command-execution']);
  const summary = selectMandatesSections(normalized.phase)
    .filter((section) => keepIds.has(section.id))
    .map((section) => compactSectionForEarlyPhase(section, normalized.phase))
    .join('\n\n');
  assertSafetyCriticalSections(summary, normalized.phase);
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

export { renderReviewerPrompt, type ReviewerPromptType } from './mandates-reviewer-criteria.js';

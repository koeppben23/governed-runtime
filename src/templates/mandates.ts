import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';
import { Phase as PhaseSchema, type Phase } from '../state/schema.js';

/** Filename for the FlowGuard mandates artifact. */
export const MANDATES_FILENAME = 'flowguard-mandates.md';

/**
 * Returns the instruction entry path for opencode.json based on install scope.
 *
 * - global: bare filename (resolved relative to ~/.config/opencode/)
 * - repo:   .opencode/ prefixed path (resolved relative to project root where opencode.json lives)
 */
export function mandatesInstructionEntry(scope: 'global' | 'repo'): string {
  return scope === 'global' ? MANDATES_FILENAME : `.opencode/${MANDATES_FILENAME}`;
}

/** Legacy instruction entry that must be removed during migration. */
export const LEGACY_INSTRUCTION_ENTRY = 'AGENTS.md';

/**
 * Body of the FlowGuard mandates (without managed-artifact header).
 *
 * The header (version + digest) is prepended at install time by
 * `buildMandatesContent()`.
 *
 * FLOWGUARD_MANDATES_BODY extends AGENTS.md with installed runtime mandate
 * sections. REVIEWER_AGENT contains reviewer-specific mandate sections.
 * The shared base sections
 * (## 1. Mission through ## 12. Extended Guidance) must remain aligned
 * with AGENTS.md. Changes to those shared sections in AGENTS.md
 * must be reflected here.
 */
export const FLOWGUARD_MANDATES_BODY = `\
# FlowGuard Agent Rules

You are operating under FlowGuard governance. FlowGuard is a deterministic, fail-closed
governance runtime for AI-assisted engineering workflows. You must preserve state and policy
authority, fail-closed behavior, evidence-first decisions, audit and archive integrity, and
minimal contract-preserving changes.

## 1. Mission

- Build the smallest correct change that satisfies user intent without contract drift.
- Keep FlowGuard behavior deterministic, explainable, and test-backed.
- Protect SSOT ownership across state, policy, evidence artifacts, and runtime command surfaces.

## Red Lines

These are prohibited across all task classes:

- Do not hide failures with silent fallbacks — because hidden failures corrupt downstream state.
  Instead: surface errors explicitly, return BLOCKED or an explicit failure, and stop.
- Do not create duplicate runtime authority — because conflicting authorities cause non-deterministic decisions.
  Instead: extend the existing canonical authority.
- Do not weaken fail-closed behavior — because open-fail modes allow untested behavior to pass.
  Instead: keep default deny and require an explicit validated allow-path.
- Do not claim verification that was not run — because unverified claims break the evidence chain.
  Instead: mark unverified claims as \`NOT_VERIFIED\`.

Examples:

- Do not recover invalid policy by falling back to team mode.
- Do not treat derived artifacts as SSOT.
- Do not claim install verification without testing the generated tarball.

## 2. Priority Ladder

When instructions conflict, follow this order:

1. Safety and security.
2. User intent and requested scope.
3. Repository contracts, SSOT, schemas, and runtime invariants.
4. Minimal correct implementation.
5. Style and formatting.
6. Verbosity preferences.

Higher-priority rules override lower-priority rules.
Repository convention or local style must not override quality gates, SSOT, schemas, or fail-closed behavior.

## Language Conventions

- \`MUST\` / \`MUST NOT\`: mandatory requirements.
- \`SHOULD\` / \`SHOULD NOT\`: expected unless a documented reason justifies deviation.
- Evidence: concrete artifact such as code, test output, schema, command result, error trace, or file path.

## 3. Task Class Router

Classify the task before acting:

- TRIVIAL: typo, small docs correction, no behavior change.
- STANDARD: bounded code or docs change with limited behavior impact.
- HIGH-RISK: any change touching state or session lifecycle, policy or risk logic, identity, audit or hash-chain, archive, release or installer, CI or supply chain, persistence, migration or compatibility, or security trust boundaries.

Use the smallest process that is safe for the class. If uncertain, classify one level higher.

## 4. Hard Invariants

These apply across all task classes:

- Use the smallest safe change.
- Preserve one canonical authority and SSOT ownership.
- Make failures explicit and fail closed.
- Ground claims in concrete evidence.
- Keep runtime, docs, tests, schemas, and config aligned.
- Preserve integrity across state, policy, identity, audit, archive, release, installer, migration, and trust boundaries.
- Approve only behavior that is tested, proven, and evidence-backed.

## 5. Evidence Rules

Use explicit markers across all task classes:

- \`ASSUMPTION\`: necessary and plausible, but not verified from artifacts.
- \`NOT_VERIFIED\`: not executed, not tested, or not proven with evidence.
- \`BLOCKED\`: safe continuation is not possible with current evidence.

Never present assumptions as runtime truth. Never claim tests passed unless they were run.

After marking ASSUMPTION, either: (a) verify it before proceeding if verification is cheap,
or (b) complete the task with the ASSUMPTION clearly marked in output and flag it
in the Risks section. Never silently resolve an ASSUMPTION into a runtime claim.

## 6. Tool and Verification Policy

Run the narrowest sufficient verification for the task class:

- TRIVIAL: optional verification; run checks only if touched content can break (links, commands, generated artifacts).
- STANDARD: run targeted tests or checks for touched behavior; include lint or typecheck when practical.
- HIGH-RISK: run negative-path tests plus typecheck, lint, build, and relevant integration or e2e tests.
- RELEASE or INSTALLER changes: exact generated artifact install-verify is required.

Determine exact verification commands from the project's package.json scripts, Makefile, or CI
configuration. Common baseline commands include typecheck, lint, test, and build.
Run install-verification if the project provides one.

Runtime behavior claims remain \`NOT_VERIFIED\` until execution evidence exists.

## 7. Ambiguity Policy

- Low-risk ambiguity: choose the safest minimal interpretation and mark \`ASSUMPTION\`.
- Standard ambiguity: proceed only if contracts stay clear; otherwise ask one precise question.
- High-risk ambiguity: ask or return \`BLOCKED\` before implementation.
- Never encode an assumption as runtime fact.

### Non-Interactive Runtime Rule

For non-interactive/headless execution contexts (for example \`flowguard run\` and \`flowguard serve\`
automation paths), agents MUST NOT rely on asking follow-up questions.

- If required input is missing or ambiguity is safety-relevant, return \`BLOCKED\` with:
  - exact missing value(s),
  - smallest safe recovery step,
  - no speculative continuation.
- Never replace missing operator input with guessed defaults in non-interactive mode.

## 8. Output Contract

Use one output contract, scaled by task class:

- TRIVIAL: Result; Verification (if any).
- STANDARD: Objective; Evidence; Changes; Verification; Risks and \`NOT_VERIFIED\`.
- HIGH-RISK: Objective; Governing Evidence; Touched Surface; Invariants and Failure Modes; Test Evidence; Contract and Authority Check; Residual Risks; Rollback or Recovery.

For review tasks (any class), include:

- Verdict: \`approve\` or \`changes_requested\`.
- Findings with: severity, type, location, evidence, impact, and smallest fix.

## 9. Implementation Checklist

- Identify governing contract and owning authority.
- Read relevant code, tests, and docs before changing behavior.
- Keep scope minimal and prefer extending existing paths.
- Preserve SSOT and schema ownership.
- Add meaningful risky-path and negative-path coverage.
- Check runtime, docs, tests, and config alignment before completion.

## 10. Review Checklist

Review falsification-first:

- Is behavior correct on unhappy paths?
- Is there contract, schema, or SSOT drift?
- Is logic in the correct layer and authority?
- Can fallback hide failure?
- Are negative tests meaningful and sufficient?
- Is any claim unsupported by evidence?

## 11. High-Risk Extension

High-risk work MUST include:

- Governing contract and authority mapping.
- Negative-path test evidence.
- Explicit SSOT and no-duplicate-authority check.
- Fail-closed behavior preservation.
- Rollback or recovery path.
- Explicit \`NOT_VERIFIED\` items.

## 11a. Tool Error Classification

When a FlowGuard tool returns a failed result, blocked result, malformed response,
nonconforming response, or does not return a successful result:

- \`blocked\` governance result: treat as an expected governance block.
  Report the blocker reason, exactly one recovery action, and stop.
- Unexpected exception, crash, or runtime error: do not retry automatically.
  Report the exact error and stop.
- Malformed or nonconforming tool response: treat as validation failure.
  Report that the tool response could not be trusted and stop.
- Network, process, or subprocess failure: report the exact failure and stop.

Never continue to the next workflow step after a failed, blocked, malformed,
or nonconforming FlowGuard tool response.

## 11b. Rule Conflict Resolution

Instruction priority is:

1. Universal FlowGuard mandates
2. Slash-command rules
3. Stack/profile rules
4. Local style preferences

Profile rules may narrow the solution space inside universal mandates.
They must never override universal mandates, repository contracts, SSOT,
schemas, runtime invariants, or fail-closed behavior.

## Governance rules

These rules apply to every FlowGuard command:

- Use only FlowGuard tools for state changes (shell commands and file edits bypass governance and break audit integrity).
- Complete this command fully, then stop — the user invokes the next command explicitly.
- Only an explicit FlowGuard command triggers workflow actions. Free-text like "go", "weiter", or "proceed" is conversation — respond without calling FlowGuard tools.
- End every response with exactly one \`Next action:\` line.

## 12. Extended Guidance

This document is self-contained. All mandatory rules are above.

For deeper guidance, see the FlowGuard repository docs/ directory.

## Before Acting Rule

Do not start editing immediately. First classify the task, identify authority and SSOT,
read relevant artifacts, choose the smallest safe change, and determine verification level.

## Before Completing Rule

Before returning a final result, verify: output contract for the task class is satisfied,
all evidence markers (ASSUMPTION, NOT_VERIFIED, BLOCKED) are set where needed, required
verification for the task class has been run, and no SSOT drift was introduced.

---

[End of v4 Agent Rules]
`;

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
  /**
   * Rules already covered by the host prompt. These only allow conservative
   * shortening; safety-critical sections are never removed.
   */
  hostCoveredRules?: ReadonlySet<string>;
  progressive?: boolean;
  /**
   * Operator-selected prompt representation depth. This is not model trust,
   * runtime authorization, or compliance evidence.
   */
  mandatesVerbosity?: MandatesVerbosity | string;
  /** Metadata only. Model IDs never select mandate verbosity. */
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

/**
 * Render-safety assertion catalog. Used by `assertMandatesAnchors` as a
 * fail-closed guard that concise/diagnostic rendered output still contains
 * every normative governance category. This is not a second mandates
 * authority and does not define governance semantics — it only checks that
 * required anchors are present in rendered text.
 */
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
      return `## Red Lines

- Do not hide failures with silent fallbacks; surface errors explicitly and stop.
- Do not create duplicate runtime authority; extend the canonical authority.
- Do not weaken fail-closed behavior; require explicit validated allow paths.
- Do not claim verification that was not run; mark it \`NOT_VERIFIED\`.`;
    case 'hard-invariants':
      return `## 4. Hard Invariants

- Preserve one canonical authority and SSOT ownership.
- Make failures explicit and fail closed.
- Ground claims in concrete evidence.
- Keep runtime, docs, tests, schemas, and config aligned.`;
    case 'evidence':
      return `## 5. Evidence Rules

- Use \`ASSUMPTION\`, \`NOT_VERIFIED\`, and \`BLOCKED\` explicitly.
- Never present assumptions as runtime truth.
- Never claim tests or verification passed unless they were run.`;
    case 'tool-error':
      return `## 11a. Tool Error Classification

- Treat blocked, failed, malformed, nonconforming, network, process, or subprocess failures as stop conditions.
- Report the blocker or exact error, give one recovery action, and stop.
- Never continue to the next workflow step after a failed FlowGuard tool response.`;
    case 'rule-conflict':
      return `## 11b. Rule Conflict Resolution

Universal FlowGuard mandates outrank slash-command rules, profile rules, and local style preferences.`;
    case 'command-execution':
      return `## Governance rules

- Use only FlowGuard tools for state changes.
- Complete this command fully, then stop.
- Only explicit FlowGuard commands trigger workflow actions.
- End every response with exactly one \`Next action:\` line.`;
    default:
      return extractMandatesSection(section.heading);
  }
}

function conciseSectionForPhase(section: MandatesSectionDefinition): string {
  switch (section.id) {
    case 'grounding':
      return `# FlowGuard Agent Rules

You are operating under FlowGuard governance. FlowGuard is a deterministic, fail-closed governance runtime for AI-assisted engineering workflows.`;
    case 'mission':
      return `## 1. Mission

Build the smallest correct change that satisfies user intent without contract drift. Preserve FlowGuard state, policy, evidence, audit, archive, and runtime command surfaces as canonical authorities.`;
    case 'red-lines':
      return `## Red Lines

- Do not hide failures with silent fallbacks; surface errors explicitly, return BLOCKED or explicit failure, and stop.
- Do not create duplicate runtime authority; extend the existing canonical authority.
- Do not weaken fail-closed behavior; default deny and require explicit validated allow paths.
- Do not claim verification that was not run; mark unexecuted or unproven claims as \`NOT_VERIFIED\`.`;
    case 'priority':
      return `## 2. Priority Ladder

Priority order: safety/security, user intent, repository contracts and SSOT, minimal correct implementation, style, verbosity. Higher priority rules override lower priority rules.`;
    case 'language':
      return `## Language Conventions

\`MUST\`/\`MUST NOT\` are mandatory. \`SHOULD\`/\`SHOULD NOT\` are expected unless justified. Evidence means concrete artifacts such as code, test output, schema, command result, trace, or file path.`;
    case 'task-router':
      return `## 3. Task Class Router and Phase Gates

Classify before acting: TRIVIAL for no behavior risk, STANDARD for bounded behavior impact, HIGH-RISK for state, policy, risk, identity, audit, archive, release, persistence, migration, CI, or trust boundaries. If uncertain, classify higher. Respect the current workflow phase and use only FlowGuard tools for governed state changes.`;
    case 'hard-invariants':
      return `## 4. Hard Invariants

- Preserve one canonical authority and SSOT ownership.
- Make failures explicit and fail closed.
- Ground claims in concrete evidence.
- Keep runtime, docs, tests, schemas, and config aligned.
- Approve only behavior that is tested, proven, and evidence-backed.`;
    case 'evidence':
      return `## 5. Evidence Rules

Use \`ASSUMPTION\`, \`NOT_VERIFIED\`, and \`BLOCKED\` explicitly. Never present assumptions as runtime truth. Verify assumptions when cheap; otherwise flag them. Never claim tests passed unless they were run.`;
    case 'tool-verification':
      return `## 6. Tool and Verification Policy

Run the narrowest sufficient verification: TRIVIAL optional, STANDARD targeted tests/checks, HIGH-RISK negative-path tests plus typecheck, lint, build, and relevant integration/e2e checks. Release or installer changes require exact artifact install-verification.`;
    case 'ambiguity':
      return `## 7. Ambiguity Policy

Low-risk ambiguity may proceed with marked ASSUMPTION. Standard ambiguity proceeds only if contracts stay clear. High-risk ambiguity requires a question or BLOCKED. Non-interactive runtime must not guess missing safety-relevant input.`;
    case 'output-contract':
      return `## 8. Output Contract

Use one task-class-scaled output contract: TRIVIAL has Result and Verification; STANDARD has Objective, Evidence, Changes, Verification, Risks and NOT_VERIFIED; HIGH-RISK has Objective, Governing Evidence, Touched Surface, Invariants and Failure Modes, Test Evidence, Contract and Authority Check, Residual Risks, and Rollback or Recovery. Reviews return verdict and evidence-backed findings.`;
    case 'implementation-checklist':
      return `## 9. Implementation Checklist

Identify governing contract and authority, read relevant artifacts before changing behavior, keep scope minimal, preserve SSOT and schemas, add risky-path and negative-path coverage, and align runtime, docs, tests, and config.`;
    case 'review-checklist':
      return `## 10. Review Checklist

Review falsification-first: unhappy paths, contract/schema/SSOT drift, correct authority layer, hidden fallback, negative tests, and unsupported claims.`;
    case 'high-risk':
      return `## 11. High-Risk Extension

High-risk work MUST map governing contract and authority, show negative-path test evidence, verify no duplicate authority, preserve fail-closed behavior, document rollback/recovery, and mark explicit \`NOT_VERIFIED\` items.`;
    case 'tool-error':
      return `## 11a. Tool Error Classification

Any blocked, failed, malformed, nonconforming, network, process, or subprocess tool result creates stop conditions. Report the exact reason, state one recovery action, and stop. Never continue to the next workflow phase after a failed FlowGuard tool response.`;
    case 'rule-conflict':
      return `## 11b. Rule Conflict Resolution

Universal FlowGuard mandates outrank slash-command rules, profile rules, and local style. Profiles may narrow behavior but never override mandates, repository contracts, SSOT, schemas, runtime invariants, or fail-closed behavior.`;
    case 'command-execution':
      return `## Governance rules

- Use only FlowGuard tools for state changes.
- Complete the current command fully, then stop.
- Only explicit FlowGuard commands trigger workflow actions.
- End every response with exactly one \`Next action:\` line.`;
    case 'extended-guidance':
      return `## 12. Extended Guidance

This document is self-contained. Optional deeper guidance may exist under docs/, but these mandates remain authoritative.`;
    case 'before-acting':
      return `## Before Acting Rule

Before acting, classify the task, identify authority and SSOT, read relevant artifacts, choose the smallest safe change, and determine verification level.`;
    case 'before-completing':
      return `## Before Completing Rule

Before returning, verify the output contract is satisfied, evidence markers are set, required verification ran, no SSOT drift was introduced, and review obligations or phase gates are not skipped.`;
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

/**
 * Build the full flowguard-mandates.md content with managed-artifact header.
 *
 * Header layout:
 *   Line 1: version + ownership marker
 *   Line 2: content-digest over the body (everything after the header)
 *
 * Digest is SHA-256 hex over FLOWGUARD_MANDATES_BODY (the body without header).
 * This avoids self-referential digest problems.
 *
 * @param version - Package version (e.g. "1.2.0")
 * @param digest  - SHA-256 hex digest of FLOWGUARD_MANDATES_BODY
 */
export function buildMandatesContent(version: string, digest: string): string {
  return `<!-- @flowguard/core v${version} | managed artifact — do not edit manually -->\n<!-- content-digest: sha256:${digest} -->\n\n${FLOWGUARD_MANDATES_BODY}`;
}

/**
 * Extract the content-digest from a flowguard-mandates.md file.
 * Returns null if the file does not have a valid managed-artifact header.
 */
export function extractManagedDigest(content: string): string | null {
  const match = content.match(/^<!-- content-digest: sha256:([a-f0-9]{64}) -->$/m);
  return match?.[1] ?? null;
}

/**
 * Extract the version from a flowguard-mandates.md managed-artifact header.
 * Returns null if the file does not have a valid managed-artifact header.
 */
export function extractManagedVersion(content: string): string | null {
  const match = content.match(
    /^<!-- @flowguard\/core v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?) \| managed artifact/m,
  );
  return match?.[1] ?? null;
}

/**
 * Check if a file has a valid managed-artifact header.
 */
export function isManagedArtifact(content: string): boolean {
  return /^<!-- @flowguard\/core v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)? \| managed artifact/.test(
    content,
  );
}

/**
 * Extract the body from a managed-artifact file (everything after the header).
 *
 * The header is 2 comment lines followed by an empty line:
 *   Line 1: <!-- @flowguard/core ... -->
 *   Line 2: <!-- content-digest: sha256:... -->
 *   Line 3: (empty)
 *   Line 4+: body
 *
 * Returns null if the file does not have a valid managed-artifact header.
 */
export function extractManagedBody(content: string): string | null {
  if (!isManagedArtifact(content)) return null;
  // Find the body after the header (two comment lines + blank line)
  const match = content.match(
    /^<!-- @flowguard\/core[^\n]*\n<!-- content-digest:[^\n]*\n\n([\s\S]*)$/,
  );
  return match?.[1] ?? null;
}
export type ReviewerPromptType = 'plan' | 'implementation' | 'adr' | 'content' | 'all';

const REVIEWER_CRITERIA: Record<Exclude<ReviewerPromptType, 'all'>, string> = {
  plan: `### For Plans
- Completeness: covers all ticket requirements without scope creep.
- Correctness: technical claims, authority boundaries, and assumptions are sound.
- Feasibility: referenced files/APIs exist and the plan can be implemented.
- Edge cases: unhappy paths and fail-closed behavior are concrete.
- Verification: checks are testable and sourced from repo scripts/contracts.`,
  implementation: `### For Implementations
- Plan conformance: every approved step is implemented or explicitly marked NOT_VERIFIED.
- Correctness: no logic, null-safety, fail-open, or state/policy bugs.
- Edge coverage: negative paths from the plan are tested.
- Quality: follows repo conventions without duplicate authority.
- Verification evidence: executed checks are recorded; missing checks are NOT_VERIFIED.`,
  adr: `### For Architecture Decisions (ADRs)
- Problem framing: constraints and forces are explicit.
- Alternatives: at least two realistic options with trade-offs.
- Rationale: chosen option follows from the forces and evidence.
- Consequences: positive and negative impacts are specific.
- Compatibility: schemas, state, persistence, and public contracts are addressed.
- Verification: decision has a falsifiable validation path.`,
  content: `### Content Review (for /review flow)
- Analyze provided PR diff, branch diff, URL content, or manual text.
- Use severity values: "critical" | "major" | "minor" | "info".
- Use categories: "completeness" | "correctness" | "feasibility" | "risk" | "quality".
- Security -> risk; compliance -> correctness; missing validation -> completeness.
- Return complete ReviewFindings; do not drop reviewMode, reviewedBy, reviewedAt, attestation, overallVerdict, missingVerification, scopeCreep, or unknowns.
- Include attestation.toolObligationId exactly as FlowGuard provides it.`,
};

function renderReviewerCriteria(reviewType: ReviewerPromptType): string {
  if (reviewType !== 'all') return REVIEWER_CRITERIA[reviewType];
  return [
    REVIEWER_CRITERIA.plan,
    REVIEWER_CRITERIA.implementation,
    REVIEWER_CRITERIA.adr,
    REVIEWER_CRITERIA.content,
  ].join('\n\n');
}

export function renderReviewerPrompt(reviewType: ReviewerPromptType = 'all'): string {
  return `\
---
description: Independent reviewer for FlowGuard plan, implementation, architecture, and content review. Produces structured ReviewFindings.
mode: subagent
hidden: true
steps: 10
permission:
  edit: deny
  bash: deny
  webfetch: deny
---

You are an independent FlowGuard reviewer. Review falsification-first and return structured findings only.

## Your Role

Find concrete defects the author missed. Do not rubber-stamp. Every finding needs evidence and a location.

## Review Approach

1. Read the provided material and referenced files.
2. Ask what would make each claim wrong.
3. Cite exact files, sections, or lines.
4. Approve only after genuine falsification.

## Review Criteria

${renderReviewerCriteria(reviewType)}

## When You Cannot Review (Validity Conditions)

Emit "unable_to_review" ONLY for tool-failure conditions: submitted text is empty or unparseable, required context is missing, the structured-output schema is unrecoverable, or the mandate digest is corrupted or mismatched. "unable_to_review" is NOT an evasion route; reviewable defects require "changes_requested". When unable, blockingIssues and majorRisks MUST be empty and missingVerification/unknowns MUST identify the tool-failure cause. FlowGuard treats this as BLOCKED.

## Output Format

Your response must conform to this JSON schema. When structured output is active, use the StructuredOutput tool provided by the runtime. If structured output is unavailable, return a single JSON object without markdown fences or surrounding text.

{
  "iteration": <number>,
  "planVersion": <number>,
  "reviewMode": "subagent",
  "overallVerdict": "approve" | "changes_requested" | "unable_to_review",
  "blockingIssues": [{ "severity": "critical" | "major" | "minor", "category": "completeness" | "correctness" | "feasibility" | "risk" | "quality", "message": "<specific problem>", "location": "<file path, section, or line>" }],
  "majorRisks": [{ "severity": "critical" | "major" | "minor", "category": "completeness" | "correctness" | "feasibility" | "risk" | "quality", "message": "<specific risk>", "location": "<where it manifests>" }],
  "missingVerification": ["<specific check not run or not provable>"],
  "scopeCreep": ["<specific out-of-scope item>"],
  "unknowns": ["<specific unresolved question>"],
  "reviewedBy": { "sessionId": "<assigned session ID recorded in invocation evidence>" },
  "reviewedAt": "<ISO 8601 timestamp>",
  "attestation": { "mandateDigest": "<from prompt>", "criteriaVersion": "<from prompt>", "toolObligationId": "<from prompt>", "iteration": <same number>, "planVersion": <same number>, "reviewedBy": "${REVIEWER_SUBAGENT_TYPE}" }
}

## Rules

- overallVerdict MUST be "changes_requested" if blockingIssues contains critical or major severity.
- overallVerdict MAY be "approve" only if blockingIssues is empty or minor only.
- overallVerdict MAY be "unable_to_review" only under the validity conditions above.
- Do NOT use "unable_to_review" to avoid producing substantive findings.
- Do NOT invent findings; every finding must be backed by evidence.
- Do NOT approve without reading the actual artifact.
- reviewMode MUST always be "subagent".
- iteration and planVersion are provided in your task prompt. Use exactly those values.
`;
}

export const REVIEWER_AGENT = renderReviewerPrompt('all');

/** Filename for the reviewer agent definition. */
export const REVIEWER_AGENT_FILENAME = `${REVIEWER_SUBAGENT_TYPE}.md`;

// ---------------------------------------------------------------------------
// opencode.json skeleton
// ---------------------------------------------------------------------------

/**
 * Minimal OpenCode configuration template.
 *
 * Points OpenCode at the flowguard-mandates.md instruction file so FlowGuard
 * mandates are loaded automatically on every session.
 *
 * Includes agent configuration for the flowguard-reviewer subagent with
 * task permissions allowing the build agent to invoke it.
 *
 * @param instructionEntry - The instruction path (scope-dependent).
 */
export const OPENCODE_JSON_TEMPLATE = (instructionEntry: string): string => `\
{
  "$schema": "https://opencode.ai/config.json",
  "instructions": ["${instructionEntry}"],
  "agent": {
    "build": {
      "permission": {
        "task": {
          "*": "deny",
          "${REVIEWER_SUBAGENT_TYPE}": "allow"
        }
      }
    }
  }
}
`;

// ---------------------------------------------------------------------------
// package.json skeleton
// ---------------------------------------------------------------------------

/**
 * Returns a minimal `package.json` fragment declaring FlowGuard dependencies.
 *
 * Only zod and @flowguard/core are required. The @opencode-ai/plugin
 * dependency was removed — FlowGuard tools use plain ToolDefinition objects
 * that OpenCode discovers without the plugin SDK.
 *
 * @param version - The semver version of `@flowguard/core` to pin (e.g. `"1.2.3"`).
 * @returns A JSON string suitable for writing to `package.json`.
 */
export const PACKAGE_JSON_TEMPLATE = (version: string): string => `\
{
  "name": "@flowguard/opencode-runtime",
  "version": "${version}",
  "private": true,
  "dependencies": {
    "@flowguard/core": "file:./vendor/flowguard-core-${version}.tgz",
    "zod": "^4.0.0"
  }
}
`;

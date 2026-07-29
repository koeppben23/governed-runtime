/**
 * @module presentation/markdown
 * @description Deterministic Markdown renderer for PresentationDocument.
 *
 * Produces a single Markdown string from a typed PresentationDocument.
 * No UI dependency, no external libraries, no trailing whitespace,
 * no triple-newlines between structural blocks.
 *
 * Invariants:
 * - No leading newline at document start.
 * - No trailing newline at document end.
 * - Exactly \n\n between non-empty sections.
 * - No trailing whitespace on any line.
 * - No \n\n\n between structural blocks (code-fence content is exempt;
 *   EmbeddedMarkdownSection internal content is opaque and may contain
 *   internal blank lines — triple-newline rule applies only to structural
 *   section joins).
 * - EmbeddedMarkdownSection preserves internal content exactly except for
 *   leading/trailing newlines at the section boundary.
 *
 * The renderer constructs output so that these invariants are structurally
 * impossible to violate — no post-processing, no silent repair.
 *
 * @version v2
 */

import type {
  PresentationDocument,
  PresentationSection,
  PresentationConclusion,
  PresentationAction,
  KeyValueItem,
  TitleSection,
  BlockerSection,
  ChecklistSection,
  CodeSection,
  FindingGroup,
  FindingItem,
  NoticeSection,
  ArtifactItem,
  TextSection,
  BulletListSection,
  GuidanceSection,
  GuidanceStatus,
  DetailedCommandListSection,
  HelpSummarySection,
  HelpArtifactSection,
  EmbeddedMarkdownSection,
} from './model.js';
import { validateCodeLanguage, normalizedMarkdown, PresentationContractError } from './model.js';
import { GUIDANCE_STATUS_LABELS } from './labels.js';

// ─── Document Renderer ─────────────────────────────────────────────────────────

/**
 * Render a PresentationDocument to deterministic Markdown.
 */
export function renderMarkdown(document: PresentationDocument): string {
  validateDocumentContract(document);
  const renderedSections = document.sections
    .map(renderSection)
    .filter((s): s is string => s.length > 0);

  const body = renderedSections.join('\n\n');

  const conclusionBlock =
    document.conclusion && document.conclusion.kind !== undefined
      ? renderConclusion(document.conclusion)
      : '';

  const parts = [body, conclusionBlock].filter((p) => p.length > 0);
  return parts.join('\n\n');
}

/** Enforce the semantic language contract before any Markdown is emitted. */
function validateDocumentContract(document: PresentationDocument): void {
  const titles = document.sections.filter((section) => section.kind === 'title');
  if (titles.length > 1) {
    throw new PresentationContractError(
      'PresentationDocument: at most one TitleSection is allowed',
    );
  }
  if (titles.length === 1 && document.sections[0]?.kind !== 'title') {
    throw new PresentationContractError('PresentationDocument: TitleSection must be first');
  }
  if (document.kind === 'compact_card' && titles.length > 0) {
    throw new PresentationContractError('CompactCardDocument: TitleSection is not allowed');
  }

  if (!('form' in document) || document.form === undefined) return;
  if (!document.conclusion) {
    throw new PresentationContractError(
      `PresentationDocument: ${document.form} form requires exactly one conclusion`,
    );
  }

  const conclusion = document.conclusion;
  const hasBlocker = document.sections.some((section) => section.kind === 'blocker');
  switch (document.form) {
    case 'success':
      if (hasBlocker || conclusion.kind !== 'next_action') {
        throw new PresentationContractError(
          'success form requires a next_action conclusion and no blocker',
        );
      }
      validateRecommendedAction(conclusion.action);
      return;
    case 'blocked':
      if (
        !hasBlocker ||
        (conclusion.kind !== 'next_action' &&
          conclusion.kind !== 'recovery' &&
          conclusion.kind !== 'terminal')
      ) {
        throw new PresentationContractError(
          'blocked form requires a blocker and a next_action, recovery, or terminal conclusion',
        );
      }
      if (conclusion.kind === 'next_action') validateRecommendedAction(conclusion.action);
      if (conclusion.kind === 'recovery') validateRecoveryConclusion(conclusion);
      return;
    case 'decision':
      if (conclusion.kind !== 'decision_required' || conclusion.actions.length === 0) {
        throw new PresentationContractError(
          'decision form requires non-empty decision_required actions',
        );
      }
      for (const action of conclusion.actions) {
        if (action.visibility !== 'available') {
          throw new PresentationContractError(
            'decision_required actions must be available, not recommended',
          );
        }
      }
      return;
    case 'review_pending':
      if (conclusion.kind !== 'review_pending') {
        throw new PresentationContractError(
          'review_pending form requires a review_pending conclusion',
        );
      }
      return;
    case 'terminal':
      if (conclusion.kind !== 'terminal') {
        throw new PresentationContractError('terminal form requires a terminal conclusion');
      }
      return;
    case 'diagnostic':
      if (!hasBlocker || conclusion.kind !== 'recovery') {
        throw new PresentationContractError(
          'diagnostic form requires a blocker and recovery conclusion',
        );
      }
      validateRecoveryConclusion(conclusion);
      return;
  }
}

function validateRecommendedAction(action: PresentationAction): void {
  if (action.visibility !== 'recommended') {
    throw new PresentationContractError('next_action conclusion must contain a recommended action');
  }
}

function validateRecoveryConclusion(
  conclusion: Extract<PresentationConclusion, { kind: 'recovery' }>,
): void {
  if (conclusion.message.trim().length === 0 || conclusion.steps.length === 0) {
    throw new PresentationContractError(
      'recovery conclusion requires a message and at least one step',
    );
  }
  if (conclusion.steps.some((step) => step.trim().length === 0)) {
    throw new PresentationContractError('recovery conclusion steps must not be empty');
  }
}

// ─── Section Dispatcher ────────────────────────────────────────────────────────

function sectionHeading(section: { readonly heading?: string }): string {
  return section.heading && section.heading.length > 0 ? `## ${section.heading}\n\n` : '';
}

function renderSection(section: PresentationSection): string {
  switch (section.kind) {
    case 'title':
      return renderTitle(section);
    case 'keyValue':
      return sectionHeading(section) + renderKeyValue(section.items);
    case 'commandList':
      return sectionHeading(section) + renderCommandList(section.items);
    case 'blocker':
      return sectionHeading(section) + renderBlocker(section);
    case 'artifactList':
      return sectionHeading(section) + renderArtifactList(section.items);
    case 'findings':
      return sectionHeading(section) + renderFindings(section.groups);
    case 'checklist':
      return sectionHeading(section) + renderChecklist(section);
    case 'text':
      return sectionHeading(section) + renderText(section);
    case 'code':
      return sectionHeading(section) + renderCode(section);
    case 'notice':
      return sectionHeading(section) + renderNotice(section);
    case 'bulletList':
      return sectionHeading(section) + renderBulletList(section);
    case 'guidance':
      return sectionHeading(section) + renderGuidance(section);
    case 'detailedCommandList':
      return sectionHeading(section) + renderDetailedCommandList(section);
    case 'helpSummary':
      return sectionHeading(section) + renderHelpSummary(section);
    case 'helpArtifact':
      return sectionHeading(section) + renderHelpArtifact(section);
    case 'embeddedMarkdown':
      return sectionHeading(section) + renderEmbeddedMarkdown(section);
  }
}

// ─── Section Renderers ─────────────────────────────────────────────────────────

function renderTitle(section: TitleSection): string {
  if (section.text.trim().length === 0) {
    throw new PresentationContractError('TitleSection: text must not be empty');
  }
  return `# ${section.text}`;
}

function renderKeyValue(items: readonly KeyValueItem[]): string {
  return items
    .map((item) => `**${item.label}:**${item.value.length > 0 ? ` ${item.value}` : ''}`)
    .join('\n');
}

function renderCommandList(items: readonly PresentationAction[]): string {
  return items.map(renderAction).join('\n');
}

function renderBlocker(section: BlockerSection): string {
  const lines: string[] = [];
  const symbol = '⚠';
  const codeBlock = section.code ? ` \`${section.code}\`` : '';
  lines.push(`${symbol} **Blocked:**${codeBlock} — ${section.text}`);
  if (section.recovery) {
    lines.push(`**Recovery:** ${section.recovery}`);
  }
  return lines.join('\n');
}

function renderArtifactList(items: readonly ArtifactItem[]): string {
  return items
    .map((item) => {
      const statusSymbol = artifactStatusSymbol(item.status);
      const required = item.required ? ' (required)' : '';
      const hint = item.hint ? ` — ${item.hint}` : '';
      return `**${item.slot}:** ${statusSymbol} ${item.label}${required}${hint}`;
    })
    .join('\n');
}

function artifactStatusSymbol(status: ArtifactItem['status']): string {
  switch (status) {
    case 'complete':
      return '✓';
    case 'missing':
      return '✗';
    case 'not_yet_required':
      return '—';
    case 'failed':
      return '✗';
  }
}

function renderFindings(groups: readonly FindingGroup[]): string {
  const blocks: string[] = [];
  for (const group of groups) {
    if (group.items.length === 0) continue;
    const lines: string[] = [`### ${group.label} (${group.items.length})`];
    for (const item of group.items) {
      lines.push(renderFindingItem(item));
    }
    blocks.push(lines.join('\n'));
  }
  // Separate consecutive severity groups with a blank line so each `###` group
  // heading is a cleanly delimited block (consistent with `\n\n`-spaced sections).
  return blocks.join('\n\n');
}

function renderFindingItem(item: FindingItem): string {
  const loc = item.location ? ` \`${item.location}\`` : '';
  return `- **${item.category}:** ${item.message}${loc}`;
}

function renderChecklist(section: ChecklistSection): string {
  const lines: string[] = [];
  if (section.label) {
    lines.push(`**${section.label}:**`);
  }
  for (const item of section.items) {
    lines.push(`- [${item.checked ? 'x' : ' '}] ${item.text}`);
  }
  return lines.join('\n');
}

function renderText(section: TextSection): string {
  return section.content;
}

function renderCode(section: CodeSection): string {
  const lang = validateCodeLanguage(section.language);
  const maxRun = longestBacktickRun(section.content);
  const fence = maxRun >= 3 ? '`'.repeat(maxRun + 1) : '```';
  return `${fence}${lang}\n${section.content}\n${fence}`;
}

function renderNotice(section: NoticeSection): string {
  if (section.message.trim().length === 0) {
    throw new PresentationContractError('NoticeSection: message must not be empty');
  }
  const symbol = noticeSymbol(section.level);
  const lines: string[] = [];
  lines.push(`${symbol} ${section.message}`);
  for (const msg of section.additionalMessages ?? []) {
    if (msg.trim().length === 0) {
      throw new PresentationContractError(
        'NoticeSection: additionalMessages must not contain empty strings',
      );
    }
    lines.push(`${symbol} ${msg}`);
  }
  for (const detail of section.details) {
    lines.push(`**${detail.label}:** ${detail.value}`);
  }
  return lines.join('\n');
}

function renderBulletList(section: BulletListSection): string {
  for (const item of section.items) {
    if (item.trim().length === 0) {
      throw new PresentationContractError('BulletListSection: items must not be empty');
    }
  }
  return section.items.map((t) => `- ${t}`).join('\n');
}

function renderGuidance(section: GuidanceSection): string {
  if (section.items.length === 0) {
    throw new PresentationContractError('GuidanceSection: items must not be empty');
  }
  const lines: string[] = [];
  for (const item of section.items) {
    if (item.action.trim().length === 0) {
      throw new PresentationContractError('GuidanceItem: action must not be empty');
    }
    if (item.reason.trim().length === 0) {
      throw new PresentationContractError('GuidanceItem: reason must not be empty');
    }
    const sym = guidanceSymbol(item.status);
    const label = GUIDANCE_STATUS_LABELS[item.status];
    lines.push(`${sym} **${item.action}:** ${label} — ${item.reason}`);
  }
  return lines.join('\n');
}

function guidanceSymbol(_status: GuidanceStatus): string {
  return '-';
}

function noticeSymbol(level: NoticeSection['level']): string {
  switch (level) {
    case 'warning':
      return '⚠';
    case 'not_verified':
      return '?';
    case 'info':
      return '-';
  }
}

// ─── Help/Diagnostics Renderers ────────────────────────────────────────────────

function renderDetailedCommandList(section: DetailedCommandListSection): string {
  const lines: string[] = [];
  // A `## heading` (emitted centrally by the section dispatcher) supersedes the
  // legacy inline `**label:**`. Only render the label when no heading is set.
  const hasHeading = section.heading !== undefined && section.heading.length > 0;
  if (!hasHeading && section.label) {
    lines.push(`**${section.label}:**`);
  }
  for (const item of section.items) {
    if (item.invocation.trim().length === 0) {
      throw new PresentationContractError('DetailedCommandItem: invocation must not be empty');
    }
    if (item.description.trim().length === 0) {
      throw new PresentationContractError('DetailedCommandItem: description must not be empty');
    }
    for (const alias of item.aliases) {
      if (alias.trim().length === 0) {
        throw new PresentationContractError(
          'DetailedCommandItem: aliases must not contain empty strings',
        );
      }
    }
    const sym = detailedCommandSymbol(item.visibility);
    const aliases =
      item.aliases.length > 0
        ? ` (aliases: ${item.aliases.map((a) => `\`${a}\``).join(', ')})`
        : '';
    const inv =
      item.visibility === 'recommended' ? `**\`${item.invocation}\`**` : `\`${item.invocation}\``;
    lines.push(`  ${sym} ${inv} — ${item.description}${aliases}`);

    if (item.preflight.status === 'blocked') {
      const p = item.preflight;
      if (p.message) lines.push(`    blocked: ${p.message}`);
      if (p.reasonCode) lines.push(`    code: ${p.reasonCode}`);
      if (p.recovery) lines.push(`    recovery: ${p.recovery}`);
    }
  }
  return lines.join('\n');
}

function detailedCommandSymbol(
  _visibility: DetailedCommandListSection['items'][number]['visibility'],
): string {
  return '-';
}

function renderHelpSummary(section: HelpSummarySection): string {
  const lines: string[] = [];

  if (section.phase) {
    lines.push(`**Phase:** ${section.phase}`);
  } else {
    lines.push('**No active FlowGuard session.**');
  }

  if (section.readiness && section.readiness !== 'none') {
    lines.push(`**Readiness:** ${section.readiness}`);
  }

  if (section.blocker) {
    const parts: string[] = [];
    if (section.blocker.message) {
      parts.push(section.blocker.message);
    }
    if (section.blocker.reasonCode) {
      parts.push(`[${section.blocker.reasonCode}]`);
    }
    if (parts.length > 0) {
      lines.push(`**Why blocked:** ${parts.join(' ')}`);
    }
  }

  if (section.nextAction) {
    if ('invocation' in section.nextAction) {
      lines.push(
        `**Next:** \`${section.nextAction.invocation}\` — ${section.nextAction.description}`,
      );
    } else {
      lines.push(`**Next:** ${section.nextAction.summary}`);
    }
  }

  return lines.join('\n');
}

function renderHelpArtifact(section: HelpArtifactSection): string {
  if (section.label.trim().length === 0) {
    throw new PresentationContractError('HelpArtifactSection: label must not be empty');
  }
  const lines: string[] = [];
  lines.push(`**${section.label}:**`);
  for (const item of section.items) {
    if (item.label.trim().length === 0) {
      throw new PresentationContractError('HelpArtifactSection: item label must not be empty');
    }
    const pv = item.preview ? ` "${item.preview}"` : '';
    const dg = item.digest ? ` (digest: ${item.digest.slice(0, 8)}...)` : '';
    if (item.status === 'available') {
      lines.push(`  ${item.label}: available${pv}${dg}`);
    } else {
      lines.push(`  ${item.label}: not verified`);
    }
  }
  return lines.join('\n');
}

function renderEmbeddedMarkdown(section: EmbeddedMarkdownSection): string {
  if (section.label !== undefined && section.label.trim().length === 0) {
    throw new PresentationContractError('EmbeddedMarkdownSection: label must not be empty');
  }

  // Embedded content is authored outside the presentation layer (agent plan/ADR
  // bodies, ticket text). It is the one untrusted input path in the renderer,
  // so it is normalised here — the single shared boundary — rather than by each
  // embedder. Two concerns are handled:
  //  1. Structural sanitisation: strip trailing whitespace and collapse
  //     triple+ newlines so the document invariants hold (code-fence content is
  //     exempt and preserved verbatim).
  //  2. Heading demotion: no embedded heading may be shallower than the section
  //     that owns it. A section with a `heading` renders it as `## heading`, so
  //     the body must start at `###` (H3) or deeper; a label-only embed sits at
  //     document level (next to the document H1 title) and must start at `##`.
  //     This prevents a second document-level H1 and H1-under-H2 inversions.
  const minLevel = section.heading !== undefined ? 3 : 2;
  const normalized = normalizeEmbeddedContent(section.content, minLevel);

  if (normalized.length === 0) {
    throw new PresentationContractError(
      'EmbeddedMarkdownSection: content must not be empty after boundary normalization',
    );
  }

  return section.label !== undefined ? `**${section.label}:**\n${normalized}` : normalized;
}

/**
 * Normalise untrusted embedded Markdown for safe inclusion in a document:
 * boundary-trims, sanitises structural whitespace, and demotes ATX headings so
 * the shallowest heading is at least `minLevel`. Fenced code blocks are opaque:
 * their content (and internal blank lines/indentation) is preserved verbatim.
 */
function normalizeEmbeddedContent(raw: string, minLevel: number): string {
  const boundaryTrimmed = raw.replace(/^\n+/, '').replace(/\n+$/, '');
  if (boundaryTrimmed.length === 0) return '';

  const shallowest = shallowestHeadingLevel(boundaryTrimmed);
  const shift = shallowest !== null && shallowest < minLevel ? minLevel - shallowest : 0;

  const lines = boundaryTrimmed.split('\n');
  const out: string[] = [];
  let inFence = false;
  let fenceMarker = '';
  let prevBlankOutsideFence = false;

  for (const line of lines) {
    const fence = fenceDelimiter(line);
    if (fence !== null && (!inFence || line.trimStart().startsWith(fenceMarker))) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence;
      } else {
        inFence = false;
        fenceMarker = '';
      }
      out.push(line); // fence delimiter lines are preserved verbatim
      prevBlankOutsideFence = false;
      continue;
    }
    if (inFence) {
      out.push(line); // code content preserved verbatim (exempt from all normalisation)
      continue;
    }
    const sanitized = sanitizeStructuralLine(demoteHeadingLine(line, shift));
    const blank = sanitized.length === 0;
    // Collapse triple+ newlines between structural blocks: never allow two
    // consecutive blank lines outside a code fence.
    if (blank && prevBlankOutsideFence) continue;
    out.push(sanitized);
    prevBlankOutsideFence = blank;
  }

  return out.join('\n');
}

/** Return the ``` / ~~~ fence marker if the line opens/closes a fenced block. */
function fenceDelimiter(line: string): string | null {
  const m = /^\s*(`{3,}|~{3,})/.exec(line);
  return m ? m[1]! : null;
}

/** Strip trailing whitespace from a non-code line. */
function sanitizeStructuralLine(line: string): string {
  return line.replace(/[ \t]+$/, '');
}

/** Demote an ATX heading line by `shift` levels (capped at H6). No-op otherwise. */
function demoteHeadingLine(line: string, shift: number): string {
  if (shift <= 0) return line;
  const m = /^(#{1,6})(\s.*)$/.exec(line);
  if (!m) return line;
  const level = Math.min(6, m[1]!.length + shift);
  return '#'.repeat(level) + m[2]!;
}

/** Shallowest (smallest) ATX heading level in fence-external content, or null. */
function shallowestHeadingLevel(content: string): number | null {
  let inFence = false;
  let fenceMarker = '';
  let shallowest: number | null = null;
  for (const line of content.split('\n')) {
    const fence = fenceDelimiter(line);
    if (fence !== null && (!inFence || line.trimStart().startsWith(fenceMarker))) {
      inFence = !inFence;
      fenceMarker = inFence ? fence : '';
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s/.exec(line);
    if (m && (shallowest === null || m[1]!.length < shallowest)) {
      shallowest = m[1]!.length;
    }
  }
  return shallowest;
}

// ─── Conclusion Renderer ───────────────────────────────────────────────────────

function renderConclusion(conclusion: PresentationConclusion): string {
  switch (conclusion.kind) {
    case 'next_action':
      return renderAction(conclusion.action);
    case 'decision_required': {
      // The question is free-form text sourced from upstream projections
      // (e.g. productNextAction/evalResult). Validate it against the
      // structural contract so a stray trailing newline/whitespace fails
      // closed instead of silently violating the document invariants.
      const question = normalizedMarkdown(conclusion.question);
      if (question.length === 0) {
        throw new PresentationContractError(
          'PresentationConclusion: decision_required question must not be empty',
        );
      }
      const lines: string[] = [];
      lines.push(`## Decision required\n`);
      lines.push(question);
      for (const action of conclusion.actions) {
        lines.push(renderAction(action));
      }
      return lines.join('\n');
    }
    case 'terminal': {
      // Terminal message is free-form upstream text; enforce the same
      // structural contract as all other rendered content.
      const message = normalizedMarkdown(conclusion.message);
      if (message.length === 0) {
        throw new PresentationContractError(
          'PresentationConclusion: terminal message must not be empty',
        );
      }
      return message;
    }
    case 'review_pending': {
      const message = normalizedMarkdown(conclusion.message);
      if (message.length === 0) {
        throw new PresentationContractError(
          'PresentationConclusion: review_pending message must not be empty',
        );
      }
      return `## Independent review pending\n\n${message}`;
    }
    case 'recovery': {
      validateRecoveryConclusion(conclusion);
      return `## Recovery\n\n${conclusion.message}\n${conclusion.steps.map((step) => `- ${step}`).join('\n')}`;
    }
  }
}

// ─── Action Renderer ───────────────────────────────────────────────────────────

function renderAction(action: PresentationAction): string {
  const symbol = action.visibility === 'recommended' ? '→' : '-';
  const invocation = action.invocation ? ` \`${action.invocation}\`` : '';
  return `${symbol}${invocation} — ${action.description}`;
}

// ─── Code Fence Helper ─────────────────────────────────────────────────────────

/**
 * Compute the longest consecutive backtick run in a string.
 * Used to select a safe fence length for code blocks.
 */
function longestBacktickRun(content: string): number {
  let maxRun = 0;
  let currentRun = 0;
  for (const char of content) {
    if (char === '`') {
      currentRun++;
      if (currentRun > maxRun) maxRun = currentRun;
    } else {
      currentRun = 0;
    }
  }
  return maxRun;
}

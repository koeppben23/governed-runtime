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
 * - No \n\n\n between structural blocks (code-fence content is exempt).
 *
 * The renderer constructs output so that these invariants are structurally
 * impossible to violate — no post-processing, no silent repair.
 *
 * @version v1
 */

import type {
  PresentationDocument,
  PresentationSection,
  PresentationConclusion,
  PresentationAction,
  KeyValueItem,
  BlockerSection,
  ChecklistSection,
  CodeSection,
  FindingGroup,
  FindingItem,
  NoticeSection,
  ArtifactItem,
  TextSection,
} from './model.js';
import { validateCodeLanguage } from './model.js';

// ─── Document Renderer ─────────────────────────────────────────────────────────

/**
 * Render a PresentationDocument to deterministic Markdown.
 */
export function renderMarkdown(document: PresentationDocument): string {
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

// ─── Section Dispatcher ────────────────────────────────────────────────────────

type HeadedSection = { readonly heading?: string };

function sectionHeading(section: HeadedSection): string {
  return section.heading && section.heading.length > 0 ? `## ${section.heading}\n\n` : '';
}

function renderSection(section: PresentationSection): string {
  switch (section.kind) {
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
  }
}

// ─── Section Renderers ─────────────────────────────────────────────────────────

function renderKeyValue(items: readonly KeyValueItem[]): string {
  return items.map((item) => `**${item.label}:** ${item.value}`).join('\n');
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
  const lines: string[] = [];
  for (const group of groups) {
    if (group.items.length === 0) continue;
    lines.push(`### ${group.label} (${group.items.length})`);
    for (const item of group.items) {
      lines.push(renderFindingItem(item));
    }
  }
  return lines.join('\n');
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
  const symbol = noticeSymbol(section.level);
  const lines: string[] = [];
  lines.push(`${symbol} ${section.message}`);
  for (const detail of section.details) {
    lines.push(`**${detail.label}:** ${detail.value}`);
  }
  return lines.join('\n');
}

function noticeSymbol(level: NoticeSection['level']): string {
  switch (level) {
    case 'warning':
      return '⚠';
    case 'not_verified':
      return '?';
    case 'info':
      return '•';
  }
}

// ─── Conclusion Renderer ───────────────────────────────────────────────────────

function renderConclusion(conclusion: PresentationConclusion): string {
  switch (conclusion.kind) {
    case 'next_action':
      return renderAction(conclusion.action);
    case 'decision_required': {
      const lines: string[] = [];
      lines.push(`## Decision required\n`);
      lines.push(conclusion.question);
      for (const action of conclusion.actions) {
        lines.push(renderAction(action));
      }
      return lines.join('\n');
    }
    case 'terminal':
      return conclusion.message;
  }
}

// ─── Action Renderer ───────────────────────────────────────────────────────────

function renderAction(action: PresentationAction): string {
  const symbol = action.visibility === 'recommended' ? '→' : '•';
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

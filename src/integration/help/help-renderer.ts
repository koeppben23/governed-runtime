/** @module integration/help/help-renderer */

import type { HelpResult, ProjectedCommand } from './help-projection.js';
import { renderMarkdown } from '../../presentation/markdown.js';
import { normalizedMarkdown } from '../../presentation/model.js';
import type {
  HelpDocument,
  PresentationSection,
  DetailedCommandVisibility,
} from '../../presentation/model.js';

export interface RenderOutput {
  readonly format: 'markdown' | 'json';
  readonly verbose?: boolean;
  readonly includeArtifactContent?: boolean;
}

function renderCommandJson(command: ProjectedCommand, verbose: boolean): Record<string, unknown> {
  return {
    invocation: command.invocation,
    description: command.description,
    visibility: command.visibility,
    ...(command.alsoAvailableAs.length > 0 ? { alsoAvailableAs: command.alsoAvailableAs } : {}),
    ...(verbose ? { id: command.id, label: command.label, preflight: command.preflight } : {}),
  };
}

function buildArtifactsJson(result: HelpResult, includeContent: boolean): Record<string, unknown> {
  const ticket: Record<string, unknown> = {
    status: result.artifacts.ticket.status,
    digest: result.artifacts.ticket.digest,
    preview: result.artifacts.ticket.preview,
    ...(includeContent && result.artifacts.ticket.content !== null
      ? { content: result.artifacts.ticket.content }
      : {}),
  };
  const plan: Record<string, unknown> = {
    status: result.artifacts.currentPlan.status,
    digest: result.artifacts.currentPlan.digest,
    preview: result.artifacts.currentPlan.preview,
    version: result.artifacts.currentPlanVersion,
    ...(includeContent && result.artifacts.currentPlan.content !== null
      ? { content: result.artifacts.currentPlan.content }
      : {}),
  };
  return { ticket, currentPlan: plan, status: result.artifacts.status };
}

function renderHelpJson(result: HelpResult, verbose: boolean, includeContent: boolean): string {
  return JSON.stringify({
    title: 'FlowGuard Help',
    phase: result.phase?.label ?? null,
    lifecycle: result.lifecycle,
    readiness: result.readiness,
    recommendationQuality: result.recommendationQuality,
    reviewReportStatus: result.reviewReportStatus,
    nextActionSummary: result.nextActionSummary,
    evidenceCompleteness: result.evidenceCompleteness,
    archiveVerification: result.archiveVerification,
    nextAction: result.nextAction ? renderCommandJson(result.nextAction, verbose) : null,
    commands: result.commands.map((command) => renderCommandJson(command, verbose)),
    artifacts: buildArtifactsJson(result, includeContent),
    ...(result.blocker
      ? { blocker: { reasonCode: result.blocker.reasonCode, message: result.blocker.message } }
      : {}),
  });
}

// ─── Presentation Builder ──────────────────────────────────────────────────────

function mapVisibility(v: ProjectedCommand['visibility']): DetailedCommandVisibility {
  switch (v) {
    case 'recommended':
      return 'recommended';
    case 'blocked_recoverable':
      return 'blocked_recoverable';
    case 'available':
    case 'upcoming':
    case 'not_applicable':
    case 'hidden':
      return 'available';
  }
}

export function buildHelpDocument(result: HelpResult, includeContent: boolean): HelpDocument {
  const sections: PresentationSection[] = [];

  // ## Status — phase / readiness / blocker (next-action pulled into its own
  // section below so the surface reads as a card, consistent with the status
  // and review surfaces). No heading in the no-session case: there is no status
  // to head, and the summary renders a standalone "No active session" line.
  const hasSession = result.phase != null;
  sections.push({
    kind: 'helpSummary',
    ...(hasSession ? { heading: 'Status' } : {}),
    phase: result.phase?.label ?? null,
    readiness: result.readiness !== 'none' ? result.readiness : null,
    blocker: result.blocker
      ? { message: result.blocker.message, reasonCode: result.blocker.reasonCode }
      : null,
    // nextAction is rendered as its own `## Next` section (below), not inline.
    nextAction: null,
  });

  // ## Next — the recommended next action, as its own card section.
  const nextSection = buildNextSection(result);
  if (nextSection) {
    sections.push(nextSection);
  }

  // ## Available commands
  sections.push({
    kind: 'detailedCommandList',
    heading: 'Available commands',
    items: result.commands.map((cmd) => ({
      invocation: cmd.invocation,
      description: cmd.description,
      visibility: mapVisibility(cmd.visibility),
      aliases: cmd.alsoAvailableAs,
      preflight:
        cmd.preflight.status === 'blocked'
          ? {
              status: 'blocked' as const,
              message: cmd.preflight.message,
              reasonCode: cmd.preflight.reasonCode,
              recovery: cmd.preflight.recovery,
            }
          : { status: 'available' as const },
    })),
  });

  // HelpArtifact
  if (result.artifacts.status !== 'not_verified') {
    sections.push(buildHelpArtifactSection(result));
  }

  // EmbeddedMarkdown (Artifact Content)
  if (includeContent) {
    tapArtifactContent(sections, result);
  }

  return { kind: 'help_document', sections };
}

/**
 * Build the `## Next` section from the help result's next action, or null when
 * no next action is available.
 */
function buildNextSection(result: HelpResult): PresentationSection | null {
  if (result.nextAction) {
    return {
      kind: 'text',
      heading: 'Next',
      content: normalizedMarkdown(
        toSingleLine(`\`${result.nextAction.invocation}\` — ${result.nextAction.description}`),
      ),
    };
  }
  if (result.nextActionSummary) {
    const line = toSingleLine(result.nextActionSummary);
    if (line.length === 0) return null;
    return { kind: 'text', heading: 'Next', content: normalizedMarkdown(line) };
  }
  return null;
}

/**
 * Collapse a possibly multi-line summary into a single trimmed line. Guarantees
 * the value satisfies the NormalizedMarkdown contract (no leading/trailing
 * newline, no trailing whitespace), matching the single-line rendering the
 * `## Next` section expects.
 */
function toSingleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function buildHelpArtifactSection(result: HelpResult): PresentationSection {
  return {
    kind: 'helpArtifact',
    label: 'Session artifacts',
    items: [
      {
        label: 'ticket',
        status: result.artifacts.ticket.status,
        preview: result.artifacts.ticket.preview,
        digest: result.artifacts.ticket.digest,
      },
      {
        label: `current plan${result.artifacts.currentPlanVersion ? ` v${result.artifacts.currentPlanVersion}` : ''}`,
        status: result.artifacts.currentPlan.status,
        preview: result.artifacts.currentPlan.preview,
        digest: result.artifacts.currentPlan.digest,
      },
    ],
  };
}

function tapArtifactContent(sections: PresentationSection[], result: HelpResult): void {
  if (result.artifacts.ticket.content) {
    sections.push({
      kind: 'embeddedMarkdown',
      label: 'Ticket',
      content: result.artifacts.ticket.content,
    });
  }
  if (result.artifacts.currentPlan.content) {
    sections.push({
      kind: 'embeddedMarkdown',
      label: `Current plan${result.artifacts.currentPlanVersion ? ` (v${result.artifacts.currentPlanVersion})` : ''}`,
      content: result.artifacts.currentPlan.content,
    });
  }
}

// ─── Public API ────────────────────────────────────────────────────────────────

export function renderHelp(result: HelpResult, output: RenderOutput): string {
  const includeContent = output.includeArtifactContent ?? false;

  if (output.format === 'json') {
    return renderHelpJson(result, output.verbose ?? false, includeContent);
  }

  return renderMarkdown(buildHelpDocument(result, includeContent));
}

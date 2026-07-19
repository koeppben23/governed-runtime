/** @module integration/help/help-renderer */

import type { HelpResult, ProjectedCommand } from './help-projection.js';

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

// ─── Markdown Renderer ─────────────────────────────────────────────────

function visibilityMarker(visibility: string): string {
  switch (visibility) {
    case 'recommended':
      return '\u2192';
    case 'blocked_recoverable':
      return '\u26A0';
    default:
      return '\u2022';
  }
}

function appendHeader(lines: string[], result: HelpResult): void {
  if (result.phase) {
    lines.push(`**Phase:** ${result.phase.label}`);
  } else {
    lines.push('**No active FlowGuard session.**');
  }
  if (result.readiness !== 'none') {
    lines.push(`**Readiness:** ${result.readiness}`);
  }
}

function appendBlocker(lines: string[], result: HelpResult): void {
  if (!result.blocker) return;
  const parts: string[] = [];
  if (result.blocker.message) parts.push(result.blocker.message);
  if (result.blocker.reasonCode) parts.push(`[${result.blocker.reasonCode}]`);
  if (parts.length > 0) lines.push(`**Why blocked:** ${parts.join(' ')}`);
}

function appendNextAction(lines: string[], result: HelpResult): void {
  if (result.nextAction) {
    lines.push(
      `**Next:** \`${result.nextAction.invocation}\` \u2014 ${result.nextAction.description}`,
    );
  } else if (result.nextActionSummary) {
    lines.push(`**Next:** ${result.nextActionSummary}`);
  }
}

function appendCommands(lines: string[], result: HelpResult): void {
  lines.push('');
  lines.push('**Available commands:**');
  for (const cmd of result.commands) {
    const marker = visibilityMarker(cmd.visibility);
    const blockedNote =
      cmd.preflight.status === 'blocked'
        ? ` (blocked: ${cmd.preflight.reasonCode ?? cmd.preflight.message ?? ''})`
        : '';
    lines.push(`  ${marker} \`${cmd.invocation}\` \u2014 ${cmd.description}${blockedNote}`);
  }
}

function appendArtifactMeta(lines: string[], result: HelpResult): void {
  if (result.artifacts.status === 'not_verified') return;
  lines.push('');
  lines.push('**Session artifacts:**');
  if (result.artifacts.ticket.status === 'available') {
    const d = result.artifacts.ticket.digest
      ? ` (digest: ${result.artifacts.ticket.digest.slice(0, 8)}...)`
      : '';
    lines.push(`  ticket: available${d}`);
  } else {
    lines.push('  ticket: not verified');
  }
  if (result.artifacts.currentPlan.status === 'available') {
    const v = result.artifacts.currentPlanVersion ? ` v${result.artifacts.currentPlanVersion}` : '';
    const d = result.artifacts.currentPlan.digest
      ? ` (digest: ${result.artifacts.currentPlan.digest.slice(0, 8)}...)`
      : '';
    lines.push(`  current plan${v}: available${d}`);
  } else {
    lines.push('  current plan: not verified');
  }
}

function appendArtifactContent(lines: string[], result: HelpResult): void {
  if (result.artifacts.ticket.content) {
    lines.push('');
    lines.push('**Ticket:**');
    lines.push(result.artifacts.ticket.content);
  }
  if (result.artifacts.currentPlan.content) {
    lines.push('');
    const v = result.artifacts.currentPlanVersion
      ? ` (v${result.artifacts.currentPlanVersion})`
      : '';
    lines.push(`**Current plan${v}:**`);
    lines.push(result.artifacts.currentPlan.content);
  }
}

function renderHelpMarkdown(result: HelpResult, includeContent: boolean): string {
  const lines: string[] = [];
  appendHeader(lines, result);
  appendBlocker(lines, result);
  appendNextAction(lines, result);
  appendCommands(lines, result);
  appendAliases(lines, result);
  appendArtifactMeta(lines, result);
  if (includeContent) appendArtifactContent(lines, result);
  return lines.join('\n');
}

// ─── Aliases ───────────────────────────────────────────────────────────

function appendAliases(lines: string[], result: HelpResult): void {
  const cmdsWithAliases = result.commands.filter((cmd) => cmd.alsoAvailableAs.length > 0);
  if (cmdsWithAliases.length === 0) return;
  const allAliases = cmdsWithAliases.flatMap((cmd) => cmd.alsoAvailableAs);
  if (allAliases.length === 0) return;
  lines.push('');
  lines.push(`**Aliases:** ${allAliases.map((a) => `\`${a}\``).join(', ')}`);
}

// ─── Public API ────────────────────────────────────────────────────────

export function renderHelp(result: HelpResult, output: RenderOutput): string {
  const includeContent = output.includeArtifactContent ?? false;
  if (output.format === 'json') {
    return renderHelpJson(result, output.verbose ?? false, includeContent);
  }
  return renderHelpMarkdown(result, includeContent);
}

/**
 * Native `/diagnostics`: portable, read-only diagnostic views over existing
 * FlowGuard authorities. The command never starts, hydrates, reconciles,
 * approves or repairs governance, and never writes a diagnostic artifact.
 */
import path from 'node:path';
import type { Plugin } from '@opencode/plugin';

import { resolveRoot } from '../adapters/git.js';
import { resolveSessionAuthority } from '../adapters/session-authority.js';
import { getLogDir } from '../logging/file-sink.js';
import { NATIVE_DIAGNOSTICS_COMMAND } from '../shared/flowguard-identifiers.js';
import {
  buildExplorerView,
  buildNotificationView,
  buildReviewView,
  DiagnosticViewError,
  readLogView,
  renderDiagnosticsHelp,
  renderExplorerView,
  renderLogView,
  renderNotificationView,
  renderReviewView,
  type LogViewFilter,
  type LogViewLevel,
} from './diagnostics/index.js';

type CommandEditor = Parameters<Parameters<Plugin.Context['command']['transform']>[0]>[0];

type DiagnosticsMode = 'help' | 'explorer' | 'review' | 'logs' | 'notifications';

interface ParsedDiagnosticsArgs {
  readonly mode: DiagnosticsMode;
  readonly filter: Partial<LogViewFilter>;
  readonly maxLines: number | null;
}

const LOG_LEVELS: readonly LogViewLevel[] = ['debug', 'info', 'warn', 'error'];

function usageError(message: string): DiagnosticViewError {
  return new DiagnosticViewError('INVALID_FILTER', message);
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw usageError(`${name} must be a positive integer.`);
  }
  return parsed;
}

function parseLevels(value: string): readonly LogViewLevel[] {
  const levels = value
    .split(',')
    .map((level) => level.trim())
    .filter((level) => level.length > 0);
  if (levels.length === 0) throw usageError('level must name at least one log level.');
  for (const level of levels) {
    if (!LOG_LEVELS.includes(level as LogViewLevel)) {
      throw usageError(`Unknown log level "${level}"; expected ${LOG_LEVELS.join(', ')}.`);
    }
  }
  return levels as readonly LogViewLevel[];
}

const MODES: ReadonlySet<DiagnosticsMode> = new Set([
  'help',
  'explorer',
  'review',
  'logs',
  'notifications',
]);

function parseMode(first: string | undefined): DiagnosticsMode {
  if (first === undefined || first === '--help') return 'help';
  if (!MODES.has(first as DiagnosticsMode)) {
    throw usageError(`Unknown diagnostics mode "${first}".`);
  }
  return first as DiagnosticsMode;
}

interface MutableLogFilter {
  levels?: readonly LogViewLevel[];
  sessionId?: string;
  traceId?: string;
  since?: string;
  until?: string;
}

function parseLogOption(
  token: string,
  filter: MutableLogFilter,
): { readonly maxLines: number } | null {
  const separator = token.indexOf('=');
  if (separator <= 0) throw usageError(`Expected key=value, got "${token}".`);
  const key = token.slice(0, separator);
  const value = token.slice(separator + 1);
  if (value.length === 0) throw usageError(`${key} needs a value.`);
  switch (key) {
    case 'level':
      filter.levels = parseLevels(value);
      return null;
    case 'session':
      filter.sessionId = value;
      return null;
    case 'trace':
      filter.traceId = value;
      return null;
    case 'since':
      filter.since = value;
      return null;
    case 'until':
      filter.until = value;
      return null;
    case 'limit':
      return { maxLines: positiveInteger(value, 'limit') };
    default:
      throw usageError(`Unknown logs option "${key}".`);
  }
}

/** Parse `/diagnostics [explorer|review|logs|notifications] [key=value...]`. */
export function parseDiagnosticsArguments(text: string): ParsedDiagnosticsArgs {
  const tokens = text.trim().length === 0 ? [] : text.trim().split(/\s+/);
  const mode = parseMode(tokens[0]);
  if (mode !== 'logs') {
    if (tokens.length > 1) {
      throw usageError(`/${NATIVE_DIAGNOSTICS_COMMAND} ${mode} takes no arguments.`);
    }
    return { mode, filter: {}, maxLines: null };
  }

  const filter: MutableLogFilter = {};
  let maxLines: number | null = null;
  for (const token of tokens.slice(1)) {
    const parsed = parseLogOption(token, filter);
    if (parsed !== null) maxLines = parsed.maxLines;
  }
  return { mode, filter, maxLines };
}

async function diagnosticRoot(ctx: Plugin.Context): Promise<string> {
  try {
    return await resolveRoot(ctx.location.directory);
  } catch {
    // The view reports the authoritative resolution failure itself.
    return ctx.location.directory;
  }
}

async function logDirectoryFor(root: string, sessionId: string): Promise<string | null> {
  const resolution = await resolveSessionAuthority({ root, sessionId });
  if (resolution.status !== 'resolved' && resolution.status !== 'absent') return null;
  // The session authority owns the workspace/session location. Reuse its
  // resolved directory rather than deriving a workspace path locally.
  const workspaceDir = path.dirname(path.dirname(resolution.sessDir));
  return getLogDir(workspaceDir);
}

async function runDiagnostics(
  ctx: Plugin.Context,
  sessionId: string,
  text: string,
): Promise<string> {
  const parsed = parseDiagnosticsArguments(text);
  if (parsed.mode === 'help') return renderDiagnosticsHelp();
  const root = await diagnosticRoot(ctx);
  switch (parsed.mode) {
    case 'explorer':
      return renderExplorerView(await buildExplorerView({ root, sessionId }));
    case 'review':
      return renderReviewView(await buildReviewView({ root, sessionId }));
    case 'logs': {
      const directory = await logDirectoryFor(root, sessionId);
      return renderLogView(
        await readLogView({
          directory,
          filter: parsed.filter,
          ...(parsed.maxLines !== null ? { maxLines: parsed.maxLines } : {}),
        }),
      );
    }
    case 'notifications':
      return renderNotificationView(
        buildNotificationView({ logDirectory: await logDirectoryFor(root, sessionId) }),
      );
  }
}

function failureText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return ['# FlowGuard Diagnostics', '', `**Error:** ${message}`, '', renderDiagnosticsHelp()].join(
    '\n',
  );
}

export function addDiagnosticsCommand(ctx: Plugin.Context, editor: CommandEditor): void {
  editor.add({
    name: NATIVE_DIAGNOSTICS_COMMAND,
    description:
      'Show read-only diagnostic views: session lineage, review subject, bounded file logs and notification capability.',
    execute: async (input) => {
      let output: string;
      try {
        output = await runDiagnostics(ctx, input.sessionID, input.prompt.text);
      } catch (error) {
        if (!(error instanceof DiagnosticViewError)) throw error;
        output = failureText(error);
      }
      try {
        await ctx.session.prompt({ sessionID: input.sessionID, text: output });
      } catch (error) {
        console.warn('[FlowGuard] Diagnostic view could not be presented.', error);
      }
    },
  });
}

/** Native `/debug-export`: a read-only diagnostic snapshot, never governance authority. */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Plugin } from '@opencode/plugin';

import {
  normalizeHostTranscript,
  writeDiagnosticExport,
  type HostTranscript,
} from '../adapters/diagnostics/index.js';
import { resolveRoot } from '../adapters/git.js';
import { NATIVE_DEBUG_EXPORT_COMMAND } from '../shared/flowguard-identifiers.js';

type CommandEditor = Parameters<Parameters<Plugin.Context['command']['transform']>[0]>[0];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messagesFromContext(context: unknown): unknown[] {
  if (Array.isArray(context)) return context;
  if (isRecord(context) && Array.isArray(context['messages'])) return context['messages'];
  return [];
}

async function nativeHostTranscript(
  ctx: Plugin.Context,
  sessionId: string,
): Promise<HostTranscript> {
  const session = await ctx.session.get({ sessionID: sessionId });
  const context = await ctx.session.context({ sessionID: sessionId });
  return normalizeHostTranscript(
    { info: session, messages: messagesFromContext(context) },
    sessionId,
  );
}

async function runDebugExport(ctx: Plugin.Context, sessionId: string): Promise<string> {
  const location = ctx.location.directory;
  let root: string = location;
  try {
    root = await resolveRoot(location);
  } catch {
    // The collector still reports the authoritative resolution failure.
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = path.join(
    root,
    '.opencode',
    'diagnostics',
    `debug-export-${timestamp}-${randomUUID()}`,
  );
  const result = await writeDiagnosticExport({
    root,
    sessionId,
    outputDir,
    redactionMode: 'basic',
    includeHost: true,
    hostReader: (childSessionId) => nativeHostTranscript(ctx, childSessionId),
  });
  const warningLines = result.manifest.warnings.map(
    (warning) =>
      `- \`${warning.code}\`${warning.sessionId ? ` (${warning.sessionId})` : ''}: ${warning.message}`,
  );
  return [
    `**Diagnostic export: ${result.manifest.status}**`,
    `Path: \`${result.outputDir}\``,
    `Sessions: ${result.manifest.counts.sessions}; audit events: ${result.manifest.counts.auditEvents}; host messages: ${result.manifest.counts.hostMessages}.`,
    warningLines.length > 0 ? `Warnings:\n${warningLines.join('\n')}` : 'No capture warnings.',
    'This snapshot is diagnostic only. It is not governance evidence, an authorization or a governed `/export`.',
  ].join('\n\n');
}

export function addDebugExportCommand(ctx: Plugin.Context, editor: CommandEditor): void {
  editor.add({
    name: NATIVE_DEBUG_EXPORT_COMMAND,
    description:
      'Create a bounded, read-only diagnostic snapshot for this session and its known reviewer children.',
    execute: async (input) => {
      const text = await runDebugExport(ctx, input.sessionID);
      try {
        await ctx.session.prompt({ sessionID: input.sessionID, text });
      } catch (error) {
        console.warn('[FlowGuard] Diagnostic snapshot written; presentation failed.', error);
      }
    },
  });
}

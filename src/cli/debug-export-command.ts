/**
 * @module cli/debug-export-command
 * @description `flowguard debug-export` — bounded, read-only diagnostic snapshot.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { resolveRoot } from '../adapters/git.js';
import {
  DEFAULT_DIAGNOSTIC_LIMITS,
  DiagnosticExportError,
  writeDiagnosticExport,
  type DiagnosticExportLimits,
  type DiagnosticManifest,
} from '../adapters/diagnostics/index.js';
import { readHostTranscript } from './debug-export-host.js';
import type { CliParseResult } from './parse-result.js';

type RedactionChoice = 'basic' | 'pseudonymous' | 'none';

export interface DebugExportArgs {
  readonly sessionId: string;
  readonly outputDir?: string;
  readonly includeHost: boolean;
  readonly redaction: RedactionChoice;
  readonly limits: DiagnosticExportLimits;
  readonly json: boolean;
}

interface MutableDebugExportArgs {
  sessionId?: string;
  outputDir?: string;
  includeHost: boolean;
  redaction: RedactionChoice;
  redactionExplicit: boolean;
  rawRequested: boolean;
  maxSessions: number;
  maxFileBytes: number;
  hostTimeoutMs: number;
  json: boolean;
}

const VALUE_FLAGS = new Set([
  '--session',
  '--out',
  '--redaction',
  '--max-sessions',
  '--max-file-bytes',
  '--host-timeout-ms',
]);

function positiveInteger(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseRedaction(value: string): RedactionChoice | null {
  return value === 'basic' || value === 'pseudonymous' || value === 'none' ? value : null;
}

function assignValueFlag(args: MutableDebugExportArgs, flag: string, value: string): string | null {
  if (flag === '--session') {
    args.sessionId = value;
    return null;
  }
  if (flag === '--out') {
    args.outputDir = value;
    return null;
  }
  if (flag === '--redaction') {
    const redaction = parseRedaction(value);
    if (redaction === null) return '--redaction must be basic, pseudonymous, or none';
    if (args.rawRequested && redaction !== 'none')
      return '--raw cannot be combined with a redaction mode other than none';
    args.redaction = redaction;
    args.redactionExplicit = true;
    return null;
  }
  const number = positiveInteger(value);
  if (number === null) return `${flag} requires a positive integer`;
  if (flag === '--max-sessions') args.maxSessions = number;
  if (flag === '--max-file-bytes') args.maxFileBytes = number;
  if (flag === '--host-timeout-ms') args.hostTimeoutMs = number;
  return null;
}

const BOOLEAN_FLAGS = new Set(['--no-host', '--raw', '--json']);

function applyBooleanFlag(args: MutableDebugExportArgs, flag: string): string | null {
  if (flag === '--no-host') {
    args.includeHost = false;
    return null;
  }
  if (flag === '--json') {
    args.json = true;
    return null;
  }
  if (args.redactionExplicit && args.redaction !== 'none')
    return '--raw cannot be combined with a redaction mode other than none';
  args.redaction = 'none';
  args.rawRequested = true;
  return null;
}

function parseOneArg(
  args: MutableDebugExportArgs,
  argv: readonly string[],
  index: number,
): { next: number } | { error: string } | { help: true } {
  const arg = argv[index];
  if (arg === undefined) return { error: 'Unexpected empty argument' };
  if (arg === '--help' || arg === '-h') return { help: true };
  if (BOOLEAN_FLAGS.has(arg)) {
    const error = applyBooleanFlag(args, arg);
    return error === null ? { next: index + 1 } : { error };
  }
  if (!VALUE_FLAGS.has(arg)) return { error: `Unknown option: ${arg}` };
  const value = argv[index + 1];
  if (value === undefined || value.length === 0) return { error: `${arg} requires a value` };
  const error = assignValueFlag(args, arg, value);
  return error === null ? { next: index + 2 } : { error };
}

export function parseDebugExportArgs(argv: readonly string[]): CliParseResult<DebugExportArgs> {
  const args: MutableDebugExportArgs = {
    includeHost: true,
    redaction: 'basic',
    redactionExplicit: false,
    rawRequested: false,
    maxSessions: DEFAULT_DIAGNOSTIC_LIMITS.maxSessions,
    maxFileBytes: DEFAULT_DIAGNOSTIC_LIMITS.maxFileBytes,
    hostTimeoutMs: DEFAULT_DIAGNOSTIC_LIMITS.hostTimeoutMs,
    json: false,
  };
  let index = 0;
  while (index < argv.length) {
    const consumed = parseOneArg(args, argv, index);
    if ('help' in consumed) return { kind: 'help' };
    if ('error' in consumed) return { kind: 'error', error: consumed.error };
    index = consumed.next;
  }
  if (args.sessionId === undefined || args.sessionId.trim().length === 0) {
    return { kind: 'error', error: '--session <id> is required' };
  }
  return {
    kind: 'ok',
    value: {
      sessionId: args.sessionId,
      ...(args.outputDir === undefined ? {} : { outputDir: args.outputDir }),
      includeHost: args.includeHost,
      redaction: args.redaction,
      limits: {
        maxSessions: args.maxSessions,
        maxFileBytes: args.maxFileBytes,
        hostTimeoutMs: args.hostTimeoutMs,
      },
      json: args.json,
    },
  };
}

export function getDebugExportUsage(): string {
  return `Usage: flowguard debug-export --session <id> [options]

Create a bounded, read-only diagnostic snapshot for one FlowGuard session and
its known reviewer children. It never starts, hydrates, reconciles or approves.

Options:
  --session <id>          Root FlowGuard session ID (required)
  --out <dir>             New output directory (write-once; defaults under
                          .opencode/diagnostics/)
  --no-host               Do not capture OpenCode transcript exports
  --redaction <mode>      basic (default), pseudonymous, or none
  --raw                   Shorthand for --redaction none; explicit consent
  --max-sessions <n>      Maximum known sessions to capture (default 100)
  --max-file-bytes <n>    Maximum host transcript bytes per session
  --host-timeout-ms <n>   Host export timeout per session
  --json                  Print the manifest as JSON
  -h, --help              Show this help

A snapshot is diagnostic evidence, not a FlowGuard authorization or export.
`;
}

function defaultOutputDir(worktreeRoot: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(
    worktreeRoot,
    '.opencode',
    'diagnostics',
    `debug-export-${timestamp}-${randomUUID()}`,
  );
}

function printManifest(manifest: DiagnosticManifest): void {
  const lines = [
    `Diagnostic export: ${manifest.status}`,
    `Capture: ${manifest.captureId}`,
    `Sessions: known=${manifest.boundary.sessionsKnown} withState=${manifest.boundary.sessionsWithState} withoutState=${manifest.boundary.sessionsWithoutState} unavailable=${manifest.boundary.sessionsUnavailable}`,
    `Audit events: ${manifest.counts.auditEvents}`,
    `Host messages: ${manifest.counts.hostMessages} (${manifest.boundary.hostHistory})`,
    `Warnings: ${manifest.counts.warnings}`,
  ];
  for (const warning of manifest.warnings) {
    const session = warning.sessionId === null ? '' : ` [${warning.sessionId}]`;
    lines.push(`  - ${warning.code}${session}: ${warning.message}`);
  }
  console.log(lines.join('\n'));
}

export async function debugExportMain(argv: readonly string[]): Promise<number> {
  const parsed = parseDebugExportArgs(argv);
  if (parsed.kind === 'help') {
    console.log(getDebugExportUsage());
    return 0;
  }
  if (parsed.kind === 'error') {
    console.error(`[error] ${parsed.error}`);
    console.error(getDebugExportUsage());
    return 2;
  }

  let worktreeRoot: string;
  try {
    worktreeRoot = await resolveRoot(process.cwd());
  } catch (error) {
    console.error(
      `[error] Cannot resolve the workspace: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  const outputDir = path.resolve(
    process.cwd(),
    parsed.value.outputDir ?? defaultOutputDir(worktreeRoot),
  );
  const { sessionId, includeHost, redaction, limits, json } = parsed.value;
  const hostReader = includeHost
    ? (childSessionId: string) =>
        readHostTranscript(childSessionId, {
          workspace: worktreeRoot,
          maxBytes: limits.maxFileBytes,
          timeoutMs: limits.hostTimeoutMs,
        })
    : undefined;

  try {
    const result = await writeDiagnosticExport({
      root: worktreeRoot,
      sessionId,
      outputDir,
      redactionMode: redaction,
      includeHost,
      limits,
      ...(hostReader === undefined ? {} : { hostReader }),
    });
    console.log(`Snapshot written to: ${result.outputDir}`);
    if (json) console.log(JSON.stringify(result.manifest, null, 2));
    else printManifest(result.manifest);
    return 0;
  } catch (error) {
    if (error instanceof DiagnosticExportError) {
      console.error(`[error] ${error.code}: ${error.message}`);
      return 1;
    }
    console.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

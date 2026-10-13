/**
 * @module cli/inspect-command
 * @description flowguard inspect — read-only session compliance reporting.
 *
 * Two modes:
 *   flowguard inspect                List all sessions in the workspace
 *   flowguard inspect --session <id> Full compliance report for one session
 *   flowguard inspect --session <id> --json  ComplianceSummary as JSON
 *
 * Delegates 100% to existing audit/summary/query/integrity modules.
 * No mutation, no schema changes, no new runtime behavior.
 */

import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { readAuditTrail } from '../adapters/persistence-audit.js';
import { auditPath } from '../adapters/persistence.js';
import { sessionDir, workspaceDir } from '../adapters/workspace/index.js';
import { computeFingerprint } from '../adapters/workspace/fingerprint.js';
import { GitError, resolveRoot } from '../adapters/git.js';

import { verifyChain } from '../audit/integrity.js';
import { generateComplianceSummary, type ComplianceSummary } from '../audit/summary.js';
import { runUpgradeCheck, reportWorkspaceUnresolved } from './inspect-upgrade-check.js';
import { runIso27001Inspect } from './inspect-iso27001.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSIONS_SUBDIR = 'sessions';

// ─── Argument Parsing ─────────────────────────────────────────────────────────

export interface InspectArgs {
  readonly sessionId?: string;
  readonly json: boolean;
  readonly upgradeCheck: boolean;
  /** Organization-owned ISO/IEC 27001:2022 evidence mapping path. */
  readonly iso27001Mapping?: string;
  /** Optional companion-report output path (write-once). */
  readonly output?: string;
}

interface MutableInspectArgs {
  sessionId?: string;
  json: boolean;
  upgradeCheck: boolean;
  iso27001Mapping?: string;
  output?: string;
}

const VALUE_FLAGS = new Set(['--session', '--iso27001-mapping', '--output']);

function valueFlagError(flag: string): string {
  return flag === '--session' ? '--session requires a session ID' : `${flag} requires a file path`;
}

function assignValueFlag(args: MutableInspectArgs, flag: string, value: string): string | null {
  if (flag === '--session') {
    args.sessionId = value;
    return null;
  }
  if (flag === '--iso27001-mapping') {
    if (args.iso27001Mapping !== undefined) {
      return '--iso27001-mapping may be provided only once';
    }
    args.iso27001Mapping = value;
    return null;
  }
  if (args.output !== undefined) return '--output may be provided only once';
  args.output = value;
  return null;
}

function validateInspectCombinations(args: MutableInspectArgs): string | null {
  if (args.upgradeCheck && args.sessionId !== undefined) {
    return '--upgrade-check cannot be combined with --session';
  }
  if (args.iso27001Mapping !== undefined && args.upgradeCheck) {
    return '--iso27001-mapping cannot be combined with --upgrade-check';
  }
  if (args.iso27001Mapping !== undefined && args.sessionId === undefined) {
    return '--iso27001-mapping requires --session <id>';
  }
  if (args.output !== undefined && args.iso27001Mapping === undefined) {
    return '--output requires --iso27001-mapping';
  }
  return null;
}

type ArgConsumption =
  | { readonly kind: 'ok'; readonly nextIndex: number }
  | { readonly kind: 'error'; readonly error: string }
  | { readonly kind: 'help' };

function consumeInspectArg(
  argv: string[],
  index: number,
  args: MutableInspectArgs,
): ArgConsumption {
  const arg = argv[index];
  if (arg === undefined) return { kind: 'ok', nextIndex: index };
  if (arg === '--help' || arg === '-h') return { kind: 'help' };
  if (arg === '--upgrade-check') {
    args.upgradeCheck = true;
    return { kind: 'ok', nextIndex: index };
  }
  if (arg === '--json') {
    args.json = true;
    return { kind: 'ok', nextIndex: index };
  }
  if (!VALUE_FLAGS.has(arg)) return { kind: 'error', error: `Unknown argument: ${arg}` };
  const value = argv[index + 1];
  if (!value) return { kind: 'error', error: valueFlagError(arg) };
  const assignmentError = assignValueFlag(args, arg, value);
  if (assignmentError !== null) return { kind: 'error', error: assignmentError };
  return { kind: 'ok', nextIndex: index + 1 };
}

export function parseInspectArgs(
  argv: string[],
): { ok: true; args: InspectArgs } | { ok: false; error: string } {
  const args: MutableInspectArgs = { json: false, upgradeCheck: false };

  let index = 0;
  while (index < argv.length) {
    const consumed = consumeInspectArg(argv, index, args);
    if (consumed.kind === 'help') return { ok: false, error: 'help' };
    if (consumed.kind === 'error') return { ok: false, error: consumed.error };
    index = consumed.nextIndex + 1;
  }

  const combinationError = validateInspectCombinations(args);
  if (combinationError !== null) return { ok: false, error: combinationError };

  return {
    ok: true,
    args: {
      json: args.json,
      upgradeCheck: args.upgradeCheck,
      ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
      ...(args.iso27001Mapping !== undefined ? { iso27001Mapping: args.iso27001Mapping } : {}),
      ...(args.output !== undefined ? { output: args.output } : {}),
    },
  };
}

export function getInspectUsage(): string {
  return `Usage: flowguard inspect [options]

Session compliance reporting (read-only).

Modes:
  flowguard inspect                      List all sessions in the workspace
  flowguard inspect --session <id>       Full compliance report for one session
  flowguard inspect --upgrade-check      Pre-upgrade preflight for this workspace
  flowguard inspect --session <id> --iso27001-mapping <file>
                                          ISO/IEC 27001:2022 evidence-to-control report
                                          (Markdown by default, JSON with --json)

Options:
  --session <id>          Session ID to inspect
  --upgrade-check         Report sessions/archives that block a hard-cut upgrade
                          (exit 1 when the workspace is not upgrade-ready)
  --iso27001-mapping <f>  Organization-owned ISO/IEC 27001:2022 mapping file
                          (requires --session; exit 2 when the completion
                          export is missing or fails verification)
  --output <f>            Write the companion report to a new file (write-once;
                          requires --iso27001-mapping)
  --json                  Output JSON (requires --session or --upgrade-check)
  -h, --help              Show this help

inspect operates on the current repository and does not accept
installation-target or host-selection flags.`;
}

// ─── Session Discovery ────────────────────────────────────────────────────────

/** A canonically resolved workspace: worktree root plus its fingerprint. */
interface ResolvedWorkspace {
  readonly fingerprint: string;
  readonly worktreeRoot: string;
  readonly normalizedRoot: string;
}

/** Resolve the workspace identity for the current directory. */
async function resolveWorkspace(): Promise<ResolvedWorkspace> {
  const worktreeRoot = await resolveRoot(process.cwd());
  const fpResult = await computeFingerprint(worktreeRoot);
  return {
    fingerprint: fpResult.fingerprint,
    worktreeRoot,
    normalizedRoot: fpResult.normalizedRoot,
  };
}

/**
 * Map a workspace-resolution failure to the mode-specific exit contract.
 * Only "not a repository" is an empty inventory for the plain list mode; every
 * other git failure (timeout, missing executable, command failure) is a
 * resolution error and must not masquerade as a successful empty listing.
 */
function resolveFailureExit(
  error: unknown,
  mode: { readonly upgradeCheck: boolean; readonly json: boolean; readonly sessionId?: string },
): number {
  const message = error instanceof Error ? error.message : String(error);
  if (mode.upgradeCheck) {
    return reportWorkspaceUnresolved(mode.json, message);
  }
  if (mode.sessionId !== undefined) {
    return exitWithError(
      `Cannot resolve the workspace for session "${mode.sessionId}": ${message}`,
    );
  }
  if (error instanceof GitError && error.code === 'NOT_GIT_REPO') {
    console.log('No FlowGuard sessions found.');
    return 0;
  }
  return exitWithError(`Cannot resolve the workspace: ${message}`);
}

/** List all session IDs with audit trails in the given workspace. */
function listWorkspaceSessions(fingerprint: string): string[] {
  const sessionsRoot = path.join(workspaceDir(fingerprint), SESSIONS_SUBDIR);
  if (!existsSync(sessionsRoot)) return [];

  try {
    return readdirSync(sessionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => existsSync(auditPath(path.join(sessionsRoot, name))));
  } catch {
    return [];
  }
}

// ─── Output Formatting ────────────────────────────────────────────────────────

function formatCheckRow(
  check: { name: string; passed: boolean; detail: string },
  pad: number,
): string {
  const name = check.name.padEnd(pad);
  const status = check.passed ? 'PASSED' : 'FAILED';
  return `${name} ${status}  ${check.detail}`;
}

function formatComplianceReport(summary: ComplianceSummary): string {
  const lines: string[] = [];
  const maxNameLen = Math.max(...summary.checks.map((c) => c.name.length), 10);

  lines.push(`Session: ${summary.sessionId}`);
  lines.push(`Generated: ${summary.generatedAt}`);
  lines.push(`Status: ${summary.compliant ? 'PASSED' : 'FAILED'}`);
  lines.push('');
  lines.push('Check'.padEnd(maxNameLen + 2) + 'Result');
  lines.push('─'.repeat(maxNameLen + 50));

  for (const check of summary.checks) {
    lines.push(formatCheckRow(check, maxNameLen + 2));
  }

  lines.push('');
  lines.push('Statistics:');
  lines.push(`  Total events: ${summary.stats.totalEvents}`);

  const kindEntries = Object.entries(summary.stats.byKind);
  if (kindEntries.length > 0) {
    lines.push(`  By kind: ${kindEntries.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }

  const phaseEntries = Object.entries(summary.stats.byPhase);
  if (phaseEntries.length > 0) {
    lines.push(`  By phase: ${phaseEntries.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }

  if (summary.chainIntegrity) {
    lines.push(
      `  Chain integrity: ${summary.chainIntegrity.valid ? 'valid' : 'broken'} (${summary.chainIntegrity.verifiedCount}/${summary.chainIntegrity.totalEvents} verified)`,
    );
  }

  return lines.join('\n');
}

function formatSessionList(
  sessions: Array<{ sessionId: string; eventCount: number; phases: string; age: string }>,
): string {
  if (sessions.length === 0) {
    return 'No sessions with audit trails found in this workspace.';
  }

  const lines: string[] = [
    `Found ${sessions.length} session(s):`,
    '',
    'SESSION ID                           EVENTS  PHASES                        LAST EVENT',
  ];

  for (const s of sessions) {
    const id = s.sessionId.padEnd(36);
    const count = String(s.eventCount).padEnd(8);
    const phases = (s.phases || '(no transitions)').padEnd(30);
    lines.push(`${id} ${count}${phases}${s.age}`);
  }

  lines.push('');
  lines.push('Run `flowguard inspect --session <id>` for compliance details.');
  return lines.join('\n');
}

function relativeAge(isoTimestamp: string): string {
  const ms = Date.now() - new Date(isoTimestamp).getTime();
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

// ─── Top-Level Error Helpers ─────────────────────────────────────────────────

function exitWithError(message: string): number {
  console.error(`[error] ${message}`);
  return 1;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function listWorkspaceSessionsMode(fingerprint: string, sessions: string[]): Promise<number> {
  if (sessions.length === 0) {
    console.log('No sessions with audit trails found in this workspace.');
    return 0;
  }

  const summaries: Array<{ sessionId: string; eventCount: number; phases: string; age: string }> =
    [];
  for (const sid of sessions) {
    const summary = await readSessionSummary(fingerprint, sid);
    summaries.push(summary);
  }

  console.log(formatSessionList(summaries));
  return 0;
}

async function readSessionSummary(
  fingerprint: string,
  sid: string,
): Promise<{ sessionId: string; eventCount: number; phases: string; age: string }> {
  const sd = sessionDir(fingerprint, sid);
  const trailPath = auditPath(sd);
  let eventCount = 0;
  let phases = '';
  let lastTimestamp = '';

  try {
    const raw = await readFile(trailPath, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim());
    eventCount = lines.length;

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const rawLine = lines[i];
        if (!rawLine) continue;
        const evt = JSON.parse(rawLine) as Record<string, unknown> | null;
        if (evt?.timestamp) {
          lastTimestamp = String(evt.timestamp);
          break;
        }
      } catch {
        /* skip malformed */
      }
    }

    const transEvents = lines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(
        (e): e is Record<string, unknown> =>
          e !== null &&
          typeof (e as Record<string, unknown>).event === 'string' &&
          ((e as Record<string, unknown>).event as string).startsWith('transition:'),
      )
      .map((e) => e.phase)
      .filter((p): p is string => typeof p === 'string');

    const uniquePhases = [...new Set(transEvents)];
    phases = uniquePhases.length > 0 ? uniquePhases.join('→') : '';
  } catch {
    eventCount = 0;
  }

  return {
    sessionId: sid,
    eventCount,
    phases: phases.length > 30 ? phases.slice(0, 27) + '...' : phases,
    age: lastTimestamp ? relativeAge(lastTimestamp) : 'unknown',
  };
}

async function inspectSingleSessionMode(
  fingerprint: string,
  sessionId: string,
  json: boolean,
): Promise<number> {
  const sd = sessionDir(fingerprint, sessionId);

  let events: Awaited<ReturnType<typeof readAuditTrail>>;
  try {
    events = await readAuditTrail(sd);
  } catch (err) {
    return exitWithError(
      `Cannot read audit trail: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (events.length === 0) {
    console.log('No audit events recorded for this session.');
    return 1;
  }

  const chain = verifyChain(events);
  const summary = generateComplianceSummary(events, sessionId, chain, new Date().toISOString());

  if (json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(formatComplianceReport(summary));
  }
  return summary.compliant ? 0 : 1;
}

async function dispatchInspect(workspace: ResolvedWorkspace, args: InspectArgs): Promise<number> {
  const { sessionId, json, upgradeCheck, iso27001Mapping, output } = args;

  if (upgradeCheck) return runUpgradeCheck(workspace, json);

  const sessions = listWorkspaceSessions(workspace.fingerprint);

  if (!sessionId) return listWorkspaceSessionsMode(workspace.fingerprint, sessions);

  if (!sessions.includes(sessionId)) {
    return exitWithError(`Session ${sessionId} not found in this workspace.`);
  }

  if (iso27001Mapping !== undefined) {
    return runIso27001Inspect({
      fingerprint: workspace.fingerprint,
      sessDir: sessionDir(workspace.fingerprint, sessionId),
      sessionId,
      mappingPath: iso27001Mapping,
      json,
      ...(output !== undefined ? { outputPath: output } : {}),
    });
  }

  return inspectSingleSessionMode(workspace.fingerprint, sessionId, json);
}

export async function inspectMain(argv: string[]): Promise<number> {
  const parsed = parseInspectArgs(argv);

  if (!parsed.ok) {
    if (parsed.error === 'help') {
      console.log(getInspectUsage());
      return 0;
    }
    return exitWithError(parsed.error);
  }

  const { sessionId, json, upgradeCheck } = parsed.args;

  if (json && !sessionId && !upgradeCheck) {
    return exitWithError('--json requires --session <id> or --upgrade-check');
  }

  let workspace: ResolvedWorkspace;
  try {
    workspace = await resolveWorkspace();
  } catch (error) {
    return resolveFailureExit(error, {
      upgradeCheck,
      json,
      ...(sessionId !== undefined ? { sessionId } : {}),
    });
  }

  return dispatchInspect(workspace, parsed.args);
}

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

import { verifyChain } from '../audit/integrity.js';
import { generateComplianceSummary, type ComplianceSummary } from '../audit/summary.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSIONS_SUBDIR = 'sessions';

// ─── Argument Parsing ─────────────────────────────────────────────────────────

export interface InspectArgs {
  readonly sessionId?: string;
  readonly json: boolean;
}

export function parseInspectArgs(
  argv: string[],
): { ok: true; args: InspectArgs } | { ok: false; error: string } {
  let sessionId: string | undefined;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) break;

    if (arg === '--session') {
      const next = argv[i + 1];
      if (!next) return { ok: false, error: '--session requires a session ID' };
      sessionId = next;
      i++;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--help' || arg === '-h') {
      return { ok: false, error: 'help' };
    } else {
      return { ok: false, error: `Unknown argument: ${arg}` };
    }
  }

  return { ok: true, args: { sessionId, json } };
}

export function getInspectUsage(): string {
  return `Usage: flowguard inspect [options]

Session compliance reporting (read-only).

Modes:
  flowguard inspect                 List all sessions in the workspace
  flowguard inspect --session <id>  Full compliance report for one session

Options:
  --session <id>  Session ID to inspect
  --json          Output ComplianceSummary as JSON (requires --session)
  -h, --help      Show this help`;
}

// ─── Session Discovery ────────────────────────────────────────────────────────

/** Resolve the workspace fingerprint for the current directory. */
async function resolveWorkspace(): Promise<string> {
  const fpResult = await computeFingerprint(process.cwd());
  return fpResult.fingerprint;
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

export async function inspectMain(argv: string[]): Promise<number> {
  const parsed = parseInspectArgs(argv);

  if (!parsed.ok) {
    if (parsed.error === 'help') {
      console.log(getInspectUsage());
      return 0;
    }
    return exitWithError(parsed.error);
  }

  const { sessionId, json } = parsed.args;

  if (json && !sessionId) {
    return exitWithError('--json requires --session <id>');
  }

  // Resolve workspace
  let fingerprint: string;
  try {
    fingerprint = await resolveWorkspace();
  } catch {
    console.log('No FlowGuard sessions found.');
    return 0;
  }

  const sessions = listWorkspaceSessions(fingerprint);

  // -- List mode
  if (!sessionId) {
    if (sessions.length === 0) {
      console.log('No sessions with audit trails found in this workspace.');
      return 0;
    }

    const summaries: Array<{ sessionId: string; eventCount: number; phases: string; age: string }> =
      [];
    for (const sid of sessions) {
      const sd = sessionDir(fingerprint, sid);
      const trailPath = auditPath(sd);
      let eventCount = 0;
      let phases = '';
      let lastTimestamp = '';

      try {
        // Load trail for basic stats only — no chain verification in list mode
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
            /* skip malformed line */
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
          .map(
            (e) =>
              // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
              (e as Record<string, unknown>).phase,
          )
          .filter((p): p is string => typeof p === 'string');

        const uniquePhases = [...new Set(transEvents)];
        phases = uniquePhases.length > 0 ? uniquePhases.join('→') : '';
      } catch {
        eventCount = 0;
      }

      summaries.push({
        sessionId: sid,
        eventCount,
        phases: phases.length > 30 ? phases.slice(0, 27) + '...' : phases,
        age: lastTimestamp ? relativeAge(lastTimestamp) : 'unknown',
      });
    }

    console.log(formatSessionList(summaries));
    return 0;
  }

  // -- Single-session mode
  if (!sessions.includes(sessionId)) {
    return exitWithError(`Session ${sessionId} not found in this workspace.`);
  }

  const sd = sessionDir(fingerprint, sessionId);

  let trailResult: Awaited<ReturnType<typeof readAuditTrail>>;
  try {
    trailResult = await readAuditTrail(sd);
  } catch (err) {
    return exitWithError(
      `Cannot read audit trail: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (trailResult.events.length === 0) {
    console.log('No audit events recorded for this session.');
    return 1;
  }

  // Verify chain
  const chain = verifyChain(trailResult.events, {
    strict: true,
  });

  // Build compliance summary
  const summary = generateComplianceSummary(
    trailResult.events,
    sessionId,
    chain,
    new Date().toISOString(),
  );

  if (json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(formatComplianceReport(summary));
  }

  return summary.compliant ? 0 : 1;
}

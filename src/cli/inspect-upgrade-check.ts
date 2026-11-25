/**
 * @module cli/inspect-upgrade-check
 * @description CLI surface for `flowguard inspect --upgrade-check`.
 *
 * Read-only pre-upgrade preflight for the current workspace. The read model and
 * classification live in `adapters/workspace/upgrade-preflight.ts`; this module
 * only renders the report and applies the exit contract: `0` when the
 * workspace is upgrade-ready, `1` when at least one blocker exists, the
 * workspace is not initialized, or the inventory cannot be determined
 * reliably.
 *
 * @version v2
 */

import {
  runUpgradePreflight,
  type UpgradeCheckReport,
  type WorkspaceIdentity,
} from '../adapters/workspace/upgrade-preflight.js';

export type { UpgradeCheckReport } from '../adapters/workspace/upgrade-preflight.js';

/**
 * Emit the structured fail-closed report for a workspace that cannot be
 * resolved at all. `--json` must stay machine-readable on this path too.
 */
export function reportWorkspaceUnresolved(json: boolean, message: string): number {
  if (json) {
    const payload: UpgradeCheckReport = {
      scope: 'workspace',
      workspaceFingerprint: null,
      upgradeReady: false,
      summary: { sessions: 0, archives: 0, blockers: 1, warnings: 0 },
      sessions: [],
      archives: [],
      findings: [
        {
          severity: 'blocker',
          code: 'WORKSPACE_UNRESOLVED',
          message: `Cannot resolve the workspace for the upgrade preflight: ${message}`,
        },
      ],
    };
    console.log(JSON.stringify(payload));
  } else {
    console.log(`[blocker] WORKSPACE_UNRESOLVED: cannot resolve the workspace (${message}).`);
  }
  return 1;
}

/** Emit a standalone blocker report for a result that fails before inventory. */
function emitStandaloneBlocker(
  identity: WorkspaceIdentity,
  json: boolean,
  code: string,
  message: string,
): number {
  if (json) {
    const payload: UpgradeCheckReport = {
      scope: 'workspace',
      workspaceFingerprint: identity.fingerprint,
      upgradeReady: false,
      summary: { sessions: 0, archives: 0, blockers: 1, warnings: 0 },
      sessions: [],
      archives: [],
      findings: [{ severity: 'blocker', code, message }],
    };
    console.log(JSON.stringify(payload));
  } else {
    console.log(`[blocker] ${code}: ${message}`);
  }
  return 1;
}

/** Run the workspace upgrade preflight. Returns the process exit code. */
export async function runUpgradeCheck(identity: WorkspaceIdentity, json: boolean): Promise<number> {
  const result = await runUpgradePreflight(identity);
  if (result.kind === 'workspace-not-initialized') {
    return emitStandaloneBlocker(
      identity,
      json,
      'WORKSPACE_NOT_INITIALIZED',
      `No initialized FlowGuard workspace for this worktree (${result.detail}).`,
    );
  }
  if (result.kind === 'workspace-identity-changed') {
    return emitStandaloneBlocker(
      identity,
      json,
      'WORKSPACE_IDENTITY_CHANGED',
      `The worktree workspace identity changed after sessions existed (${result.detail}). Resolve the previous workspace before upgrading.`,
    );
  }
  if (result.kind === 'inventory-unreadable') {
    return emitStandaloneBlocker(
      identity,
      json,
      'INVENTORY_UNREADABLE',
      `Workspace session/archive inventory cannot be determined (${result.detail}).`,
    );
  }

  const report = result.report;
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatUpgradeCheck(report));
  }
  return report.upgradeReady ? 0 : 1;
}

function formatUpgradeCheck(report: UpgradeCheckReport): string {
  const lines: string[] = [];
  lines.push(`Upgrade preflight for workspace ${report.workspaceFingerprint}`);
  lines.push('');
  lines.push(
    `Sessions: ${report.summary.sessions}  Archives: ${report.summary.archives}  ` +
      `Blockers: ${report.summary.blockers}  Warnings: ${report.summary.warnings}`,
  );
  for (const session of report.sessions) {
    lines.push(
      `  [${session.state}] ${session.sessionId} phase=${session.phase ?? '?'} ` +
        `audit=${session.audit}`,
    );
    for (const finding of session.findings)
      lines.push(`    [${finding.severity}] ${finding.message}`);
  }
  for (const archive of report.archives) {
    lines.push(
      `  [archive] ${archive.file} extractable=${archive.extractable} ` +
        `contract=${archive.currentContract}`,
    );
    for (const finding of archive.findings)
      lines.push(`    [${finding.severity}] ${finding.message}`);
  }
  lines.push('');
  lines.push(
    report.upgradeReady
      ? 'Upgrade-ready: no upgrade blockers found in this workspace.'
      : 'Not upgrade-ready: resolve the blockers above before upgrading.',
  );
  return lines.join('\n');
}

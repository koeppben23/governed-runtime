/**
 * @module cli/inspect-upgrade-check
 * @description CLI surface for `flowguard inspect --upgrade-check`.
 *
 * Read-only pre-upgrade preflight for the current workspace. The read model and
 * classification live in `adapters/workspace/upgrade-preflight.ts`; this module
 * only renders the report and applies the exit contract: `0` when the
 * workspace is upgrade-ready, `1` when at least one blocker exists or the
 * inventory cannot be determined reliably.
 *
 * @version v1
 */

import {
  runUpgradePreflight,
  type UpgradeCheckReport,
} from '../adapters/workspace/upgrade-preflight.js';

export type { UpgradeCheckReport } from '../adapters/workspace/upgrade-preflight.js';

/** Run the workspace upgrade preflight. Returns the process exit code. */
export async function runUpgradeCheck(fingerprint: string, json: boolean): Promise<number> {
  const result = await runUpgradePreflight(fingerprint);
  if (result.kind === 'inventory-unreadable') {
    if (json) {
      console.log(
        JSON.stringify({
          scope: 'workspace',
          workspaceFingerprint: fingerprint,
          upgradeReady: false,
          summary: { sessions: 0, archives: 0, blockers: 1, warnings: 0 },
          sessions: [],
          archives: [],
          findings: [
            {
              severity: 'blocker',
              code: 'INVENTORY_UNREADABLE',
              message: `Workspace session/archive inventory cannot be determined (${result.detail}).`,
            },
          ],
        }),
      );
    } else {
      console.log(
        `[blocker] INVENTORY_UNREADABLE: cannot determine the workspace inventory (${result.detail}).`,
      );
    }
    return 1;
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

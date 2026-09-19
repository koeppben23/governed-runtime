/**
 * @module cli/install-output
 * @description Console formatting for CLI results, doctor checks, and usage.
 *
 * Split from install.ts following the file-size budget; output text is
 * unchanged.
 *
 * @version v1
 */

import { formatRecoveryLines } from './install-recovery.js';
import { PACKAGE_VERSION, SHIPPED_EXECUTABLE_CHECK } from './install-types.js';
import type { CliResult, DoctorStatus, DoctorCheck, InstallPlatform } from './install-types.js';

// ─── CLI Output ───────────────────────────────────────────────────────────────

function countOps(ops: Array<{ action: string }>) {
  return {
    written: ops.filter((o) => o.action === 'written').length,
    merged: ops.filter((o) => o.action === 'merged').length,
    skipped: ops.filter((o) => o.action === 'skipped').length,
    removed: ops.filter((o) => o.action === 'removed').length,
  };
}

/** Format a CliResult for human-readable console output. */
export function formatResult(result: CliResult): string {
  const lines: string[] = [];
  const { written, merged, skipped, removed } = countOps(result.ops);

  for (const op of result.ops) {
    const suffix = op.reason ? ` (${op.reason})` : '';
    lines.push(`  [${op.action}] ${op.path}${suffix}`);
  }

  lines.push('');
  if (written > 0) lines.push(`  Written: ${written} files`);
  if (merged > 0) lines.push(`  Merged:  ${merged} files`);
  if (skipped > 0) lines.push(`  Skipped: ${skipped} files`);
  if (removed > 0) lines.push(`  Removed: ${removed} files`);

  for (const w of result.warnings) {
    lines.push(`  [warn] ${w}`);
  }

  for (const n of result.notices ?? []) {
    const tag = n.kind === 'next' ? 'next' : 'status';
    lines.push(`  [${tag}] ${n.message}`);
  }

  formatResultErrors(result, lines);

  return lines.join('\n');
}

function formatResultErrors(result: CliResult, lines: string[]): void {
  if (result.errors.length === 0) return;
  lines.push('');
  for (const err of result.errors) {
    lines.push(`  [error] ${err}`);
  }
  lines.push('');
  lines.push('  Recovery plan:');
  const details = result.errorDetails ?? [];
  if (details.length > 0) {
    lines.push(...formatRecoveryLines(details));
  } else {
    lines.push('    flowguard doctor          → diagnose remaining issues');
    lines.push('    flowguard install --force → repair incomplete install');
    lines.push('    flowguard uninstall       → remove FlowGuard completely');
  }
}

function computeOverallStatus(
  actionableChecks: DoctorCheck[],
  infoChecks: DoctorCheck[],
  warnCount: number,
): string {
  const actionable = actionableChecks.length;
  if (actionable === 0) return 'NOT_VERIFIED';
  if (actionableChecks.some((c) => c.status !== 'ok' && c.status !== 'warn')) return 'NOT_VERIFIED';
  if (warnCount > 0) return 'HEALTHY_WITH_WARNINGS';
  return 'HEALTHY';
}

/** Format doctor check results for console output. */
export function formatDoctor(checks: DoctorCheck[], host: InstallPlatform): string {
  const hostNames: Record<InstallPlatform, string> = {
    opencode: 'OpenCode',
    'claude-code': 'Claude Code',
    codex: 'Codex',
  };
  const hostName = hostNames[host] ?? host;
  const lines: string[] = [];
  const iconMap: Record<DoctorStatus, string> = {
    ok: 'ok',
    missing: 'MISSING',
    modified: 'MODIFIED',
    unmanaged: 'UNMANAGED',
    version_mismatch: 'VERSION',
    instruction_missing: 'INSTR_MISSING',
    error: 'ERROR',
    warn: 'WARN',
    info: 'NOTE',
  };

  const actionableChecks = checks.filter((c) => c.status !== 'info');
  const infoChecks = checks.filter((c) => c.status === 'info');

  for (const check of actionableChecks) {
    const suffix = check.detail ? ` — ${check.detail}` : '';
    lines.push(`  [${iconMap[check.status]}] ${check.file}${suffix}`);
  }

  if (infoChecks.length > 0) {
    lines.push('');
    lines.push('  Platform characteristics:');
    lines.push('    (see docs/platform-limitations.md for details)');
    for (const check of infoChecks) {
      lines.push(`    [NOTE] ${check.file} — ${check.detail ?? ''}`);
    }
  }

  const ok = actionableChecks.filter((c) => c.status === 'ok').length;
  const warn = actionableChecks.filter((c) => c.status === 'warn').length;
  const actionable = actionableChecks.length;
  const overall = computeOverallStatus(actionableChecks, infoChecks, warn);

  lines.push('');
  lines.push(`  Status: ${overall}`);
  lines.push(`  ${ok}/${actionable} actionable checks passed`);

  if (infoChecks.length > 0) {
    lines.push(`  ${infoChecks.length} platform characteristic(s)`);
  }

  if (warn > 0) appendWarningSummary(checks, lines, hostName, warn);
  if (actionable === 0 || actionableChecks.some((c) => c.status !== 'ok' && c.status !== 'warn')) {
    lines.push(
      `  Next: \`flowguard install --force\` to repair, or \`flowguard doctor\` after fixing`,
    );
  }

  return lines.join('\n');
}

function appendWarningSummary(
  checks: DoctorCheck[],
  lines: string[],
  hostName: string,
  warnCount: number,
): void {
  const binaryWarns = checks.filter(
    (c) => c.status === 'warn' && c.check === SHIPPED_EXECUTABLE_CHECK,
  ).length;
  lines.push(`  ${warnCount} warning(s)`);
  if (binaryWarns > 0)
    lines.push(
      `  ${binaryWarns} shipped-executable warning(s) — repair via \`flowguard install --force\` and re-run \`flowguard doctor\``,
    );
  const otherWarns = warnCount - binaryWarns;
  if (otherWarns > 0)
    lines.push(
      `  ${otherWarns} trust/context warning(s) for ${hostName} — review check details above and re-run \`flowguard doctor\``,
    );
}

export function getUsage(): string {
  const v = PACKAGE_VERSION();
  return `\
Usage: flowguard <command> [options]

Commands:
  install     Install FlowGuard tools, plugins, and commands
  uninstall   Remove FlowGuard files
  doctor      Verify installation is correct and complete
  inspect     Show session compliance status (read-only)
  run         Execute FlowGuard commands in headless mode
  serve       Start a supported host server for headless operation

Options:
  --install-scope  Where to install: global (default) or repo
  --platform       Install host platform: opencode (default), claude-code, or codex
  --host           Alias for --platform during install; runtime host for run/serve
  --policy-mode    FlowGuard policy: team (default), solo, team-ci, regulated
  --force          Overwrite all managed artifacts
  --core-tarball   Path to flowguard-core-{version}.tgz (required for install)
  --checksums-file Path to checksums.sha256 (defaults to tarball-adjacent checksums.sha256)
  --allow-unverified-tarball
                   Supply-chain opt-out: install without tarball integrity verification (not recommended)

Examples:
  npx --package ./flowguard-core-${v}.tgz flowguard install --core-tarball ./flowguard-core-${v}.tgz
  npx --package ./flowguard-core-${v}.tgz flowguard install --core-tarball ./flowguard-core-${v}.tgz --install-scope repo --policy-mode regulated
  npx --package ./flowguard-core-${v}.tgz flowguard doctor
  npx --package ./flowguard-core-${v}.tgz flowguard uninstall
  flowguard run --host opencode -- "Run /hydrate policyMode=team-ci"
  flowguard run --host claude-code -- "Run /validate"
  flowguard run --host codex -- "Run /status"
  flowguard serve --host opencode --port 4096
`;
}

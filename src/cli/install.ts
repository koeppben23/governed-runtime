#!/usr/bin/env node
/**
 * @module cli/install
 * @description Executable FlowGuard CLI facade.
 *
 * Install, uninstall, and doctor behavior live in cohesive command modules.
 * This file preserves the public CLI entrypoint and compatibility exports.
 */

import { realpathSync } from 'node:fs';
import { initCliLogger } from './cli-logging.js';
import { doctor } from './doctor-command.js';
import { install } from './install-command.js';
import { uninstall } from './uninstall-command.js';
import { resetAdapterLogger } from '../logging/adapter-logger.js';
import { HOST_IDS } from '../shared/hosts.js';
import {
  type InstallScope,
  type InstallPlatform,
  type PolicyMode,
  type CliAction,
  type CliArgs,
  type CliResult,
  type DoctorStatus,
  type DoctorCheck,
  PACKAGE_VERSION,
  resolveTarget,
} from './install-helpers.js';

// ─── Re-exports for backward compatibility ─────────────────────────────────
export {
  type InstallScope,
  type InstallPlatform,
  type PolicyMode,
  type CliAction,
  type CliArgs,
  type FileOp,
  type CliResult,
  type DoctorStatus,
  type DoctorCheck,
} from './install-helpers.js';
export {
  resolveTarget,
  sha256,
  computeMandatesDigest,
  mergeReviewerTaskPermission,
  hasNonFlowGuardInstructions,
  resolveOpencodeConfigPath,
  FLOWGUARD_INSTRUCTION_ENTRIES,
} from './install-helpers.js';
export { checkLastSessionHandshake, checkPluginActivation, doctor } from './doctor-command.js';
export { detectPackageManager, install } from './install-command.js';
export { uninstall } from './uninstall-command.js';

// ─── Argument Parsing ─────────────────────────────────────────────────────────

const VALID_POLICY_MODES: readonly PolicyMode[] = ['solo', 'team', 'team-ci', 'regulated'] as const;
const VALID_SCOPES: readonly InstallScope[] = ['global', 'repo'] as const;
const VALID_PLATFORMS: readonly InstallPlatform[] = HOST_IDS;
const VALID_ACTIONS: readonly CliAction[] = [
  'install',
  'uninstall',
  'doctor',
  'run',
  'serve',
] as const;

/**
 * Parse CLI arguments from process.argv.
 *
 * Supports both new flags (--install-scope, --policy-mode) and deprecated
 * aliases (--global, --project, --mode) with warnings.
 *
 * @param argv - Raw argv (typically process.argv.slice(2)).
 * @returns Parsed arguments and deprecation warnings, or null if invalid.
 */
export function parseArgs(argv: string[]): { args: CliArgs; deprecations: string[] } | null {
  const action = argv[0] as CliAction | undefined;
  if (!action || !VALID_ACTIONS.includes(action)) {
    return null;
  }

  let installScope: InstallScope = 'global';
  let installPlatform: InstallPlatform = 'opencode';
  let policyMode: PolicyMode = 'solo';
  let force = false;
  let coreTarball: string | undefined;
  let checksumsFile: string | undefined;
  let logMode: 'file' | 'console' | 'file+console' | undefined;
  const deprecations: string[] = [];

  if (action === 'run' || action === 'serve') {
    return {
      args: {
        action,
        installScope,
        installPlatform,
        policyMode,
        force,
      },
      deprecations,
    };
  }

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) return null;

    switch (arg) {
      // ── New flags ──────────────────────────────────────────
      case '--install-scope': {
        const next = argv[i + 1];
        if (next && VALID_SCOPES.includes(next as InstallScope)) {
          installScope = next as InstallScope;
          i++;
        } else {
          return null;
        }
        break;
      }
      case '--platform':
      case '--host': {
        const next = argv[i + 1];
        if (next && VALID_PLATFORMS.includes(next as InstallPlatform)) {
          installPlatform = next as InstallPlatform;
          i++;
        } else {
          return null;
        }
        break;
      }
      case '--policy-mode': {
        const next = argv[i + 1];
        if (next && VALID_POLICY_MODES.includes(next as PolicyMode)) {
          policyMode = next as PolicyMode;
          i++;
        } else {
          return null;
        }
        break;
      }
      case '--force':
        force = true;
        break;
      case '--core-tarball': {
        const next = argv[i + 1];
        if (next) {
          coreTarball = next;
          i++;
        } else {
          return null;
        }
        break;
      }
      case '--checksums-file': {
        const next = argv[i + 1];
        if (next) {
          checksumsFile = next;
          i++;
        } else {
          return null;
        }
        break;
      }
      case '--log-mode': {
        const next = argv[i + 1];
        if (next && (next === 'file' || next === 'console' || next === 'file+console')) {
          logMode = next;
          i++;
        } else {
          return null;
        }
        break;
      }

      // ── Deprecated aliases ─────────────────────────────────
      case '--global':
        installScope = 'global';
        deprecations.push('--global is deprecated, use --install-scope global');
        break;
      case '--project':
        installScope = 'repo';
        deprecations.push('--project is deprecated, use --install-scope repo');
        break;
      case '--mode': {
        const next = argv[i + 1];
        if (next && VALID_POLICY_MODES.includes(next as PolicyMode)) {
          policyMode = next as PolicyMode;
          deprecations.push('--mode is deprecated, use --policy-mode');
          i++;
        } else {
          return null;
        }
        break;
      }

      default:
        // Unknown argument
        return null;
    }
  }

  return {
    args: {
      action,
      installScope,
      installPlatform,
      policyMode,
      force,
      coreTarball,
      checksumsFile,
      logMode,
    },
    deprecations,
  };
}

// ─── CLI Entry Point ──────────────────────────────────────────────────────────

/**
 * Format a CliResult for human-readable console output.
 */
export function formatResult(result: CliResult): string {
  const lines: string[] = [];
  const written = result.ops.filter((o) => o.action === 'written').length;
  const merged = result.ops.filter((o) => o.action === 'merged').length;
  const skipped = result.ops.filter((o) => o.action === 'skipped').length;
  const removed = result.ops.filter((o) => o.action === 'removed').length;

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

  if (result.errors.length > 0) {
    lines.push('');
    for (const err of result.errors) {
      lines.push(`  [error] ${err}`);
    }
    lines.push('');
    lines.push('  Recovery plan:');
    lines.push('    flowguard doctor          → diagnose remaining issues');
    lines.push('    flowguard install --force → repair incomplete install');
    lines.push('    flowguard uninstall       → remove FlowGuard completely');
  }

  return lines.join('\n');
}

/**
 * Format doctor check results for console output.
 */
export function formatDoctor(checks: DoctorCheck[]): string {
  const lines: string[] = [];
  const iconMap: Record<DoctorStatus, string> = {
    ok: 'ok',
    missing: 'MISSING',
    modified: 'MODIFIED',
    unmanaged: 'UNMANAGED',
    version_mismatch: 'VERSION',
    instruction_missing: 'INSTR_MISSING',
    instruction_stale: 'INSTR_STALE',
    error: 'ERROR',
    warn: 'WARN',
  };

  for (const check of checks) {
    const suffix = check.detail ? ` — ${check.detail}` : '';
    lines.push(`  [${iconMap[check.status]}] ${check.file}${suffix}`);
  }

  const ok = checks.filter((c) => c.status === 'ok').length;
  const total = checks.length;
  lines.push('');
  lines.push(`  ${ok}/${total} checks passed`);

  return lines.join('\n');
}

function getUsage(): string {
  const v = PACKAGE_VERSION();
  return `\
Usage: flowguard <command> [options]

Commands:
  install     Install FlowGuard tools, plugins, and commands
  uninstall   Remove FlowGuard files
  doctor      Verify installation is correct and complete
  run         Execute FlowGuard commands in headless mode
  serve       Start a supported host server for headless operation

Options:
  --install-scope  Where to install: global (default) or repo
  --platform       Install host platform: opencode (default), claude-code, or codex
  --host           Alias for --platform during install; runtime host for run/serve
  --policy-mode    FlowGuard policy: solo (default), team, team-ci, regulated
  --force          Overwrite all managed artifacts
  --core-tarball   Path to flowguard-core-{version}.tgz (required for install)
  --checksums-file Path to checksums.sha256 for opt-in tarball integrity verification

Deprecated (still work):
  --global    → --install-scope global
  --project   → --install-scope repo
  --mode X    → --policy-mode X

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

/**
 * CLI main entry point.
 * Only executes when this file is run directly (not when imported for testing).
 */
export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);

  if (!parsed) {
    console.log(getUsage());
    return 1;
  }

  const { args, deprecations } = parsed;

  const cliLog = initCliLogger(
    resolveTarget(args.installScope, args.installPlatform ?? 'opencode'),
    args.logMode ?? 'console',
  );

  for (const d of deprecations) {
    console.error(`  [deprecated] ${d}`);
  }

  cliLog.info('cli', 'command_started', {
    action: args.action,
    installScope: args.installScope,
    policyMode: args.policyMode,
    force: args.force,
    logMode: args.logMode,
  });

  try {
    switch (args.action) {
      case 'install': {
        const result = await install(args);
        const targetLabel = args.installScope === 'global' ? '~/.config/opencode/' : './.opencode/';
        console.log(`Installing FlowGuard to ${targetLabel}...`);
        console.log(`  Install scope: ${args.installScope}`);
        console.log(`  Platform: ${args.installPlatform ?? 'opencode'}`);
        console.log(`  Policy mode: ${args.policyMode}`);
        console.log('');
        console.log(formatResult(result));
        if (result.errors.length > 0) {
          cliLog.warn('cli', 'install had errors', { errorCount: result.errors.length });
          return 1;
        }
        cliLog.info('cli', 'install completed', { filesWritten: result.ops.length });
        return 0;
      }

      case 'uninstall': {
        const targetLabel = args.installScope === 'global' ? '~/.config/opencode/' : './.opencode/';
        const result = await uninstall(args);
        console.log(`Uninstalling FlowGuard from ${targetLabel}...`);
        console.log('');
        console.log(formatResult(result));
        cliLog.info('cli', 'uninstall completed', { filesRemoved: result.ops.length });
        return result.errors.length > 0 ? 1 : 0;
      }

      case 'doctor': {
        const targetLabel = args.installScope === 'global' ? '~/.config/opencode/' : './.opencode/';
        const checks = await doctor(args);
        console.log(`Checking FlowGuard installation at ${targetLabel}...`);
        console.log('');
        console.log(formatDoctor(checks));
        const hasFailure = checks.some((c) => c.status !== 'ok' && c.status !== 'warn');
        cliLog.info('cli', 'doctor completed', {
          totalChecks: checks.length,
          hasFailure,
        });
        return hasFailure ? 1 : 0;
      }

      case 'run': {
        const { runMain } = await import('./run.js');
        return runMain(argv.slice(1));
      }

      case 'serve': {
        const { serveMain } = await import('./run.js');
        return serveMain(argv.slice(1));
      }
    }
  } finally {
    resetAdapterLogger();
  }
}

// Auto-run when executed directly.
// realpathSync resolves symlinks so that both `flowguard` (symlink) and
// `install.js` (direct) executions trigger main().
const isDirectExecution =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]).endsWith('install.js');

if (isDirectExecution) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}

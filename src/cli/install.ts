#!/usr/bin/env node
/**
 * @module cli/install
 * @description Executable FlowGuard CLI facade.
 *
 * Install, uninstall, and doctor behavior live in cohesive command modules.
 * This file preserves the public CLI entrypoint and compatibility exports.
 */

import { realpathSync } from 'node:fs';
import { relative } from 'node:path';
import { initCliLogger } from './cli-logging.js';
import { doctor } from './doctor-command.js';
import { install } from './install-command.js';
import { uninstall } from './uninstall-command.js';
import { resetAdapterLogger } from '../logging/adapter-logger.js';
import type { FlowGuardLogger } from '../logging/logger.js';
import { HOST_IDS } from '../shared/hosts.js';
import { POLICY_MODES } from '../state/policy-mode.js';
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
  SHIPPED_EXECUTABLE_CHECK,
  resolvePackageRoot,
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
export { doctor } from './doctor-command.js';
export { checkLastSessionHandshake } from './doctor-handshake.js';
export { checkPluginActivation } from './doctor-plugin.js';
export { checkShippedExecutables } from './doctor-executables.js';
export { detectPackageManager, install } from './install-command.js';
export { uninstall } from './uninstall-command.js';

// ─── Argument Parsing ─────────────────────────────────────────────────────────

const VALID_POLICY_MODES: readonly PolicyMode[] = POLICY_MODES;
const VALID_SCOPES: readonly InstallScope[] = ['global', 'repo'] as const;
const VALID_PLATFORMS: readonly InstallPlatform[] = HOST_IDS;
const VALID_ACTIONS: readonly CliAction[] = [
  'install',
  'uninstall',
  'doctor',
  'run',
  'serve',
  'inspect',
] as const;

interface ParseState {
  installScope: InstallScope;
  installPlatform: InstallPlatform;
  policyMode: PolicyMode;
  force: boolean;
  coreTarball: string | undefined;
  checksumsFile: string | undefined;
  allowUnverifiedTarball: boolean;
  logMode: 'file' | 'console' | 'file+console' | undefined;
}

function initialParseState(): ParseState {
  return {
    installScope: 'global',
    installPlatform: 'opencode',
    // Fail-closed default: a fresh install is human-gated (team) unless the
    // operator passes --policy-mode solo|team-ci for auto-approve behavior.
    policyMode: 'team',
    force: false,
    coreTarball: undefined,
    checksumsFile: undefined,
    allowUnverifiedTarball: false,
    logMode: undefined,
  };
}

function readNextValue(argv: string[], i: number): string | null {
  const next = argv[i + 1];
  return next ? next : null;
}

function isValidScope(value: string): value is InstallScope {
  return VALID_SCOPES.includes(value as InstallScope);
}
function isValidPlatform(value: string): value is InstallPlatform {
  return VALID_PLATFORMS.includes(value as InstallPlatform);
}
function isValidPolicyMode(value: string): value is PolicyMode {
  return VALID_POLICY_MODES.includes(value as PolicyMode);
}
function isValidLogMode(value: string): value is 'file' | 'console' | 'file+console' {
  return value === 'file' || value === 'console' || value === 'file+console';
}

function trySetInstallScope(st: ParseState, value: string | null): boolean {
  if (value && isValidScope(value)) {
    st.installScope = value;
    return true;
  }
  return false;
}
function trySetPlatform(st: ParseState, value: string | null): boolean {
  if (value && isValidPlatform(value)) {
    st.installPlatform = value;
    return true;
  }
  return false;
}
function trySetPolicyMode(st: ParseState, value: string | null): boolean {
  if (value && isValidPolicyMode(value)) {
    st.policyMode = value;
    return true;
  }
  return false;
}
function trySetTarball(st: ParseState, value: string | null): boolean {
  if (value) {
    st.coreTarball = value;
    return true;
  }
  return false;
}
function trySetChecksums(st: ParseState, value: string | null): boolean {
  if (value) {
    st.checksumsFile = value;
    return true;
  }
  return false;
}
function trySetLogMode(st: ParseState, value: string | null): boolean {
  if (value && isValidLogMode(value)) {
    st.logMode = value;
    return true;
  }
  return false;
}
function trySetDeprecatedMode(st: ParseState, deps: string[], value: string | null): boolean {
  if (value && isValidPolicyMode(value)) {
    st.policyMode = value;
    deps.push('--mode is deprecated, use --policy-mode');
    return true;
  }
  return false;
}

function handleValueFlag(
  st: ParseState,
  deps: string[],
  flag: string,
  value: string | null,
): boolean {
  switch (flag) {
    case '--install-scope':
      return trySetInstallScope(st, value);
    case '--platform':
    case '--host':
      return trySetPlatform(st, value);
    case '--policy-mode':
      return trySetPolicyMode(st, value);
    case '--core-tarball':
      return trySetTarball(st, value);
    case '--checksums-file':
      return trySetChecksums(st, value);
    case '--log-mode':
      return trySetLogMode(st, value);
    case '--mode':
      return trySetDeprecatedMode(st, deps, value);
  }
  return false;
}

function parseOneArg(
  st: ParseState,
  deps: string[],
  arg: string,
  argv: string[],
  i: number,
): number {
  const valueFlags = new Set([
    '--install-scope',
    '--platform',
    '--host',
    '--policy-mode',
    '--core-tarball',
    '--checksums-file',
    '--log-mode',
  ]);

  if (valueFlags.has(arg) || arg === '--mode') {
    const value = readNextValue(argv, i);
    if (!handleValueFlag(st, deps, arg, value)) return -1;
    return 2;
  }

  switch (arg) {
    case '--force':
      st.force = true;
      return 1;
    case '--allow-unverified-tarball':
      st.allowUnverifiedTarball = true;
      return 1;
    case '--global':
      st.installScope = 'global';
      deps.push('--global is deprecated, use --install-scope global');
      return 1;
    case '--project':
      st.installScope = 'repo';
      deps.push('--project is deprecated, use --install-scope repo');
      return 1;
    default:
      return -1;
  }
}

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

  if (action === 'run' || action === 'serve' || action === 'inspect') {
    return {
      args: {
        action,
        installScope: 'global',
        installPlatform: 'opencode',
        policyMode: 'team',
        force: false,
      },
      deprecations: [],
    };
  }

  const st = initialParseState();
  const deprecations: string[] = [];

  for (let i = 1; i < argv.length;) {
    const arg = argv[i];
    if (arg === undefined) return null;
    const advance = parseOneArg(st, deprecations, arg, argv, i);
    if (advance < 0) return null;
    i += advance;
  }

  if (st.checksumsFile && st.allowUnverifiedTarball) {
    return null;
  }

  return {
    args: {
      action,
      installScope: st.installScope,
      installPlatform: st.installPlatform,
      policyMode: st.policyMode,
      force: st.force,
      coreTarball: st.coreTarball,
      checksumsFile: st.checksumsFile,
      allowUnverifiedTarball: st.allowUnverifiedTarball,
      logMode: st.logMode,
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
  inspect     Show session compliance status (read-only)
  run         Execute FlowGuard commands in headless mode
  serve       Start a supported host server for headless operation

Options:
  --install-scope  Where to install: global (default) or repo
  --platform       Install host platform: opencode (default), claude-code, or codex
  --host           Alias for --platform during install; runtime host for run/serve
  --policy-mode    FlowGuard policy: solo (default), team, team-ci, regulated
  --force          Overwrite all managed artifacts
  --core-tarball   Path to flowguard-core-{version}.tgz (required for install)
  --checksums-file Path to checksums.sha256 (defaults to tarball-adjacent checksums.sha256)
  --allow-unverified-tarball
                   Supply-chain opt-out: install without tarball integrity verification (not recommended)

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
 * Boundary-only diagnostics for shipped-executable validation (#423).
 *
 * doctor (rails) returns structured checks; the CLI closure is the only logger
 * writer. Emit one `error` per failing shipped executable so a broken/missing
 * runtime binary is visible in logs. Logs the package-relative path (never the
 * absolute path) and no env/secret values; control flow is unaffected (the
 * non-zero exit is decided by the caller's failure check).
 */
function logShippedExecutableFailures(checks: DoctorCheck[], cliLog: FlowGuardLogger): void {
  const packageRoot = resolvePackageRoot();
  for (const c of checks) {
    if (c.check === SHIPPED_EXECUTABLE_CHECK && c.status !== 'ok' && c.status !== 'warn') {
      cliLog.error('cli', 'shipped executable invalid', {
        path: relative(packageRoot, c.file).replace(/\\/g, '/'),
        check: c.check,
        status: c.status,
      });
    }
  }
}

async function executeInstallAction(args: CliArgs, cliLog: FlowGuardLogger): Promise<number> {
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

async function executeUninstallAction(args: CliArgs, cliLog: FlowGuardLogger): Promise<number> {
  const targetLabel = args.installScope === 'global' ? '~/.config/opencode/' : './.opencode/';
  const result = await uninstall(args);
  console.log(`Uninstalling FlowGuard from ${targetLabel}...`);
  console.log('');
  console.log(formatResult(result));
  cliLog.info('cli', 'uninstall completed', { filesRemoved: result.ops.length });
  return result.errors.length > 0 ? 1 : 0;
}

async function executeDoctorAction(args: CliArgs, cliLog: FlowGuardLogger): Promise<number> {
  const targetLabel = args.installScope === 'global' ? '~/.config/opencode/' : './.opencode/';
  const checks = await doctor(args);
  console.log(`Checking FlowGuard installation at ${targetLabel}...`);
  console.log('');
  console.log(formatDoctor(checks));
  const hasFailure = checks.some((c) => c.status !== 'ok' && c.status !== 'warn');
  logShippedExecutableFailures(checks, cliLog);
  cliLog.info('cli', 'doctor completed', {
    totalChecks: checks.length,
    hasFailure,
  });
  return hasFailure ? 1 : 0;
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
      case 'install':
        return executeInstallAction(args, cliLog);

      case 'uninstall':
        return executeUninstallAction(args, cliLog);

      case 'doctor':
        return executeDoctorAction(args, cliLog);

      case 'run': {
        const { runMain } = await import('./run.js');
        return runMain(argv.slice(1));
      }

      case 'serve': {
        const { serveMain } = await import('./run.js');
        return serveMain(argv.slice(1));
      }

      case 'inspect': {
        const { inspectMain } = await import('./inspect-command.js');
        return inspectMain(argv.slice(1));
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

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
import type { CliParseResult } from './parse-result.js';
import { formatTargetPath } from './install-helpers.js';
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
  formatTargetPath,
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

function validateAndSetScope(st: ParseState, value: string): string | true {
  if (!isValidScope(value)) return `Invalid install scope: ${value}`;
  st.installScope = value;
  return true;
}

function validateAndSetPlatform(st: ParseState, value: string): string | true {
  if (!isValidPlatform(value)) return `Invalid platform: ${value}`;
  st.installPlatform = value;
  return true;
}

function validateAndSetPolicyMode(
  st: ParseState,
  deps: string[],
  flag: string,
  value: string,
): string | true {
  if (!isValidPolicyMode(value)) return `Invalid policy mode: ${value}`;
  if (flag === '--mode') {
    st.policyMode = value;
    deps.push('--mode is deprecated, use --policy-mode');
  } else {
    st.policyMode = value;
  }
  return true;
}

function validateAndSetLogMode(st: ParseState, value: string): string | true {
  if (!isValidLogMode(value)) return `Invalid log mode: ${value}`;
  st.logMode = value;
  return true;
}

function validateAndSetTarball(st: ParseState, value: string): true {
  st.coreTarball = value;
  return true;
}

function validateAndSetChecksums(st: ParseState, value: string): true {
  st.checksumsFile = value;
  return true;
}

function handleValueFlag(
  st: ParseState,
  deps: string[],
  flag: string,
  value: string | null,
): string | true {
  if (value === null) return `${flag} requires a value`;

  switch (flag) {
    case '--install-scope':
      return validateAndSetScope(st, value);
    case '--platform':
    case '--host':
      return validateAndSetPlatform(st, value);
    case '--policy-mode':
    case '--mode':
      return validateAndSetPolicyMode(st, deps, flag, value);
    case '--core-tarball':
      return validateAndSetTarball(st, value);
    case '--checksums-file':
      return validateAndSetChecksums(st, value);
    case '--log-mode':
      return validateAndSetLogMode(st, value);
  }
  return `Unknown option: ${flag}`;
}

function parseOneArg(
  st: ParseState,
  deps: string[],
  arg: string,
  argv: string[],
  i: number,
): number | string {
  if (arg === '--help' || arg === '-h') return -2;

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
    const result = handleValueFlag(st, deps, arg, value);
    if (result !== true) return result;
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

function buildArgs(action: CliAction, st: ParseState): CliArgs {
  return {
    action,
    installScope: st.installScope,
    installPlatform: st.installPlatform,
    policyMode: st.policyMode,
    force: st.force,
    coreTarball: st.coreTarball,
    checksumsFile: st.checksumsFile,
    allowUnverifiedTarball: st.allowUnverifiedTarball,
    logMode: st.logMode,
  };
}

function makeDelegatedResult(
  action: string,
): CliParseResult<{ args: CliArgs; deprecations: string[] }> {
  return {
    kind: 'ok',
    value: {
      args: {
        action: action as CliAction,
        installScope: 'global',
        installPlatform: 'opencode',
        policyMode: 'team',
        force: false,
      },
      deprecations: [],
    },
  };
}

function parseInstallArgs(
  action: CliAction,
  argv: string[],
): CliParseResult<{ args: CliArgs; deprecations: string[] }> {
  const st = initialParseState();
  const deprecations: string[] = [];

  for (let i = 1; i < argv.length;) {
    const arg = argv[i];
    if (arg === undefined) return { kind: 'error', error: 'Unexpected empty argument' };
    const advance = parseOneArg(st, deprecations, arg, argv, i);
    if (advance === -2) return { kind: 'help' };
    if (typeof advance === 'string')
      return { kind: 'error', error: advance, hint: 'Use --help for usage' };
    if (advance < 0)
      return { kind: 'error', error: `Unknown option: ${arg}`, hint: 'Use --help for usage' };
    i += advance;
  }

  if (st.checksumsFile && st.allowUnverifiedTarball) {
    return {
      kind: 'error',
      error: '--checksums-file and --allow-unverified-tarball are mutually exclusive',
    };
  }

  return { kind: 'ok', value: { args: buildArgs(action, st), deprecations } };
}

/** Parse CLI arguments from process.argv. */
export function parseArgs(
  argv: string[],
): CliParseResult<{ args: CliArgs; deprecations: string[] }> {
  const action = argv[0];
  if (action === '--help' || action === '-h') {
    return { kind: 'help' };
  }
  if (!action || !VALID_ACTIONS.includes(action as CliAction)) {
    return {
      kind: 'error',
      error: action ? `Unknown command: ${action}` : 'No command specified',
      hint: 'Use --help for usage',
    };
  }

  if (action === 'run' || action === 'serve' || action === 'inspect') {
    return makeDelegatedResult(action);
  }

  return parseInstallArgs(action as CliAction, argv);
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
    instruction_stale: 'INSTR_STALE',
    error: 'ERROR',
    warn: 'WARN',
  };

  for (const check of checks) {
    const suffix = check.detail ? ` — ${check.detail}` : '';
    lines.push(`  [${iconMap[check.status]}] ${check.file}${suffix}`);
  }

  const ok = checks.filter((c) => c.status === 'ok').length;
  const warn = checks.filter((c) => c.status === 'warn').length;
  const total = checks.length;

  let overall: string;
  if (total === 0) {
    overall = 'NOT_VERIFIED';
  } else if (checks.some((c) => c.status !== 'ok' && c.status !== 'warn')) {
    overall = 'NOT_VERIFIED';
  } else if (warn > 0) {
    overall = 'HEALTHY_WITH_WARNINGS';
  } else {
    overall = 'HEALTHY';
  }

  lines.push('');
  lines.push(`  Status: ${overall}`);
  lines.push(`  ${ok}/${total} checks passed`);

  if (warn > 0) {
    const activationWarns = checks.filter(
      (c) => c.status === 'warn' && c.check === SHIPPED_EXECUTABLE_CHECK,
    ).length;
    lines.push(`  ${warn} warning(s)`);
    if (activationWarns > 0) {
      lines.push(
        `  ${activationWarns} shipped-executable warning(s) — restart ${hostName} and re-run \`flowguard doctor\``,
      );
    }
    const otherWarns = warn - activationWarns;
    if (otherWarns > 0) {
      lines.push(
        `  ${otherWarns} trust/context warning(s) for ${hostName} — review check details above and re-run \`flowguard doctor\``,
      );
    }
  }
  if (total === 0 || checks.some((c) => c.status !== 'ok' && c.status !== 'warn')) {
    lines.push(
      `  Next: \`flowguard install --force\` to repair, or \`flowguard doctor\` after fixing`,
    );
  }

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
  --policy-mode    FlowGuard policy: team (default), solo, team-ci, regulated
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
  const platform = args.installPlatform ?? 'opencode';
  const target = resolveTarget(args.installScope, platform);
  const displayTarget = formatTargetPath(target, args.installScope, process.cwd());
  const hostNames: Record<InstallPlatform, string> = {
    opencode: 'OpenCode',
    'claude-code': 'Claude Code',
    codex: 'Codex',
  };
  const hostName = hostNames[platform] ?? platform;
  const result = await install(args);
  console.log(`Installing FlowGuard for ${hostName} at ${displayTarget}...`);
  console.log(`  Install scope: ${args.installScope}`);
  console.log(`  Platform: ${platform}`);
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
  const platform = args.installPlatform ?? 'opencode';
  const target = resolveTarget(args.installScope, platform);
  const displayTarget = formatTargetPath(target, args.installScope, process.cwd());
  const hostNames: Record<InstallPlatform, string> = {
    opencode: 'OpenCode',
    'claude-code': 'Claude Code',
    codex: 'Codex',
  };
  const hostName = hostNames[platform] ?? platform;
  const result = await uninstall(args);
  console.log(`Uninstalling FlowGuard for ${hostName} from ${displayTarget}...`);
  console.log('');
  console.log(formatResult(result));
  cliLog.info('cli', 'uninstall completed', { filesRemoved: result.ops.length });
  return result.errors.length > 0 ? 1 : 0;
}

async function executeDoctorAction(args: CliArgs, cliLog: FlowGuardLogger): Promise<number> {
  const platform = args.installPlatform ?? 'opencode';
  const target = resolveTarget(args.installScope, platform);
  const displayTarget = formatTargetPath(target, args.installScope, process.cwd());
  const hostNames: Record<InstallPlatform, string> = {
    opencode: 'OpenCode',
    'claude-code': 'Claude Code',
    codex: 'Codex',
  };
  const hostName = hostNames[platform] ?? platform;
  const checks = await doctor(args);
  console.log(`Checking FlowGuard for ${hostName} at ${displayTarget}...`);
  console.log('');
  console.log(formatDoctor(checks, platform));
  const hasFailure =
    checks.length === 0 || checks.some((c) => c.status !== 'ok' && c.status !== 'warn');
  logShippedExecutableFailures(checks, cliLog);
  cliLog.info('cli', 'doctor completed', {
    totalChecks: checks.length,
    hasFailure,
  });
  return hasFailure ? 1 : 0;
}

async function executeAction(
  action: CliAction,
  args: CliArgs,
  argv: string[],
  cliLog: FlowGuardLogger,
): Promise<number> {
  switch (action) {
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
}

/**
 * CLI main entry point.
 * Only executes when this file is run directly (not when imported for testing).
 */
export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);

  if (parsed.kind === 'help') {
    console.log(getUsage());
    return 0;
  }

  if (parsed.kind === 'error') {
    console.error(`[error] ${parsed.error}`);
    if (parsed.hint) console.error(parsed.hint);
    console.error(getUsage());
    return 2;
  }

  const { args, deprecations } = parsed.value;

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
    return executeAction(args.action, args, argv, cliLog);
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

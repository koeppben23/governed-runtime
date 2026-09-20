/**
 * @module cli/install-execute
 * @description CLI action dispatch for install/uninstall/doctor plus delegated
 * run/serve/inspect commands.
 *
 * Split from install.ts following the file-size budget; dispatch behavior is
 * unchanged.
 *
 * @version v1
 */

import { relative } from 'node:path';
import type { FlowGuardLogger } from '../logging/logger.js';
import { doctor } from './doctor-command.js';
import { install } from './install-command.js';
import { detectInstalledArtifacts, formatTargetPath, resolveTarget } from './install-helpers.js';
import { formatDoctor, formatResult } from './install-output.js';
import { uninstall } from './uninstall-command.js';
import { resolvePackageRoot, SHIPPED_EXECUTABLE_CHECK } from './install-types.js';
import type {
  CliAction,
  CliArgs,
  DoctorCheck,
  InstallPlatform,
  InstallScope,
} from './install-types.js';

// ─── CLI Action Execution ─────────────────────────────────────────────────────

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

  const scopeSource = args.scopeSource ?? 'default';
  if (scopeSource === 'default') {
    const altScope: InstallScope = args.installScope === 'global' ? 'repo' : 'global';
    const altTarget = resolveTarget(altScope, platform);
    const altDetection = detectInstalledArtifacts(altTarget, platform);
    if (altDetection.found) {
      const altDisplay = formatTargetPath(altTarget, altScope, process.cwd());
      console.error(
        `[status] Doctor checked the ${args.installScope} installation because no scope was specified.`,
      );
      console.error(`[status] FlowGuard artifacts were also found at ${altDisplay}.`);
      console.error(`[next] To inspect them, run: flowguard doctor --install-scope ${altScope}`);
      console.error('');
    }
  }

  console.log(formatDoctor(checks, platform));
  const actionableChecks = checks.filter((c) => c.status !== 'info');
  const hasFailure =
    actionableChecks.length === 0 ||
    actionableChecks.some((c) => c.status !== 'ok' && c.status !== 'warn');
  logShippedExecutableFailures(checks, cliLog);
  cliLog.info('cli', 'doctor completed', {
    totalChecks: checks.length,
    hasFailure,
  });
  return hasFailure ? 1 : 0;
}

export async function executeAction(
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

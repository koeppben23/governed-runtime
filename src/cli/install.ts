#!/usr/bin/env node
/**
 * @module cli/install
 * @description Executable FlowGuard CLI entrypoint and repository-internal CLI test API.
 *
 * Install, uninstall, and doctor behavior live in cohesive command modules;
 * argument parsing, console formatting, and action dispatch live in
 * install-args.ts, install-output.ts, and install-execute.ts. This file owns the
 * intentionally shared CLI surface used by installer integration tests and the
 * process boundary.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initCliLogger } from './cli-logging.js';
import { resetAdapterLogger } from '../logging/adapter-logger.js';
import { parseArgs } from './install-args.js';
import { executeAction } from './install-execute.js';
import { resolveTarget } from './install-helpers.js';
import { getUsage } from './install-output.js';

export type {
  InstallScope,
  InstallPlatform,
  PolicyMode,
  CliAction,
  CliArgs,
  FileOp,
  CliResult,
  DoctorStatus,
  DoctorCheck,
} from './install-types.js';
export {
  resolveTarget,
  formatTargetPath,
  sha256,
  computeMandatesDigest,
  resolveOpencodeConfigPath,
} from './install-helpers.js';
export { mergeReviewerTaskPermission } from './install-json.js';
export { hasNonFlowGuardInstructions, FLOWGUARD_INSTRUCTION_ENTRIES } from './install-types.js';
export { doctor } from './doctor-command.js';
export { checkLastSessionHandshake } from './doctor-handshake.js';
export { checkPluginActivation } from './doctor-plugin.js';
export { checkShippedExecutables } from './doctor-executables.js';
export { install } from './install-command.js';
export { detectPackageManager } from './install-helpers-rollback.js';
export { uninstall } from './uninstall-command.js';
export { parseArgs } from './install-args.js';
export { formatResult, formatDoctor } from './install-output.js';

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

  const args = parsed.value;

  const cliLog = initCliLogger(
    resolveTarget(args.installScope, args.installPlatform ?? 'opencode'),
    args.logMode ?? 'console',
  );

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
//
// `isDirectCliExecution` is fail-closed: a missing or unresolvable
// `process.argv[1]` is never a direct execution and never throws at import
// time. `realpath` equivalence supports npm bin symlinks (`flowguard` →
// install.js) while rejecting an unrelated script that merely ends in
// `install.js`.

/**
 * Whether the CLI was started as this exact module.
 *
 * Contract: missing `argvEntry` → false; unresolvable `argvEntry` → false,
 * never throw; realpath equality with this module → true; any other
 * `.../install.js` → false.
 */
export function isDirectCliExecution(argvEntry: string | undefined, moduleUrl: string): boolean {
  if (argvEntry === undefined) return false;
  try {
    return realpathSync(argvEntry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

/**
 * Process-boundary dispatcher for the CLI entry point.
 *
 * A resolved runner exits with its code unchanged. An unexpected rejection
 * (Error or non-Error) is reported deterministically to the injected error
 * sink and exits 1. The runner/exit/report dependencies are injected so these
 * boundary semantics are unit-testable without terminating the test process.
 */
export async function dispatchCliEntrypoint(
  args: string[],
  runner: (argv: string[]) => Promise<number>,
  exit: (code: number) => void,
  reportError: (message: string) => void,
): Promise<void> {
  try {
    exit(await runner(args));
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    reportError(`[error] flowguard CLI failed unexpectedly: ${detail}`);
    exit(1);
  }
}

if (isDirectCliExecution(process.argv[1], import.meta.url)) {
  void dispatchCliEntrypoint(
    process.argv.slice(2),
    main,
    (code) => process.exit(code),
    (message) => console.error(message),
  );
}

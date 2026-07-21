/**
 * @module cli/install-recovery
 * @description Structured error helpers and recovery hints for the FlowGuard CLI installer.
 *
 * Extracted from install-helpers.ts to keep the module under the file-size budget.
 *
 * @version v1
 */

import type { InstallErrorCode, CliError } from './install-types.js';

// ─── Typed Errors ──────────────────────────────────────────────────────────────

export class InstallError extends Error {
  readonly code: InstallErrorCode;

  constructor(code: InstallErrorCode, message: string) {
    super(message);
    this.name = 'InstallError';
    this.code = code;
  }
}

// ─── Recovery Map ──────────────────────────────────────────────────────────────

const RECOVERY_MAP: Record<
  string,
  | string
  | ((detail: {
      code?: InstallErrorCode;
      message: string;
      recoveryContext?: { path?: string; target?: string };
    }) => string)
> = {
  MISSING_CORE_TARBALL: 'Add --core-tarball <path> to your install command',
  TARBALL_NOT_FOUND: 'Verify the tarball path exists and is readable',
  TARBALL_NAME_INVALID: 'Rename to flowguard-core-{version}.tgz or download the correct release',
  TARBALL_VERSION_MISMATCH:
    'Download the tarball matching installer version from the releases page',
  TARBALL_CHECKSUMS_UNREADABLE: 'Ensure checksums.sha256 is readable next to the tarball',
  TARBALL_SHA256_MISMATCH: 'Re-download tarball and checksums file; verify with sha256sum -c',
  ALREADY_INSTALLED: 'Add --force to overwrite, or run uninstall first',
  DEPENDENCY_INSTALL_FAILED: 'Run npm install or bun install manually in the target directory',
  INSTALL_LOCK_CONFLICT: (detail) => {
    const p = detail.recoveryContext?.path ?? '~/.config/opencode/.flowguard-install.lock';
    return `Remove stale lock file: rm -f ${p}`;
  },
};

// ─── Structured Error Helpers ─────────────────────────────────────────────────

export function formatRecoveryLines(
  errorDetails: Array<{
    code?: InstallErrorCode;
    message: string;
    recoveryContext?: { path?: string; target?: string };
  }>,
): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  let hasUncoded = false;

  for (const detail of errorDetails) {
    if (!detail.code) {
      hasUncoded = true;
      continue;
    }
    if (seen.has(detail.code)) continue;
    seen.add(detail.code);

    const recovery = RECOVERY_MAP[detail.code];
    if (recovery) {
      if (typeof recovery === 'function') {
        lines.push(`    ${recovery(detail)}`);
      } else {
        lines.push(`    ${recovery}`);
      }
    } else {
      hasUncoded = true;
    }
  }

  if (hasUncoded) {
    lines.push('    flowguard doctor          → diagnose remaining issues');
    lines.push('    flowguard install --force → repair incomplete install');
    lines.push('    flowguard uninstall       → remove FlowGuard completely');
  }

  return lines;
}

/** Single write boundary for install/uninstall errors. Keeps errors:string[] and errorDetails:CliError[] in sync. */
export function pushError(
  errors: string[],
  errorDetails: CliError[],
  error: unknown,
  recovery?: CliError['recoveryContext'],
): void {
  if (error instanceof InstallError) {
    const msg = error.message;
    errors.push(msg);
    errorDetails.push({ code: error.code, message: msg, recoveryContext: recovery });
  } else {
    const msg = error instanceof Error ? error.message : String(error);
    errors.push(msg);
    errorDetails.push({ message: msg, recoveryContext: recovery });
  }
}

/** Convert unknown error to CliError DTO. Used when errors array is not yet a CliResult. */
export function toCliError(error: unknown): CliError {
  if (error instanceof InstallError) return { code: error.code, message: error.message };
  return { message: error instanceof Error ? error.message : String(error) };
}

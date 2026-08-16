/**
 * @module discovery/package-script-command
 * @description Package-manager-specific script command building.
 *
 * Produces the correct invocation command for running a package.json script
 * through the detected package manager, with argument forwarding support
 * where applicable.
 *
 * @version v1
 */

export type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm';

export interface PackageScriptInvocation {
  readonly command: string;
  readonly forwardsArguments: boolean;
}

const SUPPORTED_PMS: ReadonlySet<string> = new Set(['pnpm', 'yarn', 'bun', 'npm']);

export function isSupportedPackageManager(pm: string): pm is PackageManager {
  return SUPPORTED_PMS.has(pm);
}

export function buildScriptInvocation(
  packageManager: PackageManager,
  scriptName: string,
): PackageScriptInvocation {
  switch (packageManager) {
    case 'pnpm':
      // pnpm auto-forwards unknown args to the script
      return { command: `pnpm ${scriptName}`, forwardsArguments: true };
    case 'yarn':
      // yarn auto-forwards unknown args to the script
      return { command: `yarn ${scriptName}`, forwardsArguments: true };
    case 'bun':
      return { command: `bun run ${scriptName} --`, forwardsArguments: true };
    case 'npm':
    default:
      return { command: `npm run ${scriptName} --`, forwardsArguments: true };
  }
}

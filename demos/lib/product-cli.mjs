/**
 * @module demos/lib/product-cli
 * @description Isolated installation of the bound product tarball. Extracting a
 * tarball alone does not provide its runtime dependencies; the CLI must run
 * from a fully installed npm prefix.
 *
 * @version v1
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Install the tarball into an isolated npm prefix under `root` and return the
 * prefix. Idempotent for a given root; fails closed when the installation
 * produces no node_modules.
 */
export function installTarball({ tarball, prefix, npm = 'npm', run = execFileSync }) {
  const modules = join(prefix, 'node_modules');
  if (!existsSync(modules)) {
    rmSync(prefix, { recursive: true, force: true });
    mkdirSync(prefix, { recursive: true });
    run(npm, ['install', '--prefix', prefix, '--no-audit', '--no-fund', tarball], {
      stdio: 'inherit',
    });
  }
  if (!existsSync(modules)) {
    throw new Error(`isolated product installation has no node_modules: ${prefix}`);
  }
  return prefix;
}

/**
 * Resolve and (when missing) install the product CLI from the bound tarball.
 * The CLI is executed from the installed prefix, so its runtime dependencies
 * resolve exactly as in a real installation.
 */
export function productCli({
  tarball,
  root,
  packageName,
  relativeCli,
  npm = 'npm',
  run = execFileSync,
}) {
  const prefix = installTarball({
    tarball,
    prefix: join(root, '.tooling', 'product-prefix'),
    npm,
    run,
  });
  const cli = join(prefix, 'node_modules', packageName, relativeCli);
  if (!existsSync(cli)) {
    throw new Error(`product CLI missing in the installed tarball: ${cli}`);
  }
  return cli;
}

export const FLOWGUARD_PACKAGE = '@flowguard/core';
export const FLOWGUARD_CLI = 'dist/cli/install.js';

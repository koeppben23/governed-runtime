#!/usr/bin/env node
// Setup git hooks from scripts/ into the repository's hooks directory.
// Called by `npm run setup-hooks` and auto-runs via `prepare` after `npm install`.
// Resolves the hooks path through Git so linked worktrees use the correct
// directory. Existing unmanaged hooks are preserved unless --force is passed.

import { execFileSync } from 'node:child_process';
import { access, chmod, copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MANAGED_HOOK_MARKER = '# Managed by FlowGuard setup-git-hooks';

const HOOKS = ['pre-push'];
const __dirname = dirname(fileURLToPath(import.meta.url));

async function exists(path) {
  return access(path).then(
    () => true,
    () => false,
  );
}

/**
 * Resolve the hooks directory Git will actually read for this checkout.
 * `git rev-parse --git-path hooks` handles linked worktrees; a non-repository
 * checkout returns null and is skipped.
 */
export function resolveGitHooksDir(repoRoot) {
  try {
    const gitPath = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return resolve(repoRoot, gitPath);
  } catch {
    return null;
  }
}

/**
 * Install the repository's managed hooks.
 *
 * An existing hook without the managed marker is preserved. `--force` backs it
 * up before installing over it. Missing source hooks are reported to the caller
 * and make the CLI exit nonzero.
 */
export async function installHooks({
  repoRoot = resolve(__dirname, '..'),
  sourceDir = __dirname,
  hooksDir = resolveGitHooksDir(repoRoot),
  force = false,
  logError = (message) => console.error(message),
} = {}) {
  if (hooksDir === null) {
    logError('[setup-hooks] no Git repository; skipping hook installation');
    return { hooksDir: null, installed: [], preserved: [], missingSources: [] };
  }

  await mkdir(hooksDir, { recursive: true });

  const installed = [];
  const preserved = [];
  const missingSources = [];

  for (const hook of HOOKS) {
    const source = join(sourceDir, hook);
    if (!(await exists(source))) {
      missingSources.push(source);
      logError(`[setup-hooks] source not found: ${source}`);
      continue;
    }

    const destination = join(hooksDir, hook);
    if (await exists(destination)) {
      const content = await readFile(destination, 'utf8');
      if (!content.includes(MANAGED_HOOK_MARKER)) {
        if (!force) {
          preserved.push(destination);
          logError(
            `[setup-hooks] preserving existing unmanaged hook: ${destination}. ` +
              'Re-run with --force to back it up and install the managed hook.',
          );
          continue;
        }

        const backup = `${destination}.flowguard-backup-${Date.now()}`;
        await copyFile(destination, backup);
        logError(`[setup-hooks] backed up existing hook to ${backup}`);
      }
    }

    await copyFile(source, destination);
    await chmod(destination, 0o755);
    installed.push(destination);
  }

  if (installed.length > 0) {
    logError(`[setup-hooks] installed ${installed.length} hook(s) into ${hooksDir}`);
  }
  if (preserved.length > 0) {
    logError('[setup-hooks] existing unmanaged hook(s) were left untouched');
  }

  return { hooksDir, installed, preserved, missingSources };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await installHooks({
    force: process.argv.includes('--force'),
  });
  if (result.missingSources.length > 0) {
    process.exitCode = 1;
  }
}

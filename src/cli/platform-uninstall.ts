/**
 * @module cli/platform-uninstall
 * @description Platform-specific uninstall helpers for non-OpenCode host artifacts.
 */

import { lstat, readFile, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { FileOp, InstallScope } from './install-helpers.js';
import {
  claudeCodePluginInstallHint,
  resolveClaudeCodePluginRoot,
} from './claude-code-plugin-install.js';
import { resolveCodexMarketplacePath, resolveCodexPluginRoot } from './codex-plugin-install.js';
import { CODEX_PLUGIN_NAME, claudeCodePluginFiles, codexPluginFiles } from './templates.js';
import { ensureDir } from '../adapters/persistence.js';

interface CodexMarketplaceEntry {
  name?: string;
  source?: { source?: string; path?: string };
  policy?: { installation?: string; authentication?: string };
  category?: string;
  [key: string]: unknown;
}

async function readPluginVersion(pluginRoot: string, manifestPath: string): Promise<string | null> {
  try {
    const manifest = JSON.parse(await readFile(join(pluginRoot, manifestPath), 'utf-8')) as {
      name?: unknown;
      version?: unknown;
    };
    return manifest.name === CODEX_PLUGIN_NAME || manifest.name === 'flowguard'
      ? typeof manifest.version === 'string'
        ? manifest.version
        : null
      : null;
  } catch {
    return null;
  }
}

export async function uninstallClaudeCodePlugin(target: string): Promise<FileOp[]> {
  const pluginRoot = resolveClaudeCodePluginRoot(target);
  const version = await readPluginVersion(pluginRoot, '.claude-plugin/plugin.json');
  if (!version) {
    return [{ path: pluginRoot, action: 'skipped', reason: 'Claude plugin ownership not proven' }];
  }
  return removeOwnedPluginFiles(
    pluginRoot,
    {
      ...claudeCodePluginFiles(version),
      'INSTALL.md': claudeCodePluginInstallHint(target),
    },
    'FlowGuard Claude Code plugin file',
  );
}

export async function uninstallCodexPlugin(scope: InstallScope): Promise<FileOp[]> {
  const ops: FileOp[] = [];
  const pluginRoot = resolveCodexPluginRoot(scope);
  const version = await readPluginVersion(pluginRoot, '.codex-plugin/plugin.json');
  if (!version) {
    ops.push({ path: pluginRoot, action: 'skipped', reason: 'Codex plugin ownership not proven' });
  } else {
    ops.push(
      ...(await removeOwnedPluginFiles(
        pluginRoot,
        codexPluginFiles(version),
        'FlowGuard Codex plugin file',
      )),
    );
  }

  ops.push(await removeCodexMarketplaceEntry(scope));
  return ops;
}

async function removeOwnedPluginFiles(
  pluginRoot: string,
  expected: Record<string, string>,
  reason: string,
): Promise<FileOp[]> {
  let rootStat;
  try {
    rootStat = await lstat(pluginRoot);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return [{ path: pluginRoot, action: 'not_found' }];
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return [{ path: pluginRoot, action: 'skipped', reason: 'plugin root ownership not proven' }];
  }

  const ops: FileOp[] = [];
  for (const [relativePath, expectedContent] of Object.entries(expected)) {
    const fullPath = join(pluginRoot, relativePath);
    try {
      const stat = await lstat(fullPath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        ops.push({ path: fullPath, action: 'skipped', reason: 'ownership/content mismatch' });
        continue;
      }
      const actual = await readFile(fullPath, 'utf-8');
      if (actual !== expectedContent) {
        ops.push({ path: fullPath, action: 'skipped', reason: 'ownership/content mismatch' });
        continue;
      }
      await unlink(fullPath);
      ops.push({ path: fullPath, action: 'removed', reason });
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    }
  }
  await pruneEmptyPluginDirectories(pluginRoot);
  return ops.length > 0 ? ops : [{ path: pluginRoot, action: 'not_found' }];
}

async function pruneEmptyPluginDirectories(root: string, current = root): Promise<void> {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await pruneEmptyPluginDirectories(root, join(current, entry.name));
  }
  const remaining = await readdir(current);
  if (remaining.length === 0) await rmdir(current);
}

function expectedMarketplaceSourcePath(scope: InstallScope): string {
  return scope === 'global'
    ? `./.codex/plugins/${CODEX_PLUGIN_NAME}`
    : `./plugins/${CODEX_PLUGIN_NAME}`;
}

function isFlowGuardMarketplaceEntry(entry: CodexMarketplaceEntry, scope: InstallScope): boolean {
  return (
    entry.name === CODEX_PLUGIN_NAME &&
    entry.source?.source === 'local' &&
    entry.source?.path === expectedMarketplaceSourcePath(scope) &&
    entry.policy?.installation === 'AVAILABLE' &&
    entry.policy?.authentication === 'ON_INSTALL' &&
    entry.category === 'Productivity'
  );
}

// eslint-disable-next-line complexity
async function removeCodexMarketplaceEntry(scope: InstallScope): Promise<FileOp> {
  const marketplacePath = resolveCodexMarketplacePath(scope);

  // Uninstall is non-creating: absence must remain absence. In particular, do not
  // create ~/.codex/.agents/plugins merely to discover that no marketplace exists.
  if (!existsSync(marketplacePath)) {
    return { path: marketplacePath, action: 'not_found' };
  }

  await ensureDir(dirname(marketplacePath));
  const lockPath = `${marketplacePath}.flowguard.lock`;
  const token = randomUUID();
  try {
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, token }), { flag: 'wx' });
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'EEXIST') {
      throw new Error('Codex marketplace is locked by another process.');
    }
    throw err;
  }

  try {
    const originalContent = await readFile(marketplacePath, 'utf-8');
    const marketplace = JSON.parse(originalContent) as { plugins?: CodexMarketplaceEntry[] };
    if (!Array.isArray(marketplace.plugins)) {
      return { path: marketplacePath, action: 'skipped', reason: 'no plugins array' };
    }

    const matching = marketplace.plugins.filter((entry) =>
      isFlowGuardMarketplaceEntry(entry, scope),
    );
    if (matching.length === 0) {
      return {
        path: marketplacePath,
        action: 'skipped',
        reason: 'no exact FlowGuard-owned Codex marketplace entry',
      };
    }
    if (matching.length > 1) {
      return {
        path: marketplacePath,
        action: 'skipped',
        reason: 'ambiguous duplicate FlowGuard marketplace entries; preserved',
      };
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    await writeFile(
      `${marketplacePath}.flowguard-backup-${timestamp}-${randomUUID()}`,
      originalContent,
      { flag: 'wx' },
    );

    marketplace.plugins = marketplace.plugins.filter(
      (entry) => !isFlowGuardMarketplaceEntry(entry, scope),
    );

    const tmpPath = `${marketplacePath}.tmp.${process.pid}.${randomUUID()}`;
    try {
      await writeFile(tmpPath, JSON.stringify(marketplace, null, 2) + '\n', { flag: 'wx' });
      await rename(tmpPath, marketplacePath);
    } catch (err) {
      try {
        await unlink(tmpPath);
      } catch {
        // best-effort temporary cleanup
      }
      throw err;
    }

    return {
      path: marketplacePath,
      action: 'merged',
      reason: 'removed exact FlowGuard Codex entry',
    };
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return { path: marketplacePath, action: 'not_found' };
    throw err;
  } finally {
    try {
      const raw = readFileSync(lockPath, 'utf-8');
      if (JSON.parse(raw).token === token) unlinkSync(lockPath);
    } catch {
      // Lock cleanup is best effort during uninstall.
    }
  }
}

function isErrno(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && err.code === code;
}

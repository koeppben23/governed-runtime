/**
 * @module cli/platform-uninstall
 * @description Platform-specific uninstall helpers for non-OpenCode host artifacts.
 */

import { readFile, rm, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { FileOp, InstallScope } from './install-helpers.js';
import { resolveClaudeCodePluginRoot } from './claude-code-plugin-install.js';
import { resolveCodexMarketplacePath, resolveCodexPluginRoot } from './codex-plugin-install.js';
import { CODEX_PLUGIN_NAME } from './templates.js';
import { ensureDir } from '../adapters/persistence.js';

interface CodexMarketplaceEntry {
  name?: string;
  [key: string]: unknown;
}

export async function uninstallClaudeCodePlugin(target: string): Promise<FileOp[]> {
  const pluginRoot = resolveClaudeCodePluginRoot(target);
  return [await removePluginTree(pluginRoot, 'FlowGuard Claude Code plugin tree')];
}

export async function uninstallCodexPlugin(scope: InstallScope): Promise<FileOp[]> {
  const ops: FileOp[] = [];
  const pluginRoot = resolveCodexPluginRoot(scope);
  ops.push(await removePluginTree(pluginRoot, 'FlowGuard Codex plugin tree'));

  ops.push(await removeCodexMarketplaceEntry(scope));
  return ops;
}

async function removePluginTree(pluginRoot: string, reason: string): Promise<FileOp> {
  try {
    await rm(pluginRoot, { recursive: true });
    return { path: pluginRoot, action: 'removed', reason };
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return { path: pluginRoot, action: 'not_found' };
    throw err;
  }
}

async function removeCodexMarketplaceEntry(scope: InstallScope): Promise<FileOp> {
  const marketplacePath = resolveCodexMarketplacePath(scope);

  // Lock
  await ensureDir(dirname(marketplacePath));
  const lockPath = `${marketplacePath}.flowguard.lock`;
  try {
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, token: randomUUID() }), {
      flag: 'wx',
    });
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'EEXIST') {
      throw new Error('Codex marketplace is locked by another process.');
    }
    throw err;
  }

  try {
    const originalContent = await readFile(marketplacePath, 'utf-8');
    const marketplace = JSON.parse(originalContent);
    if (!Array.isArray(marketplace.plugins)) {
      return { path: marketplacePath, action: 'skipped', reason: 'no plugins array' };
    }

    const filtered = marketplace.plugins.filter(
      (p: CodexMarketplaceEntry) => p.name !== CODEX_PLUGIN_NAME,
    );
    if (filtered.length === marketplace.plugins.length) {
      return { path: marketplacePath, action: 'skipped', reason: 'no FlowGuard Codex entry' };
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    await writeFile(
      `${marketplacePath}.flowguard-backup-${timestamp}-${randomUUID()}`,
      originalContent,
      { flag: 'wx' },
    );

    marketplace.plugins = filtered;

    const tmpPath = `${marketplacePath}.tmp.${process.pid}.${randomUUID()}`;
    try {
      await writeFile(tmpPath, JSON.stringify(marketplace, null, 2) + '\n', { flag: 'wx' });
      await rename(tmpPath, marketplacePath);
    } catch (err) {
      try {
        await unlink(tmpPath);
      } catch {
        /* ok */
      }
      throw err;
    }

    return { path: marketplacePath, action: 'merged', reason: 'removed FlowGuard Codex entry' };
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return { path: marketplacePath, action: 'not_found' };
    throw err;
  } finally {
    try {
      await unlink(lockPath);
    } catch {
      /* ok */
    }
  }
}

function isErrno(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && err.code === code;
}

/**
 * @module cli/platform-uninstall
 * @description Platform-specific uninstall helpers for non-OpenCode host artifacts.
 */

import { readFile, readdir, rm, writeFile, rename, unlink } from 'node:fs/promises';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import type { FileOp, InstallScope } from './install-helpers.js';
import { resolveClaudeCodePluginRoot } from './claude-code-plugin-install.js';
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

async function collectFiles(root: string, current = root): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(root, full)));
    else if (entry.isFile()) files.push(relative(root, full).replace(/\\/g, '/'));
    else return ['__UNSUPPORTED_ENTRY__'];
  }
  return files.sort();
}

async function pluginTreeMatches(root: string, expected: Record<string, string>): Promise<boolean> {
  const actualFiles = await collectFiles(root);
  const expectedFiles = Object.keys(expected).sort();
  if (actualFiles.length !== expectedFiles.length) return false;
  if (actualFiles.some((file, index) => file !== expectedFiles[index])) return false;
  for (const file of expectedFiles) {
    try {
      if ((await readFile(join(root, file), 'utf-8')) !== expected[file]) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export async function uninstallClaudeCodePlugin(target: string): Promise<FileOp[]> {
  const pluginRoot = resolveClaudeCodePluginRoot(target);
  const version = await readPluginVersion(pluginRoot, '.claude-plugin/plugin.json');
  if (!version) {
    return [{ path: pluginRoot, action: 'skipped', reason: 'Claude plugin ownership not proven' }];
  }
  const expected = claudeCodePluginFiles(version);
  if (!(await pluginTreeMatches(pluginRoot, expected))) {
    return [
      {
        path: pluginRoot,
        action: 'skipped',
        reason: 'Claude plugin tree differs from installed FlowGuard template; preserved',
      },
    ];
  }
  return [await removePluginTree(pluginRoot, 'FlowGuard Claude Code plugin tree')];
}

export async function uninstallCodexPlugin(scope: InstallScope): Promise<FileOp[]> {
  const ops: FileOp[] = [];
  const pluginRoot = resolveCodexPluginRoot(scope);
  const version = await readPluginVersion(pluginRoot, '.codex-plugin/plugin.json');
  if (!version) {
    ops.push({ path: pluginRoot, action: 'skipped', reason: 'Codex plugin ownership not proven' });
  } else if (await pluginTreeMatches(pluginRoot, codexPluginFiles(version))) {
    ops.push(await removePluginTree(pluginRoot, 'FlowGuard Codex plugin tree'));
  } else {
    ops.push({
      path: pluginRoot,
      action: 'skipped',
      reason: 'Codex plugin tree differs from installed FlowGuard template; preserved',
    });
  }

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

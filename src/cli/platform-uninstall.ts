/**
 * @module cli/platform-uninstall
 * @description Platform-specific uninstall helpers for non-OpenCode host artifacts.
 */

import { readFile, rm, writeFile } from 'node:fs/promises';
import type { FileOp, InstallScope } from './install-helpers.js';
import { resolveClaudeCodePluginRoot } from './claude-code-plugin-install.js';
import { resolveCodexMarketplacePath, resolveCodexPluginRoot } from './codex-plugin-install.js';
import { CODEX_PLUGIN_NAME } from './templates.js';

interface CodexMarketplaceEntry {
  name?: string;
  [key: string]: unknown;
}

interface CodexMarketplace {
  plugins?: unknown;
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

  let marketplace: CodexMarketplace;
  try {
    marketplace = JSON.parse(await readFile(marketplacePath, 'utf-8')) as CodexMarketplace;
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return { path: marketplacePath, action: 'not_found' };
    return { path: marketplacePath, action: 'skipped', reason: 'malformed JSON' };
  }

  if (!Array.isArray(marketplace.plugins)) {
    return { path: marketplacePath, action: 'skipped', reason: 'no plugins array' };
  }

  const plugins = marketplace.plugins as CodexMarketplaceEntry[];
  const filtered = plugins.filter((plugin) => plugin.name !== CODEX_PLUGIN_NAME);
  if (filtered.length === plugins.length) {
    return { path: marketplacePath, action: 'skipped', reason: 'no FlowGuard Codex entry' };
  }

  marketplace.plugins = filtered;
  await writeFile(marketplacePath, JSON.stringify(marketplace, null, 2) + '\n', 'utf-8');
  return { path: marketplacePath, action: 'merged', reason: 'removed FlowGuard Codex entry' };
}

function isErrno(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && err.code === code;
}

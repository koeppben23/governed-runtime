/**
 * @module cli/platform-uninstall
 * @description Platform-specific uninstall helpers for non-OpenCode host artifacts.
 */

import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FileOp, InstallScope } from './install-helpers.js';
import { ensureDir } from './install-helpers.js';
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
  if (!existsSync(pluginRoot)) return [{ path: pluginRoot, action: 'not_found' }];

  await rm(pluginRoot, { recursive: true, force: true });
  return [{ path: pluginRoot, action: 'removed', reason: 'FlowGuard Claude Code plugin tree' }];
}

export async function uninstallCodexPlugin(scope: InstallScope): Promise<FileOp[]> {
  const ops: FileOp[] = [];
  const pluginRoot = resolveCodexPluginRoot(scope);
  if (existsSync(pluginRoot)) {
    await rm(pluginRoot, { recursive: true, force: true });
    ops.push({ path: pluginRoot, action: 'removed', reason: 'FlowGuard Codex plugin tree' });
  } else {
    ops.push({ path: pluginRoot, action: 'not_found' });
  }

  ops.push(await removeCodexMarketplaceEntry(scope));
  return ops;
}

async function removeCodexMarketplaceEntry(scope: InstallScope): Promise<FileOp> {
  const marketplacePath = resolveCodexMarketplacePath(scope);
  if (!existsSync(marketplacePath)) return { path: marketplacePath, action: 'not_found' };

  let marketplace: CodexMarketplace;
  try {
    marketplace = JSON.parse(await readFile(marketplacePath, 'utf-8')) as CodexMarketplace;
  } catch {
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
  await ensureDir(dirname(marketplacePath));
  await writeFile(marketplacePath, JSON.stringify(marketplace, null, 2) + '\n', 'utf-8');
  return { path: marketplacePath, action: 'merged', reason: 'removed FlowGuard Codex entry' };
}

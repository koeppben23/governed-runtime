/**
 * @module cli/codex-plugin-install
 * @description Codex plugin tree and marketplace registration installer.
 */

import { existsSync, readFileSync } from 'node:fs';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { FileOp, InstallScope } from './install-helpers.js';
import { ensureDir, writeIfAbsent } from './install-helpers.js';
import { CODEX_PLUGIN_NAME, CODEX_PLUGIN_RELATIVE_FILES, codexPluginFiles } from './templates.js';

interface CodexMarketplaceEntry {
  name: string;
  source: { source: 'local'; path: string };
  policy: { installation: 'AVAILABLE'; authentication: 'ON_INSTALL' };
  category: string;
}

interface CodexMarketplace {
  name?: string;
  plugins?: CodexMarketplaceEntry[];
  [key: string]: unknown;
}

export type CodexInstallStatus = 'INSTALLED_AND_REGISTERED' | 'INSTALLED_NOT_ACTIVATED';

export function resolveCodexPluginRoot(scope: InstallScope): string {
  if (scope === 'global') return join(homedir(), '.codex', 'plugins', CODEX_PLUGIN_NAME);
  return resolve('plugins', CODEX_PLUGIN_NAME);
}

export function resolveCodexMarketplacePath(scope: InstallScope): string {
  if (scope === 'global') return join(homedir(), '.agents', 'plugins', 'marketplace.json');
  return resolve('.agents', 'plugins', 'marketplace.json');
}

export function resolveCodexMarketplaceRoot(scope: InstallScope): string {
  if (scope === 'global') return homedir();
  return resolve('.');
}

function codexMarketplaceSourcePath(scope: InstallScope): string {
  return scope === 'global'
    ? `./.codex/plugins/${CODEX_PLUGIN_NAME}`
    : `./plugins/${CODEX_PLUGIN_NAME}`;
}

export function codexPluginSnapshotPaths(scope: InstallScope): string[] {
  const pluginRoot = resolveCodexPluginRoot(scope);
  return [
    pluginRoot,
    resolveCodexMarketplacePath(scope),
    ...CODEX_PLUGIN_RELATIVE_FILES.map((relativePath) => join(pluginRoot, relativePath)),
  ];
}

export async function installCodexPlugin(
  scope: InstallScope,
  version: string,
  force: boolean,
): Promise<FileOp[]> {
  const pluginRoot = resolveCodexPluginRoot(scope);
  const ops: FileOp[] = [];

  await ensureDir(pluginRoot);

  for (const [relativePath, content] of Object.entries(codexPluginFiles(version))) {
    const filePath = join(pluginRoot, relativePath);
    await ensureDir(dirname(filePath));
    ops.push(await writeIfAbsent(filePath, content, force));

    if (relativePath.startsWith('dist/') && ops[ops.length - 1]?.action === 'written') {
      await chmod(filePath, 0o755);
    }
  }

  ops.push(await registerCodexMarketplaceEntry(scope));
  return ops;
}

async function registerCodexMarketplaceEntry(scope: InstallScope): Promise<FileOp> {
  const marketplacePath = resolveCodexMarketplacePath(scope);
  await ensureDir(dirname(marketplacePath));

  const entry: CodexMarketplaceEntry = {
    name: CODEX_PLUGIN_NAME,
    source: { source: 'local', path: codexMarketplaceSourcePath(scope) },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: 'Productivity',
  };

  let marketplace: CodexMarketplace = { plugins: [] };
  let action: FileOp['action'] = 'written';

  try {
    const content = await readFile(marketplacePath, 'utf-8');
    marketplace =
      content.trim().length > 0 ? (JSON.parse(content) as CodexMarketplace) : { plugins: [] };
    action = 'merged';
  } catch (err) {
    if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT')) {
      throw err;
    }
  }

  const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  const filtered = plugins.filter((plugin) => plugin.name !== CODEX_PLUGIN_NAME);
  if (!marketplace.name) {
    marketplace.name = CODEX_PLUGIN_NAME;
  }
  marketplace.plugins = [...filtered, entry];

  await writeFile(marketplacePath, JSON.stringify(marketplace, null, 2) + '\n', 'utf-8');
  return { path: marketplacePath, action, reason: 'FlowGuard Codex marketplace entry registered' };
}

function isRegisteredFlowGuardEntry(
  entry: CodexMarketplaceEntry | undefined,
  scope: InstallScope,
): boolean {
  if (!entry) return false;

  return (
    entry.source.source === 'local' &&
    entry.source.path === codexMarketplaceSourcePath(scope) &&
    entry.policy.installation === 'AVAILABLE' &&
    entry.policy.authentication === 'ON_INSTALL' &&
    entry.category === 'Productivity'
  );
}

export function codexInstallStatus(scope: InstallScope): CodexInstallStatus {
  const pluginRoot = resolveCodexPluginRoot(scope);
  const marketplacePath = resolveCodexMarketplacePath(scope);
  if (
    !existsSync(join(pluginRoot, '.codex-plugin', 'plugin.json')) ||
    !existsSync(marketplacePath)
  ) {
    return 'INSTALLED_NOT_ACTIVATED';
  }

  try {
    const marketplace = JSON.parse(readFileSync(marketplacePath, 'utf-8')) as CodexMarketplace;
    const flowguardEntry = Array.isArray(marketplace.plugins)
      ? marketplace.plugins.find((plugin) => plugin.name === CODEX_PLUGIN_NAME)
      : undefined;
    if (!isRegisteredFlowGuardEntry(flowguardEntry, scope)) {
      return 'INSTALLED_NOT_ACTIVATED';
    }
  } catch {
    return 'INSTALLED_NOT_ACTIVATED';
  }

  return 'INSTALLED_AND_REGISTERED';
}

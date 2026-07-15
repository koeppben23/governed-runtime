/**
 * @module cli/codex-plugin-install
 * @description Codex plugin tree and marketplace registration installer.
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { chmod, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FileOp, InstallScope } from './install-helpers.js';
import { writeIfAbsent } from './install-helpers.js';
import type { InstallMutationSink } from './install-mutation-types.js';
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
    resolveCodexMarketplacePath(scope),
    ...CODEX_PLUGIN_RELATIVE_FILES.map((relativePath) => join(pluginRoot, relativePath)),
  ];
}

export async function installCodexPlugin(
  scope: InstallScope,
  version: string,
  force: boolean,
  mutations: InstallMutationSink,
): Promise<FileOp[]> {
  const pluginRoot = resolveCodexPluginRoot(scope);
  const ops: FileOp[] = [];

  await mutations.ensureDir(pluginRoot);

  for (const [relativePath, content] of Object.entries(codexPluginFiles(version))) {
    const filePath = join(pluginRoot, relativePath);
    await mutations.ensureDir(dirname(filePath));
    const op = await writeIfAbsent(filePath, content, force);
    ops.push(op);
    if (op.action !== 'skipped') await mutations.recordFile(filePath);

    if (relativePath.startsWith('dist/') && ops[ops.length - 1]?.action === 'written') {
      await chmod(filePath, 0o755);
    }
  }

  const marketplacePath = resolveCodexMarketplacePath(scope);
  await mutations.ensureDir(dirname(marketplacePath));

  const marketplaceOp = await registerCodexMarketplaceEntry(scope, mutations);
  ops.push(marketplaceOp);

  return ops;
}

export function codexPluginFilePaths(scope: InstallScope): string[] {
  const pluginRoot = resolveCodexPluginRoot(scope);
  return [...CODEX_PLUGIN_RELATIVE_FILES.map((relativePath) => join(pluginRoot, relativePath))];
}

// eslint-disable-next-line complexity
async function withMarketplaceLock<T>(marketplacePath: string, fn: () => Promise<T>): Promise<T> {
  // Precondition: parent of marketplacePath must already exist
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
  let result: T | undefined;
  let operationError: unknown;
  try {
    result = await fn();
  } catch (error) {
    operationError = error;
  }

  let cleanupError: unknown;
  try {
    const raw = readFileSync(lockPath, 'utf-8');
    const lock = JSON.parse(raw) as { token?: string };
    if (lock.token !== token) {
      throw new Error('Codex marketplace lock ownership changed.');
    }
    unlinkSync(lockPath);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      cleanupError = error;
    }
  }

  if (operationError && cleanupError) {
    throw new AggregateError(
      [operationError, cleanupError],
      'Marketplace operation and lock cleanup failed.',
    );
  }

  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
  return result as T;
}

async function registerCodexMarketplaceEntry(
  scope: InstallScope,
  mutations: InstallMutationSink,
): Promise<FileOp> {
  const marketplacePath = resolveCodexMarketplacePath(scope);
  return withMarketplaceLock(marketplacePath, () => doRegister(marketplacePath, scope, mutations));
}

async function doRegister(
  marketplacePath: string,
  scope: InstallScope,
  mutations: InstallMutationSink,
): Promise<FileOp> {
  const entry: CodexMarketplaceEntry = {
    name: CODEX_PLUGIN_NAME,
    source: { source: 'local', path: codexMarketplaceSourcePath(scope) },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: 'Productivity',
  };

  let marketplace: CodexMarketplace = { plugins: [] };
  let action: FileOp['action'] = 'written';
  let originalContent: string | null = null;

  // Read raw first, then parse separately
  try {
    originalContent = await readFile(marketplacePath, 'utf-8');
  } catch (err) {
    if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT')) throw err;
  }

  if (originalContent !== null) {
    try {
      marketplace =
        originalContent.trim().length > 0
          ? (JSON.parse(originalContent) as CodexMarketplace)
          : { plugins: [] };
      action = 'merged';
    } catch {
      // Corrupted JSON — save raw backup and abort
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      await writeFile(
        `${marketplacePath}.flowguard-corrupted-backup-${timestamp}-${randomUUID()}`,
        originalContent,
        { flag: 'wx' },
      );
      throw new Error(
        'Marketplace JSON is corrupted. A raw backup was saved. Inspect the backup before retrying.',
      );
    }
  }

  if (isAlreadyRegistered(marketplace, scope)) {
    return { path: marketplacePath, action: 'skipped', reason: 'already registered' };
  }

  const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  const filtered = plugins.filter((plugin) => plugin.name !== CODEX_PLUGIN_NAME);
  if (!marketplace.name) marketplace.name = CODEX_PLUGIN_NAME;
  marketplace.plugins = [...filtered, entry];

  await atomicWriteJson(marketplacePath, marketplace);
  await mutations.recordFile(marketplacePath);
  return {
    path: marketplacePath,
    action,
    reason: 'FlowGuard Codex marketplace entry registered',
  };
}

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const tmpPath = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
  try {
    await writeFile(tmpPath, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
    await rename(tmpPath, filePath);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {
      /* ok */
    }
    throw err;
  }
}

function isAlreadyRegistered(marketplace: CodexMarketplace, scope: InstallScope): boolean {
  const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  const idx = plugins.findIndex((plugin) => plugin.name === CODEX_PLUGIN_NAME);
  return idx >= 0 && plugins[idx]?.source?.path === codexMarketplaceSourcePath(scope);
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

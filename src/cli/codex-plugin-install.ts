/**
 * @module cli/codex-plugin-install
 * @description Codex plugin tree and marketplace registration installer.
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { chmod, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CliInstallError } from './errors.js';
import type { FileOp, InstallScope } from './install-types.js';
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

export type CodexInstallStatus =
  | 'INSTALLED_AND_REGISTERED'
  | 'INSTALLED_NOT_ACTIVATED'
  | 'MARKETPLACE_UNREADABLE'
  | 'MARKETPLACE_MALFORMED';

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
    if (op.action === 'skipped') {
      throw new CliInstallError(
        'NON_OPENCODE_ARTIFACT_EXISTS',
        `Plugin artifact already exists at ${filePath}; it appeared after the install preflight. Remove or rename it and retry, or run uninstall first.`,
      );
    }
    ops.push(op);
    await mutations.recordFile(filePath);

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

async function acquireMarketplaceLock(lockPath: string, token: string): Promise<void> {
  try {
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, token }), { flag: 'wx' });
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'EEXIST') {
      throw new CliInstallError(
        'CODEX_MARKETPLACE_LOCKED',
        'Codex marketplace is locked by another process.',
      );
    }
    throw err;
  }
}

function releaseMarketplaceLock(lockPath: string, token: string): unknown {
  try {
    const raw = readFileSync(lockPath, 'utf-8');
    const lock: { token?: string } = JSON.parse(raw);
    if (lock.token !== token) {
      throw new CliInstallError(
        'CODEX_MARKETPLACE_LOCK_OWNERSHIP_CHANGED',
        'Codex marketplace lock ownership changed.',
      );
    }
    unlinkSync(lockPath);
    return undefined;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    return error;
  }
}

async function withMarketplaceLock<T>(marketplacePath: string, fn: () => Promise<T>): Promise<T> {
  // Precondition: parent of marketplacePath must already exist
  const lockPath = `${marketplacePath}.flowguard.lock`;
  const token = randomUUID();
  await acquireMarketplaceLock(lockPath, token);

  let result: T | undefined;
  let operationError: unknown;
  try {
    result = await fn();
  } catch (error) {
    operationError = error;
  }

  const cleanupError = releaseMarketplaceLock(lockPath, token);

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
    if (originalContent.trim().length > 0) {
      const parsed = parseCodexMarketplace(originalContent);
      if (parsed === null) {
        // Corrupted JSON or unrecognizable marketplace shape — save raw backup and abort
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        await writeFile(
          `${marketplacePath}.flowguard-corrupted-backup-${timestamp}-${randomUUID()}`,
          originalContent,
          { flag: 'wx' },
        );
        throw new CliInstallError(
          'CODEX_MARKETPLACE_CORRUPTED',
          'Marketplace JSON is corrupted or has an unrecognizable shape. A raw backup was saved. Inspect the backup before retrying.',
        );
      }
      marketplace = parsed;
    }
    action = 'merged';
  }

  if (isAlreadyRegistered(marketplace, scope)) {
    return { path: marketplacePath, action: 'skipped', reason: 'already registered' };
  }

  const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  const filtered = plugins.filter(
    (plugin) => typeof plugin !== 'object' || plugin === null || plugin.name !== CODEX_PLUGIN_NAME,
  );
  if (!marketplace.name) marketplace.name = CODEX_PLUGIN_NAME;
  marketplace.plugins = [...filtered, entry];

  await backupMarketplace(marketplacePath, originalContent);
  await atomicWriteJson(marketplacePath, marketplace);
  await mutations.recordFile(marketplacePath);
  return {
    path: marketplacePath,
    action,
    reason: 'FlowGuard Codex marketplace entry registered',
  };
}

async function backupMarketplace(
  marketplacePath: string,
  originalContent: string | null,
): Promise<void> {
  if (originalContent === null || originalContent.length === 0) return;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  await writeFile(
    `${marketplacePath}.flowguard-backup-${timestamp}-${randomUUID()}`,
    originalContent,
    { flag: 'wx' },
  );
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
/**
 * Idempotent skip requires exactly one fully canonical FlowGuard entry — the
 * same predicate that later reports INSTALLED_AND_REGISTERED. Anything else
 * (wrong policy, malformed shape, duplicates) goes through the rewrite path so
 * the marketplace ends canonical instead of reporting a skipped install that
 * is not actually active.
 */
function isAlreadyRegistered(marketplace: CodexMarketplace, scope: InstallScope): boolean {
  const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  const flowguardEntries = plugins.filter(
    (plugin) => typeof plugin === 'object' && plugin !== null && plugin.name === CODEX_PLUGIN_NAME,
  );
  return flowguardEntries.length === 1 && isRegisteredFlowGuardEntry(flowguardEntries[0], scope);
}

/**
 * Shape-validate a marketplace document without depending on accidental
 * property-access throws: the top level must be a plain object and `plugins`,
 * when present, must be an array. Returns null for malformed documents so
 * callers can classify them explicitly.
 */
function parseCodexMarketplace(raw: string): CodexMarketplace | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const marketplace = parsed as Record<string, unknown>;
  if ('plugins' in marketplace && !Array.isArray(marketplace['plugins'])) return null;
  return parsed as CodexMarketplace;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Full structural validation of the FlowGuard marketplace entry: containers
 * must be plain objects and every structural field must have its declared
 * type. A structurally valid entry with wrong values stays a registration
 * mismatch (NOT_ACTIVATED); a wrong type or missing structural field is a
 * malformed marketplace.
 */
function isFlowGuardEntryShape(entry: unknown): boolean {
  if (!isPlainObject(entry)) return false;
  const source = entry['source'];
  const policy = entry['policy'];
  return (
    isPlainObject(source) &&
    typeof source['source'] === 'string' &&
    typeof source['path'] === 'string' &&
    isPlainObject(policy) &&
    typeof policy['installation'] === 'string' &&
    typeof policy['authentication'] === 'string' &&
    typeof entry['category'] === 'string'
  );
}

function isRegisteredFlowGuardEntry(entry: unknown, scope: InstallScope): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const candidate = entry as {
    source?: { source?: unknown; path?: unknown };
    policy?: { installation?: unknown; authentication?: unknown };
    category?: unknown;
  };

  return (
    candidate.source?.source === 'local' &&
    candidate.source.path === codexMarketplaceSourcePath(scope) &&
    candidate.policy?.installation === 'AVAILABLE' &&
    candidate.policy.authentication === 'ON_INSTALL' &&
    candidate.category === 'Productivity'
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

  let raw: string;
  try {
    raw = readFileSync(marketplacePath, 'utf-8');
  } catch {
    return 'MARKETPLACE_UNREADABLE';
  }

  const marketplace = parseCodexMarketplace(raw);
  if (marketplace === null) return 'MARKETPLACE_MALFORMED';

  const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  const flowguardEntry = plugins.find(
    (plugin) => typeof plugin === 'object' && plugin !== null && plugin.name === CODEX_PLUGIN_NAME,
  );
  if (flowguardEntry !== undefined && !isFlowGuardEntryShape(flowguardEntry)) {
    return 'MARKETPLACE_MALFORMED';
  }
  if (!isRegisteredFlowGuardEntry(flowguardEntry, scope)) {
    return 'INSTALLED_NOT_ACTIVATED';
  }

  return 'INSTALLED_AND_REGISTERED';
}

/**
 * @module cli/platform-uninstall
 * @description Platform-specific uninstall helpers for non-OpenCode host artifacts.
 */

import { lstat, readFile, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { CliInstallError } from './errors.js';
import type { FileOp, InstallScope } from './install-types.js';
import {
  claudeCodePluginInstallHint,
  resolveClaudeCodePluginRoot,
} from './claude-code-plugin-install.js';
import { resolveCodexMarketplacePath, resolveCodexPluginRoot } from './codex-plugin-install.js';
import { CODEX_PLUGIN_NAME, claudeCodePluginFiles, codexPluginFiles } from './templates.js';
import { ensureDir } from '../adapters/persistence.js';
import { SafeFileReadError, readRegularFileBounded } from '../shared/safe-file-read.js';

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

type OwnedFileInspection =
  | { readonly kind: 'match'; readonly identity: { readonly dev: number; readonly ino: number } }
  | { readonly kind: 'skip' }
  | { readonly kind: 'missing' };

/** Read through one pinned, bounded handle; symlinks are refused. */
async function inspectOwnedFile(
  fullPath: string,
  expectedContent: string,
): Promise<OwnedFileInspection> {
  try {
    const result = await readRegularFileBounded(fullPath, {
      maxBytes: Buffer.byteLength(expectedContent, 'utf8'),
      allowMissing: true,
    });
    if (result === null) return { kind: 'missing' };
    if (result.content !== expectedContent) return { kind: 'skip' };
    return { kind: 'match', identity: result.identity };
  } catch (error) {
    if (error instanceof SafeFileReadError) return { kind: 'skip' };
    throw error;
  }
}

/**
 * Remove a path only after re-checking the pinned inode identity.
 *
 * Node exposes no portable unlink-by-fd operation. The re-check narrows the
 * path-replacement window but cannot make path `unlink` atomic; the residual
 * platform limitation is documented in the release security triage.
 */
interface PinnedStat {
  isSymbolicLink(): boolean;
  isFile(): boolean;
  readonly dev: number | bigint;
  readonly ino: number | bigint;
}

export async function unlinkPinnedOwnedFile(
  fullPath: string,
  identity: { readonly dev: number; readonly ino: number },
  lookup: (path: string) => Promise<PinnedStat> = lstat,
): Promise<'removed' | 'skipped' | 'missing'> {
  let current;
  try {
    current = await lookup(fullPath);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return 'missing';
    throw error;
  }
  if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    current.dev !== identity.dev ||
    current.ino !== identity.ino
  ) {
    return 'skipped';
  }
  await unlink(fullPath);
  return 'removed';
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
    const inspected = await inspectOwnedFile(fullPath, expectedContent);
    if (inspected.kind === 'missing') continue;
    if (inspected.kind === 'skip') {
      ops.push({ path: fullPath, action: 'skipped', reason: 'ownership/content mismatch' });
      continue;
    }
    const removed = await unlinkPinnedOwnedFile(fullPath, inspected.identity);
    if (removed === 'removed') ops.push({ path: fullPath, action: 'removed', reason });
    else if (removed === 'skipped')
      ops.push({ path: fullPath, action: 'skipped', reason: 'ownership/content mismatch' });
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

async function acquireMarketplaceUninstallLock(lockPath: string, token: string): Promise<void> {
  try {
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, token }), { flag: 'wx' });
  } catch (err) {
    if (isErrno(err, 'EEXIST')) {
      throw new CliInstallError(
        'CODEX_MARKETPLACE_LOCKED',
        'Codex marketplace is locked by another process.',
      );
    }
    throw err;
  }
}

function releaseMarketplaceUninstallLock(lockPath: string, token: string): void {
  try {
    const raw = readFileSync(lockPath, 'utf-8');
    const parsed: { token?: string } = JSON.parse(raw);
    if (parsed.token === token) unlinkSync(lockPath);
  } catch {
    // Lock cleanup is best effort during uninstall.
  }
}

async function removeLockedMarketplaceEntry(
  marketplacePath: string,
  scope: InstallScope,
): Promise<FileOp> {
  const originalContent = await readFile(marketplacePath, 'utf-8');
  const marketplace: { plugins?: CodexMarketplaceEntry[] } = JSON.parse(originalContent);
  if (!Array.isArray(marketplace.plugins)) {
    return { path: marketplacePath, action: 'skipped', reason: 'no plugins array' };
  }

  const matching = marketplace.plugins.filter((entry) => isFlowGuardMarketplaceEntry(entry, scope));
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
}

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
  await acquireMarketplaceUninstallLock(lockPath, token);

  try {
    return await removeLockedMarketplaceEntry(marketplacePath, scope);
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return { path: marketplacePath, action: 'not_found' };
    throw err;
  } finally {
    releaseMarketplaceUninstallLock(lockPath, token);
  }
}

function isErrno(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && err.code === code;
}

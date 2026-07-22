/**
 * @module cli/install-steps
 * @description Decomposed install steps for the FlowGuard install command.
 *
 * Each function performs a single responsibility within the install lifecycle:
 * validation, snapshot, artifact writing, config merging, dependency install.
 *
 * @version v1
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { InstallError, pushError } from './install-helpers.js';
import { ensureDirTracked, MutationJournal } from './install-transaction.js';
import type { InstallMutationSink } from './install-mutation-types.js';
import { globalConfigPath } from '../adapters/persistence.js';
import { readConfig, writeGlobalConfig, writeRepoConfig } from '../adapters/persistence-config.js';
import { DEFAULT_CONFIG } from '../config/flowguard-config.js';
import { getAdapterLogger } from '../logging/adapter-logger.js';
import {
  COMMANDS,
  MANDATES_FILENAME,
  PLUGIN_WRAPPER,
  TOOL_WRAPPER,
  buildMandatesContent,
} from './templates.js';
import {
  claudeCodePluginSnapshotPaths,
  installClaudeCodePlugin,
  writeClaudeCodePluginInstallHint,
} from './claude-code-plugin-install.js';
import {
  codexInstallStatus,
  codexPluginSnapshotPaths,
  installCodexPlugin,
  resolveCodexMarketplacePath,
  resolveCodexPluginRoot,
} from './codex-plugin-install.js';
import {
  type CliArgs,
  type FileOp,
  type InstallPlatform,
  type RollbackEntry,
  type CliError,
  type CliNotice,
  type InstallErrorCode,
  FLOWGUARD_TARBALL_PATTERN,
  PACKAGE_VERSION,
  computeMandatesDigest,
  detectPackageManager,
  mergeOpencodeJson,
  mergePackageJson,
  reviewerDefinitionForPlatform,
  resolveOpencodeConfigPath,
  resolveTarget,
  snapshotForRollback,
  verifyTarballChecksum,
  writeIfAbsent,
} from './install-helpers.js';

const DEPENDENCY_INSTALL_TIMEOUT_MS = 300_000;

// ─── Install context ─────────────────────────────────────────────────────────

export interface InstallContext {
  installPlatform: InstallPlatform;
  target: string;
  ops: FileOp[];
  errors: string[];
  errorDetails: CliError[];
  warnings: string[];
  notices: CliNotice[];
  args: CliArgs;
}

export function initInstallContext(args: CliArgs): InstallContext {
  const installPlatform = args.installPlatform ?? 'opencode';
  const target = resolveTarget(args.installScope, installPlatform);
  return {
    installPlatform,
    target,
    ops: [],
    errors: [],
    errorDetails: [],
    warnings: [],
    notices: [],
    args,
  };
}

// ─── Step: Tarball validation ────────────────────────────────────────────────

export interface ValidatedTarball {
  valid: true;
  path: string;
  name: string;
  version: string;
}

function failTarball(ctx: InstallContext, code: InstallErrorCode, msg: string): null {
  pushError(ctx.errors, ctx.errorDetails, new InstallError(code, msg));
  return null;
}

export async function validateTarball(ctx: InstallContext): Promise<ValidatedTarball | null> {
  const { args } = ctx;

  if (!args.coreTarball) {
    return failTarball(
      ctx,
      'MISSING_CORE_TARBALL',
      `ERROR: --core-tarball is required.\n` +
        `Usage: npx --package ./flowguard-core-${PACKAGE_VERSION()}.tgz flowguard install --core-tarball ./flowguard-core-${PACKAGE_VERSION()}.tgz\n` +
        `Download from: https://github.com/koeppben23/governed-runtime/releases`,
    );
  }

  const tarballPath = resolve(args.coreTarball);

  if (!existsSync(tarballPath)) {
    return failTarball(ctx, 'TARBALL_NOT_FOUND', `ERROR: Core tarball not found: ${tarballPath}`);
  }

  const tarballName = basename(tarballPath);
  const versionMatch = tarballName.match(FLOWGUARD_TARBALL_PATTERN);
  if (!versionMatch) {
    return failTarball(
      ctx,
      'TARBALL_NAME_INVALID',
      'ERROR: Tarball filename must match flowguard-core-{version}.tgz\n' +
        `  Found: ${tarballName}`,
    );
  }
  const tarballVersion = versionMatch[1];

  if (tarballVersion !== PACKAGE_VERSION()) {
    return failTarball(
      ctx,
      'TARBALL_VERSION_MISMATCH',
      `ERROR: Version mismatch.\n` +
        `  Tarball: ${tarballVersion}\n` +
        `  Installer: ${PACKAGE_VERSION()}\n` +
        `  Please use the correct tarball version.`,
    );
  }

  if (args.checksumsFile && args.allowUnverifiedTarball) {
    return failTarball(
      ctx,
      'CONFIG_INCOMPATIBLE_FLAGS',
      'ERROR: --checksums-file cannot be combined with --allow-unverified-tarball. ' +
        'Choose verified installation or the explicit unverified opt-out.',
    );
  }

  if (args.allowUnverifiedTarball) {
    ctx.warnings.push(
      'Tarball integrity verification explicitly skipped via --allow-unverified-tarball. ' +
        'This supply-chain opt-out is not recommended.',
    );
    getAdapterLogger().warn('cli', 'tarball verification explicitly skipped', {
      tarballPath,
      reason: 'explicit_opt_out',
    });
  } else {
    const checksumsPath = args.checksumsFile ?? join(dirname(tarballPath), 'checksums.sha256');
    try {
      await verifyTarballChecksum(tarballPath, checksumsPath);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      getAdapterLogger().error('cli', 'tarball verification failed', { tarballPath, reason });
      const code = err instanceof InstallError ? err.code : 'TARBALL_INTEGRITY_FAILED';
      return failTarball(ctx, code, `ERROR: Tarball integrity check failed: ${reason}`);
    }
  }

  return { valid: true, path: tarballPath, name: tarballName, version: tarballVersion };
}

// ─── Step: Rollback snapshot ─────────────────────────────────────────────────

async function buildDirectorySnapshots(
  target: string,
  configTargetDir: string,
  installPlatform: InstallPlatform,
): Promise<RollbackEntry[]> {
  const entries: RollbackEntry[] = [];

  entries.push(await snapshotForRollback(target, 'directory'));

  if (configTargetDir !== target) {
    entries.push(await snapshotForRollback(configTargetDir, 'directory'));
  }

  if (installPlatform !== 'claude-code' && installPlatform !== 'codex') {
    entries.push(await snapshotForRollback(join(target, 'vendor'), 'directory'));
    entries.push(await snapshotForRollback(join(target, 'agents'), 'directory'));
    entries.push(await snapshotForRollback(join(target, 'commands'), 'directory'));
    entries.push(await snapshotForRollback(join(target, 'plugins'), 'directory'));
    entries.push(await snapshotForRollback(join(target, 'tools'), 'directory'));
  } else {
    entries.push(await snapshotForRollback(join(target, 'vendor'), 'directory'));
    // Platform-specific plugin roots
    if (installPlatform === 'claude-code') {
      entries.push(await snapshotForRollback(join(target, 'flowguard-plugin'), 'directory'));
    }
    // Codex plugin root is captured via codexPluginSnapshotPaths
  }

  entries.push(await snapshotForRollback(join(configTargetDir, 'node_modules'), 'directory'));
  return entries;
}

export interface SnapshotResult {
  preStateEntries: RollbackEntry[];
  vendorTarballPath: string;
  mandatesPath: string;
  configTargetDir: string;
  pkgPath: string;
  opencodeJsonPath: string | null;
  cfgPath: string;
  reviewerPath: string;
  mutationJournal: MutationJournal;
}

function findPreState(entries: RollbackEntry[], path: string): RollbackEntry {
  const entry = entries.find((e) => e.path === path);
  if (!entry) throw new Error(`Pre-state entry not found: ${path}`);
  return entry;
}

export function resolveConfigTargetDir(ctx: InstallContext): string {
  const { target, installPlatform, args } = ctx;
  return installPlatform === 'opencode'
    ? args.installScope === 'global'
      ? dirname(globalConfigPath())
      : join(resolve('.'), '.opencode')
    : target;
}

export async function buildRollbackSnapshot(
  ctx: InstallContext,
  tarballName: string,
): Promise<SnapshotResult> {
  const { target, installPlatform, args } = ctx;
  const vendorPath = join(target, 'vendor');
  const vendorTarballPath = join(vendorPath, tarballName);
  const mandatesPath = join(target, MANDATES_FILENAME);

  const configTargetDir = resolveConfigTargetDir(ctx);
  const pkgPath = join(target, 'package.json');
  const opencodeJsonPath =
    installPlatform === 'opencode' ? resolveOpencodeConfigPath(args.installScope, target) : null;
  const cfgPath = join(configTargetDir, 'flowguard.json');
  const reviewerDefinition = reviewerDefinitionForPlatform(installPlatform);
  const reviewerPath = join(target, reviewerDefinition.relativePath);

  // MutationJournal starts empty — populated by writeArtifacts/writeConfigFiles
  // after each successful mutation. Provides deterministic rollback ordering.
  const mutationJournal = new MutationJournal();

  // Pre-state snapshots (not journal entries — journal is populated after mutations)
  const dirEntries = await buildDirectorySnapshots(target, configTargetDir, installPlatform);

  const preStateEntries: RollbackEntry[] = [
    ...dirEntries,
    await snapshotForRollback(pkgPath, 'file'),
    ...(opencodeJsonPath ? [await snapshotForRollback(opencodeJsonPath, 'file')] : []),
    await snapshotForRollback(cfgPath, 'file'),
    await snapshotForRollback(mandatesPath, 'file'),
    await snapshotForRollback(vendorTarballPath, 'file'),
    ...(installPlatform === 'claude-code'
      ? await Promise.all(
          claudeCodePluginSnapshotPaths(target).map(
            async (p) => await snapshotForRollback(p, 'file'),
          ),
        )
      : installPlatform === 'codex'
        ? await Promise.all(
            codexPluginSnapshotPaths(args.installScope).map(
              async (p) => await snapshotForRollback(p, 'file'),
            ),
          )
        : [
            await snapshotForRollback(join(target, 'tools', 'flowguard.ts'), 'file'),
            await snapshotForRollback(join(target, 'plugins', 'flowguard-audit.ts'), 'file'),
            await snapshotForRollback(reviewerPath, 'file'),
            ...(await Promise.all(
              Object.keys(COMMANDS).map(
                async (name) => await snapshotForRollback(join(target, 'commands', name), 'file'),
              ),
            )),
          ]),
  ];

  return {
    preStateEntries,
    vendorTarballPath,
    mandatesPath,
    configTargetDir,
    pkgPath,
    opencodeJsonPath,
    cfgPath,
    reviewerPath,
    mutationJournal,
  };
}

// ─── Step: Write artifacts (tarball + mandates + platform plugins) ────────────

// eslint-disable-next-line max-lines-per-function
export async function writeArtifacts(
  ctx: InstallContext,
  tarball: ValidatedTarball,
  snapshot: SnapshotResult,
): Promise<void> {
  const { target, installPlatform, args } = ctx;
  const journal = snapshot.mutationJournal;

  // Directory scaffolding for OpenCode platform
  if (installPlatform !== 'claude-code' && installPlatform !== 'codex') {
    await ensureDirTracked(join(target, 'tools'), journal);
    await ensureDirTracked(join(target, 'plugins'), journal);
    await ensureDirTracked(join(target, 'commands'), journal);
    await ensureDirTracked(join(target, 'agents'), journal);
  }

  // Vendor tarball
  await ensureDirTracked(dirname(snapshot.vendorTarballPath), journal);
  await copyFile(tarball.path, snapshot.vendorTarballPath);
  journal.record(findPreState(snapshot.preStateEntries, snapshot.vendorTarballPath));
  ctx.ops.push({ path: snapshot.vendorTarballPath, action: 'written' });

  // Mandates file
  const digest = computeMandatesDigest();
  const mandatesContent = buildMandatesContent(PACKAGE_VERSION(), digest);
  await ensureDirTracked(dirname(snapshot.mandatesPath), journal);
  await writeFile(snapshot.mandatesPath, mandatesContent, 'utf-8');
  journal.record(findPreState(snapshot.preStateEntries, snapshot.mandatesPath));
  ctx.ops.push({ path: snapshot.mandatesPath, action: 'written' });

  // Platform-specific artifacts
  if (installPlatform === 'claude-code') {
    await ensureDirTracked(join(target, 'flowguard-plugin'), journal);
    const mutations: InstallMutationSink = {
      ensureDir: async (path) => await ensureDirTracked(path, journal),
      recordFile: (path) => {
        journal.record(findPreState(snapshot.preStateEntries, path));
      },
    };
    ctx.ops.push(
      ...(await installClaudeCodePlugin(target, PACKAGE_VERSION(), args.force, mutations)),
    );
    const hintOp = await writeClaudeCodePluginInstallHint(target);
    ctx.ops.push(hintOp);
    if (hintOp.action !== 'skipped')
      journal.record(findPreState(snapshot.preStateEntries, hintOp.path));
  } else if (installPlatform === 'codex') {
    await ensureDirTracked(resolveCodexPluginRoot(args.installScope), journal);
    const mutations: InstallMutationSink = {
      ensureDir: async (path) => await ensureDirTracked(path, journal),
      recordFile: (path) => {
        journal.record(findPreState(snapshot.preStateEntries, path));
      },
    };
    ctx.ops.push(
      ...(await installCodexPlugin(args.installScope, PACKAGE_VERSION(), args.force, mutations)),
    );
  } else {
    const reviewerDefinition = reviewerDefinitionForPlatform(installPlatform);
    const reviewerPath = join(target, reviewerDefinition.relativePath);
    const toolOp = await writeIfAbsent(
      join(target, 'tools', 'flowguard.ts'),
      TOOL_WRAPPER,
      args.force,
    );
    ctx.ops.push(toolOp);
    if (toolOp.action !== 'skipped')
      journal.record(findPreState(snapshot.preStateEntries, join(target, 'tools', 'flowguard.ts')));
    const pluginOp = await writeIfAbsent(
      join(target, 'plugins', 'flowguard-audit.ts'),
      PLUGIN_WRAPPER,
      args.force,
    );
    ctx.ops.push(pluginOp);
    if (pluginOp.action !== 'skipped')
      journal.record(
        findPreState(snapshot.preStateEntries, join(target, 'plugins', 'flowguard-audit.ts')),
      );
    for (const [name, content] of Object.entries(COMMANDS)) {
      const cmdOp = await writeIfAbsent(join(target, 'commands', name), content, args.force);
      ctx.ops.push(cmdOp);
      if (cmdOp.action !== 'skipped')
        journal.record(findPreState(snapshot.preStateEntries, join(target, 'commands', name)));
    }
    const revOp = await writeIfAbsent(reviewerPath, reviewerDefinition.content, args.force);
    ctx.ops.push(revOp);
    if (revOp.action !== 'skipped')
      journal.record(findPreState(snapshot.preStateEntries, reviewerPath));
  }
}

// ─── Step: Write config files (package.json, opencode.json, flowguard.json) ──

export async function writeConfigFiles(
  ctx: InstallContext,
  snapshot: SnapshotResult,
): Promise<void> {
  const { installPlatform, args } = ctx;
  const journal = snapshot.mutationJournal;

  // package.json merge
  const pkgOp = await mergePackageJson(snapshot.pkgPath, PACKAGE_VERSION());
  ctx.ops.push(pkgOp);
  if (pkgOp.action !== 'skipped')
    journal.record(findPreState(snapshot.preStateEntries, snapshot.pkgPath));

  // opencode.json (OpenCode only)
  if (snapshot.opencodeJsonPath) {
    const ocOp = await mergeOpencodeJson(snapshot.opencodeJsonPath, args.installScope);
    ctx.ops.push(ocOp);
    if (ocOp.action !== 'skipped')
      journal.record(findPreState(snapshot.preStateEntries, snapshot.opencodeJsonPath));
  }

  // flowguard.json
  if (installPlatform !== 'opencode') {
    await writeNonOpencodeConfig(ctx, snapshot);
  } else if (!existsSync(snapshot.cfgPath)) {
    await writeNewOpencodeConfig(ctx, snapshot);
  } else if (args.force) {
    await mergeExistingOpencodeConfig(ctx, snapshot);
  }
}

async function writeNonOpencodeConfig(
  ctx: InstallContext,
  snapshot: SnapshotResult,
): Promise<void> {
  const config = {
    ...DEFAULT_CONFIG,
    policy: { ...DEFAULT_CONFIG.policy, defaultMode: ctx.args.policyMode },
  };
  await ensureDirTracked(dirname(snapshot.cfgPath), snapshot.mutationJournal);
  try {
    await writeFile(snapshot.cfgPath, JSON.stringify(config, null, 2) + '\n', {
      encoding: 'utf-8',
      flag: 'wx',
    });
    ctx.ops.push({ path: snapshot.cfgPath, action: 'written' });
    snapshot.mutationJournal.record(findPreState(snapshot.preStateEntries, snapshot.cfgPath));
  } catch (err) {
    if (!(err instanceof Error && 'code' in err && err.code === 'EEXIST') || !ctx.args.force) {
      if (err instanceof Error && 'code' in err && err.code === 'EEXIST') {
        // File exists, not forced — skip silently
      } else {
        throw err;
      }
    } else {
      const existing = JSON.parse(await readFile(snapshot.cfgPath, 'utf-8'));
      existing.policy.defaultMode = ctx.args.policyMode;
      await writeFile(snapshot.cfgPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
      ctx.ops.push({
        path: snapshot.cfgPath,
        action: 'merged',
        reason: 'policy mode updated via --force',
      });
      snapshot.mutationJournal.record(findPreState(snapshot.preStateEntries, snapshot.cfgPath));
    }
  }
}

async function writeNewOpencodeConfig(
  ctx: InstallContext,
  snapshot: SnapshotResult,
): Promise<void> {
  const config = {
    ...DEFAULT_CONFIG,
    policy: { ...DEFAULT_CONFIG.policy, defaultMode: ctx.args.policyMode },
  };
  if (ctx.args.installScope === 'global') {
    await writeGlobalConfig(config);
  } else {
    await writeRepoConfig(resolve('.'), config);
  }
  if (!existsSync(snapshot.cfgPath)) {
    throw new InstallError(
      'TARBALL_CHECKSUMS_UNREADABLE',
      `CONFIG_WRITE_FAILED: config is required but missing at ${snapshot.cfgPath}`,
    );
  }
  ctx.ops.push({ path: snapshot.cfgPath, action: 'written' });
  snapshot.mutationJournal.record(findPreState(snapshot.preStateEntries, snapshot.cfgPath));
}

async function mergeExistingOpencodeConfig(
  ctx: InstallContext,
  snapshot: SnapshotResult,
): Promise<void> {
  const existing = await readConfig(ctx.args.installScope === 'repo' ? resolve('.') : undefined);
  existing.policy.defaultMode = ctx.args.policyMode;
  if (ctx.args.installScope === 'global') {
    await writeGlobalConfig(existing);
  } else {
    await writeRepoConfig(resolve('.'), existing);
  }
  ctx.ops.push({
    path: snapshot.cfgPath,
    action: 'merged',
    reason: 'policy mode updated via --force',
  });
  snapshot.mutationJournal.record(findPreState(snapshot.preStateEntries, snapshot.cfgPath));
}

// ─── Step: Install dependencies (legacy — throws only, top-level handles rollback) ─

export async function installDependencies(
  ctx: InstallContext,
  snapshot: SnapshotResult,
): Promise<void> {
  const pm = detectPackageManager();
  if (pm === null) {
    throw new Error(
      'Neither bun nor npm found in PATH. Install bun (https://bun.sh) or Node.js/npm.',
    );
  }

  try {
    execSync(pm === 'npm' ? 'npm install --no-audit --no-fund' : 'bun install', {
      cwd: snapshot.configTargetDir,
      stdio: 'pipe',
      timeout: DEPENDENCY_INSTALL_TIMEOUT_MS,
    });
    ctx.ops.push({ path: join(snapshot.configTargetDir, 'node_modules'), action: 'written' });

    const corePath = join(snapshot.configTargetDir, 'node_modules', '@flowguard', 'core');
    if (!existsSync(corePath)) {
      throw new Error('Dependencies installed but @flowguard/core not found.');
    }
  } catch (err) {
    throw new Error(
      `Dependency install failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ─── Step: Post-install notices ──────────────────────────────────────────────

export function emitPostInstallWarnings(ctx: InstallContext): void {
  const { installPlatform, target, args } = ctx;

  if (installPlatform === 'claude-code') {
    ctx.notices.push({
      kind: 'next',
      message: `Load FlowGuard in Claude Code with: claude --plugin-dir ${join(target, 'flowguard-plugin')}`,
    });
  } else if (installPlatform === 'codex') {
    ctx.notices.push({
      kind: 'status',
      message: `Codex marketplace registration: ${codexInstallStatus(args.installScope)} at ${resolveCodexMarketplacePath(args.installScope)}`,
    });
    ctx.warnings.push('Codex native plugin load: NOT_VERIFIED_NATIVE_LOAD');
    ctx.warnings.push(
      'Codex plugin hooks require [features].plugin_hooks = true and /hooks trust review before enforcement is verified.',
    );
  } else {
    ctx.notices.push({
      kind: 'next',
      message:
        'Restart OpenCode to reload the updated FlowGuard configuration.' +
        ' Mandate activation remains NOT_VERIFIED.',
    });
  }
}

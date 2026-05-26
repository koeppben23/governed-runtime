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
import { globalConfigPath } from '../adapters/persistence.js';
import { readConfig, writeGlobalConfig, writeRepoConfig } from '../adapters/persistence-config.js';
import { DEFAULT_CONFIG } from '../config/flowguard-config.js';
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
} from './codex-plugin-install.js';
import {
  type CliArgs,
  type FileOp,
  type InstallPlatform,
  type RollbackEntry,
  FLOWGUARD_TARBALL_PATTERN,
  PACKAGE_VERSION,
  computeMandatesDigest,
  detectPackageManager,
  ensureDir,
  mergeOpencodeJson,
  mergePackageJson,
  reviewerDefinitionForPlatform,
  resolveOpencodeConfigPath,
  resolveTarget,
  rollbackArtifacts,
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
  warnings: string[];
  args: CliArgs;
}

export function initInstallContext(args: CliArgs): InstallContext {
  const installPlatform = args.installPlatform ?? 'opencode';
  const target = resolveTarget(args.installScope, installPlatform);
  return { installPlatform, target, ops: [], errors: [], warnings: [], args };
}

// ─── Step: Tarball validation ────────────────────────────────────────────────

export interface ValidatedTarball {
  valid: true;
  path: string;
  name: string;
  version: string;
}

export async function validateTarball(ctx: InstallContext): Promise<ValidatedTarball | null> {
  const { args } = ctx;

  if (!args.coreTarball) {
    ctx.errors.push(
      `ERROR: --core-tarball is required.\n` +
        `Usage: npx --package ./flowguard-core-${PACKAGE_VERSION()}.tgz flowguard install --core-tarball ./flowguard-core-${PACKAGE_VERSION()}.tgz\n` +
        `Download from: https://github.com/koeppben23/governed-runtime/releases`,
    );
    return null;
  }

  const tarballPath = resolve(args.coreTarball);

  if (!existsSync(tarballPath)) {
    ctx.errors.push(`ERROR: Core tarball not found: ${tarballPath}`);
    return null;
  }

  const tarballName = basename(tarballPath);
  const versionMatch = tarballName.match(FLOWGUARD_TARBALL_PATTERN);
  if (!versionMatch) {
    ctx.errors.push(
      'ERROR: Tarball filename must match flowguard-core-{version}.tgz\n' +
        `  Found: ${tarballName}`,
    );
    return null;
  }
  const tarballVersion = versionMatch[1];

  if (tarballVersion !== PACKAGE_VERSION()) {
    ctx.errors.push(
      `ERROR: Version mismatch.\n` +
        `  Tarball: ${tarballVersion}\n` +
        `  Installer: ${PACKAGE_VERSION()}\n` +
        `  Please use the correct tarball version.`,
    );
    return null;
  }

  if (args.checksumsFile) {
    try {
      await verifyTarballChecksum(tarballPath, args.checksumsFile);
    } catch (err) {
      ctx.errors.push(
        `ERROR: Tarball integrity check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  } else {
    ctx.warnings.push(
      'Tarball integrity not verified. ' +
        'Use --checksums-file ./checksums.sha256 for cryptographic verification.',
    );
  }

  return { valid: true, path: tarballPath, name: tarballName, version: tarballVersion };
}

// ─── Step: Rollback snapshot ─────────────────────────────────────────────────

export interface SnapshotResult {
  rollbackEntries: RollbackEntry[];
  vendorTarballPath: string;
  mandatesPath: string;
  configTargetDir: string;
  pkgPath: string;
  opencodeJsonPath: string | null;
  cfgPath: string;
  reviewerPath: string;
}

export async function buildRollbackSnapshot(
  ctx: InstallContext,
  tarballName: string,
): Promise<SnapshotResult> {
  const { target, installPlatform, args } = ctx;
  const vendorPath = join(target, 'vendor');
  const vendorTarballPath = join(vendorPath, tarballName);
  const mandatesPath = join(target, MANDATES_FILENAME);

  const configTargetDir =
    installPlatform === 'opencode'
      ? args.installScope === 'global'
        ? dirname(globalConfigPath())
        : join(resolve('.'), '.opencode')
      : target;
  const pkgPath = join(target, 'package.json');
  const opencodeJsonPath =
    installPlatform === 'opencode' ? resolveOpencodeConfigPath(args.installScope, target) : null;
  const cfgPath = join(configTargetDir, 'flowguard.json');
  const reviewerDefinition = reviewerDefinitionForPlatform(installPlatform);
  const reviewerPath = join(target, reviewerDefinition.relativePath);

  const rollbackEntries: RollbackEntry[] = [
    await snapshotForRollback(pkgPath),
    ...(opencodeJsonPath ? [await snapshotForRollback(opencodeJsonPath)] : []),
    await snapshotForRollback(cfgPath),
    await snapshotForRollback(mandatesPath),
    await snapshotForRollback(vendorTarballPath),
    ...(installPlatform === 'claude-code'
      ? await Promise.all(claudeCodePluginSnapshotPaths(target).map(snapshotForRollback))
      : installPlatform === 'codex'
        ? await Promise.all(codexPluginSnapshotPaths(args.installScope).map(snapshotForRollback))
        : [
            await snapshotForRollback(join(target, 'tools', 'flowguard.ts')),
            await snapshotForRollback(join(target, 'plugins', 'flowguard-audit.ts')),
            await snapshotForRollback(reviewerPath),
            ...(await Promise.all(
              Object.keys(COMMANDS).map((name) =>
                snapshotForRollback(join(target, 'commands', name)),
              ),
            )),
          ]),
    {
      path: join(configTargetDir, 'node_modules'),
      existed: existsSync(join(configTargetDir, 'node_modules')),
    },
  ];

  return {
    rollbackEntries,
    vendorTarballPath,
    mandatesPath,
    configTargetDir,
    pkgPath,
    opencodeJsonPath,
    cfgPath,
    reviewerPath,
  };
}

// ─── Step: Write artifacts (tarball + mandates + platform plugins) ────────────

export async function writeArtifacts(
  ctx: InstallContext,
  tarball: ValidatedTarball,
  snapshot: SnapshotResult,
): Promise<void> {
  const { target, installPlatform, args } = ctx;

  // Directory scaffolding for OpenCode platform
  if (installPlatform !== 'claude-code' && installPlatform !== 'codex') {
    await ensureDir(join(target, 'tools'));
    await ensureDir(join(target, 'plugins'));
    await ensureDir(join(target, 'commands'));
    await ensureDir(join(target, 'agents'));
  }

  // Vendor tarball
  await ensureDir(dirname(snapshot.vendorTarballPath));
  await copyFile(tarball.path, snapshot.vendorTarballPath);
  ctx.ops.push({ path: snapshot.vendorTarballPath, action: 'written' });

  // Mandates file
  const digest = computeMandatesDigest();
  const mandatesContent = buildMandatesContent(PACKAGE_VERSION(), digest);
  await ensureDir(dirname(snapshot.mandatesPath));
  await writeFile(snapshot.mandatesPath, mandatesContent, 'utf-8');
  ctx.ops.push({ path: snapshot.mandatesPath, action: 'written' });

  // Platform-specific artifacts
  if (installPlatform === 'claude-code') {
    ctx.ops.push(...(await installClaudeCodePlugin(target, PACKAGE_VERSION(), args.force)));
    ctx.ops.push(await writeClaudeCodePluginInstallHint(target));
  } else if (installPlatform === 'codex') {
    ctx.ops.push(...(await installCodexPlugin(args.installScope, PACKAGE_VERSION(), args.force)));
  } else {
    const reviewerDefinition = reviewerDefinitionForPlatform(installPlatform);
    const reviewerPath = join(target, reviewerDefinition.relativePath);
    ctx.ops.push(
      await writeIfAbsent(join(target, 'tools', 'flowguard.ts'), TOOL_WRAPPER, args.force),
    );
    ctx.ops.push(
      await writeIfAbsent(
        join(target, 'plugins', 'flowguard-audit.ts'),
        PLUGIN_WRAPPER,
        args.force,
      ),
    );
    for (const [name, content] of Object.entries(COMMANDS)) {
      ctx.ops.push(await writeIfAbsent(join(target, 'commands', name), content, args.force));
    }
    ctx.ops.push(await writeIfAbsent(reviewerPath, reviewerDefinition.content, args.force));
  }
}

// ─── Step: Write config files (package.json, opencode.json, flowguard.json) ──

export async function writeConfigFiles(
  ctx: InstallContext,
  snapshot: SnapshotResult,
): Promise<void> {
  const { installPlatform, args } = ctx;

  // package.json merge
  ctx.ops.push(await mergePackageJson(snapshot.pkgPath, PACKAGE_VERSION()));

  // opencode.json (OpenCode only)
  if (snapshot.opencodeJsonPath) {
    ctx.ops.push(await mergeOpencodeJson(snapshot.opencodeJsonPath, args.installScope));
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
  await ensureDir(dirname(snapshot.cfgPath));
  try {
    await writeFile(snapshot.cfgPath, JSON.stringify(config, null, 2) + '\n', {
      encoding: 'utf-8',
      flag: 'wx',
    });
    ctx.ops.push({ path: snapshot.cfgPath, action: 'written' });
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
    throw new Error(`CONFIG_WRITE_FAILED: config is required but missing at ${snapshot.cfgPath}`);
  }
  ctx.ops.push({ path: snapshot.cfgPath, action: 'written' });
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
}

// ─── Step: Install dependencies ──────────────────────────────────────────────

function dependencyInstallCommand(pm: 'bun' | 'npm'): string {
  if (pm === 'npm') return 'npm install --no-audit --no-fund';
  return 'bun install';
}

export async function installDependencies(
  ctx: InstallContext,
  snapshot: SnapshotResult,
): Promise<void> {
  const pm = detectPackageManager();
  if (pm === null) {
    await rollbackArtifacts(snapshot.rollbackEntries, ctx.ops, ctx.warnings);
    ctx.errors.push(
      'ERROR: Neither bun nor npm found in PATH.\n' +
        `  FlowGuard artifacts were rolled back. Recovery:\n` +
        `    1. Install bun (https://bun.sh) or Node.js/npm.\n` +
        `    2. Re-run: flowguard install --force`,
    );
    return;
  }

  try {
    execSync(dependencyInstallCommand(pm), {
      cwd: snapshot.configTargetDir,
      stdio: 'pipe',
      timeout: DEPENDENCY_INSTALL_TIMEOUT_MS,
    });
    ctx.ops.push({ path: join(snapshot.configTargetDir, 'node_modules'), action: 'written' });

    const corePath = join(snapshot.configTargetDir, 'node_modules', '@flowguard', 'core');
    if (!existsSync(corePath)) {
      await rollbackArtifacts(snapshot.rollbackEntries, ctx.ops, ctx.warnings);
      ctx.errors.push(
        'ERROR: Dependencies installed but @flowguard/core not found.\n' +
          '  FlowGuard artifacts were rolled back. The package.json may need manual review.',
      );
    }
  } catch (err) {
    await rollbackArtifacts(snapshot.rollbackEntries, ctx.ops, ctx.warnings);
    ctx.errors.push(
      `ERROR: Dependency install failed: ${err instanceof Error ? err.message : String(err)}\n` +
        '  FlowGuard artifacts were rolled back. Recovery: re-run `flowguard install --force`.',
    );
  }
}

// ─── Step: Post-install warnings ─────────────────────────────────────────────

export function emitPostInstallWarnings(ctx: InstallContext): void {
  const { installPlatform, target, args } = ctx;

  if (installPlatform === 'claude-code') {
    ctx.warnings.push(
      `Load FlowGuard in Claude Code with: claude --plugin-dir ${join(target, 'flowguard-plugin')}`,
    );
  } else if (installPlatform === 'codex') {
    ctx.warnings.push(
      `Codex marketplace registration: ${codexInstallStatus(args.installScope)} at ${resolveCodexMarketplacePath(args.installScope)}`,
    );
    ctx.warnings.push('Codex native plugin load: NOT_VERIFIED_NATIVE_LOAD');
    ctx.warnings.push(
      'Codex plugin hooks require [features].plugin_hooks = true and /hooks trust review before enforcement is verified.',
    );
  } else {
    ctx.warnings.push(
      'Restart OpenCode to activate FlowGuard (plugins are loaded once at startup).',
    );
  }
}

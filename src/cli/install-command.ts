/**
 * @module cli/install-command
 * @description FlowGuard install command implementation.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { globalConfigPath } from '../adapters/persistence.js';
import { readConfig, writeGlobalConfig, writeRepoConfig } from '../adapters/persistence-config.js';
import { getAdapterLogger } from '../logging/adapter-logger.js';
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
  type CliResult,
  type FileOp,
  FLOWGUARD_TARBALL_PATTERN,
  PACKAGE_VERSION,
  computeMandatesDigest,
  ensureDir,
  mergeOpencodeJson,
  mergePackageJson,
  reviewerDefinitionForPlatform,
  resolveOpencodeConfigPath,
  resolveTarget,
  verifyTarballChecksum,
  writeIfAbsent,
} from './install-helpers.js';

const DEPENDENCY_INSTALL_TIMEOUT_MS = 300_000;

/** Detect available package manager. Prefers bun (OpenCode runtime), falls back to npm. */
export function detectPackageManager(): 'bun' | 'npm' | null {
  // Uses execSync (shell) for reliable PATH resolution across all platforms.
  const opts = { stdio: 'ignore' as const, timeout: 5_000 };
  try {
    execSync('bun --version', opts);
    return 'bun';
  } catch {
    // bun not available
  }
  try {
    execSync('npm --version', opts);
    return 'npm';
  } catch {
    // npm not available
  }
  return null;
}

function dependencyInstallCommand(pm: 'bun' | 'npm'): string {
  if (pm === 'npm') return 'npm install --no-audit --no-fund';
  return 'bun install';
}

/** Pre-install snapshot for transactional rollback. */
interface RollbackEntry {
  path: string;
  existed: boolean;
  originalContent?: Buffer;
}

/**
 * Snapshot a file path before any modification.
 * Reads original content as Buffer so binary artifacts (e.g. tarball) are preserved exactly.
 */
async function snapshotForRollback(filePath: string): Promise<RollbackEntry> {
  if (existsSync(filePath)) {
    try {
      const content = await readFile(filePath);
      return { path: filePath, existed: true, originalContent: content };
    } catch {
      return { path: filePath, existed: true };
    }
  }
  return { path: filePath, existed: false };
}

/**
 * Rollback install artifacts after a failed auto-install step.
 *
 * Uniform semantics:
 * - existed before install (has originalContent) -> restore original content
 * - existed before install (no content, e.g. directory) -> leave untouched
 * - did not exist before install -> delete (remove file/directory)
 */
async function rollbackArtifacts(
  entries: RollbackEntry[],
  ops: FileOp[],
  warnings: string[],
): Promise<void> {
  for (const entry of [...entries].reverse()) {
    try {
      if (entry.existed && entry.originalContent !== undefined) {
        // Pre-existing content -> restore original (byte-safe for binary files)
        await writeFile(entry.path, entry.originalContent);
        ops.push({ path: entry.path, action: 'written', reason: 'restored pre-install content' });
      } else if (entry.existed) {
        // Pre-existing directory or unreadable file -> leave untouched
        continue;
      } else if (existsSync(entry.path)) {
        // Newly created -> delete
        await rm(entry.path, { recursive: true, force: true });
        ops.push({ path: entry.path, action: 'removed', reason: 'rollback after failure' });
      }
    } catch (rollbackErr) {
      warnings.push(
        `Rollback failed for ${entry.path}: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
      );
    }
  }
}

/**
 * Install FlowGuard into the target OpenCode config directory.
 *
 * Writes managed artifacts and merge-managed files, then auto-installs
 * dependencies. On failure, rolls back written artifacts to leave a clean state.
 *
 * @param args - Parsed CLI arguments.
 * @returns Result with file operations, warnings, and any errors.
 */
export async function install(args: CliArgs): Promise<CliResult> {
  const installPlatform = args.installPlatform ?? 'opencode';
  const target = resolveTarget(args.installScope, installPlatform);
  const ops: FileOp[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    // 0. Validate --core-tarball is required
    if (!args.coreTarball) {
      errors.push(
        `ERROR: --core-tarball is required.\n` +
          `Usage: npx --package ./flowguard-core-${PACKAGE_VERSION()}.tgz flowguard install --core-tarball ./flowguard-core-${PACKAGE_VERSION()}.tgz\n` +
          `Download from: https://github.com/koeppben23/governed-runtime/releases`,
      );
      return { target, ops, errors, warnings };
    }

    // Resolve tarball path (support relative paths)
    const tarballPath = resolve(args.coreTarball);

    // 0b. Verify tarball exists
    if (!existsSync(tarballPath)) {
      errors.push(`ERROR: Core tarball not found: ${tarballPath}`);
      return { target, ops, errors, warnings };
    }

    // 0c. Extract version from tarball filename
    const tarballName = basename(tarballPath);
    const versionMatch = tarballName.match(FLOWGUARD_TARBALL_PATTERN);
    if (!versionMatch) {
      errors.push(
        'ERROR: Tarball filename must match flowguard-core-{version}.tgz\n' +
          `  Found: ${tarballName}`,
      );
      return { target, ops, errors, warnings };
    }
    const tarballVersion = versionMatch[1];

    // 0d. Verify version matches installer version
    if (tarballVersion !== PACKAGE_VERSION()) {
      errors.push(
        `ERROR: Version mismatch.\n` +
          `  Tarball: ${tarballVersion}\n` +
          `  Installer: ${PACKAGE_VERSION()}\n` +
          `  Please use the correct tarball version.`,
      );
      return { target, ops, errors, warnings };
    }

    // 0e. Opt-in tarball integrity verification via checksums file
    if (args.checksumsFile) {
      try {
        await verifyTarballChecksum(tarballPath, args.checksumsFile);
      } catch (err) {
        errors.push(
          `ERROR: Tarball integrity check failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { target, ops, errors, warnings };
      }
    } else {
      warnings.push(
        'Tarball integrity not verified. ' +
          'Use --checksums-file ./checksums.sha256 for cryptographic verification.',
      );
    }

    // Claude Code and Codex receive plugin trees instead of duplicate standalone host files.
    if (installPlatform !== 'claude-code' && installPlatform !== 'codex') {
      await ensureDir(join(target, 'tools'));
      await ensureDir(join(target, 'plugins'));
      await ensureDir(join(target, 'commands'));
      await ensureDir(join(target, 'agents'));
    }

    // -- Transactional rollback: resolve paths + snapshot BEFORE any file write --
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

    // Snapshot ALL paths that will be touched -- before any file is modified
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
      // node_modules: only remove if it was created by this install
      {
        path: join(configTargetDir, 'node_modules'),
        existed: existsSync(join(configTargetDir, 'node_modules')),
      },
    ];

    // 1. Copy tarball to vendor directory
    await ensureDir(vendorPath);
    await copyFile(tarballPath, vendorTarballPath);
    ops.push({ path: vendorTarballPath, action: 'written' });

    // 2. flowguard-mandates.md (always replace -- managed artifact)
    const digest = computeMandatesDigest();
    const mandatesContent = buildMandatesContent(PACKAGE_VERSION(), digest);
    await ensureDir(dirname(mandatesPath));
    await writeFile(mandatesPath, mandatesContent, 'utf-8');
    ops.push({ path: mandatesPath, action: 'written' });

    if (installPlatform === 'claude-code') {
      ops.push(...(await installClaudeCodePlugin(target, PACKAGE_VERSION(), args.force)));
      ops.push(await writeClaudeCodePluginInstallHint(target));
    } else if (installPlatform === 'codex') {
      ops.push(...(await installCodexPlugin(args.installScope, PACKAGE_VERSION(), args.force)));
    } else {
      ops.push(
        await writeIfAbsent(join(target, 'tools', 'flowguard.ts'), TOOL_WRAPPER, args.force),
      );

      ops.push(
        await writeIfAbsent(
          join(target, 'plugins', 'flowguard-audit.ts'),
          PLUGIN_WRAPPER,
          args.force,
        ),
      );

      for (const [name, content] of Object.entries(COMMANDS)) {
        ops.push(await writeIfAbsent(join(target, 'commands', name), content, args.force));
      }

      ops.push(await writeIfAbsent(reviewerPath, reviewerDefinition.content, args.force));
    }

    // 7. package.json (merge) -- now uses @flowguard/opencode-runtime with file:-dependency
    ops.push(await mergePackageJson(pkgPath, PACKAGE_VERSION()));

    // 8. opencode.json (OpenCode only; Claude/Codex use native agents/subagents)
    if (opencodeJsonPath) {
      ops.push(await mergeOpencodeJson(opencodeJsonPath, args.installScope));
    }

    // 9. flowguard.json (required artifact -- flat path, no fingerprint)
    // Non-opencode: write-first with flag 'wx' (exclusive create) to avoid
    // TOCTOU between existsSync and writeFile. EEXIST triggers the force-merge
    // path; otherwise the write succeeds atomically.
    // OpenCode paths use readConfig/writeRepoConfig/writeGlobalConfig which
    // internally handle existence.
    if (installPlatform !== 'opencode') {
      const config = {
        ...DEFAULT_CONFIG,
        policy: { ...DEFAULT_CONFIG.policy, defaultMode: args.policyMode },
      };
      await ensureDir(dirname(cfgPath));
      try {
        await writeFile(cfgPath, JSON.stringify(config, null, 2) + '\n', {
          encoding: 'utf-8',
          flag: 'wx',
        });
        ops.push({ path: cfgPath, action: 'written' });
      } catch (err) {
        if (!(err instanceof Error && 'code' in err && err.code === 'EEXIST') || !args.force) {
          if (err instanceof Error && 'code' in err && err.code === 'EEXIST') {
            // File exists, not forced — skip silently
          } else {
            throw err;
          }
        } else {
          const existing = JSON.parse(await readFile(cfgPath, 'utf-8'));
          existing.policy.defaultMode = args.policyMode;
          await writeFile(cfgPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
          ops.push({ path: cfgPath, action: 'merged', reason: 'policy mode updated via --force' });
        }
      }
    } else if (!existsSync(cfgPath)) {
      const config = {
        ...DEFAULT_CONFIG,
        policy: { ...DEFAULT_CONFIG.policy, defaultMode: args.policyMode },
      };
      if (args.installScope === 'global') {
        await writeGlobalConfig(config);
      } else {
        await writeRepoConfig(resolve('.'), config);
      }
      if (!existsSync(cfgPath)) {
        throw new Error(`CONFIG_WRITE_FAILED: config is required but missing at ${cfgPath}`);
      }
      ops.push({ path: cfgPath, action: 'written' });
    } else if (args.force) {
      const existing = await readConfig(args.installScope === 'repo' ? resolve('.') : undefined);
      existing.policy.defaultMode = args.policyMode;
      if (args.installScope === 'global') {
        await writeGlobalConfig(existing);
      } else {
        await writeRepoConfig(resolve('.'), existing);
      }
      ops.push({ path: cfgPath, action: 'merged', reason: 'policy mode updated via --force' });
    }

    // -- Auto-install dependencies ------------------------------------------------

    const pm = detectPackageManager();
    if (pm === null) {
      await rollbackArtifacts(rollbackEntries, ops, warnings);
      errors.push(
        'ERROR: Neither bun nor npm found in PATH.\n' +
          `  FlowGuard artifacts were rolled back. Recovery:\n` +
          `    1. Install bun (https://bun.sh) or Node.js/npm.\n` +
          `    2. Re-run: flowguard install --force`,
      );
      return { target, ops, errors, warnings };
    }

    try {
      execSync(dependencyInstallCommand(pm), {
        cwd: configTargetDir,
        stdio: 'pipe',
        timeout: DEPENDENCY_INSTALL_TIMEOUT_MS,
      });
      ops.push({ path: join(configTargetDir, 'node_modules'), action: 'written' });

      // Verify @flowguard/core was resolved
      const corePath = join(configTargetDir, 'node_modules', '@flowguard', 'core');
      if (!existsSync(corePath)) {
        await rollbackArtifacts(rollbackEntries, ops, warnings);
        errors.push(
          'ERROR: Dependencies installed but @flowguard/core not found.\n' +
            '  FlowGuard artifacts were rolled back. The package.json may need manual review.',
        );
      }
    } catch (err) {
      await rollbackArtifacts(rollbackEntries, ops, warnings);
      errors.push(
        `ERROR: Dependency install failed: ${err instanceof Error ? err.message : String(err)}\n` +
          '  FlowGuard artifacts were rolled back. Recovery: re-run `flowguard install --force`.',
      );
    }

    if (installPlatform === 'claude-code') {
      warnings.push(
        `Load FlowGuard in Claude Code with: claude --plugin-dir ${join(target, 'flowguard-plugin')}`,
      );
    } else if (installPlatform === 'codex') {
      warnings.push(
        `Codex marketplace registration: ${codexInstallStatus(args.installScope)} at ${resolveCodexMarketplacePath(args.installScope)}`,
      );
      warnings.push('Codex native plugin load: NOT_VERIFIED_NATIVE_LOAD');
      warnings.push(
        'Codex plugin hooks require [features].plugin_hooks = true and /hooks trust review before enforcement is verified.',
      );
    } else {
      warnings.push('Restart OpenCode to activate FlowGuard (plugins are loaded once at startup).');
    }
  } catch (err) {
    getAdapterLogger().error('cli', 'install command failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    errors.push(err instanceof Error ? err.message : String(err));
  }

  return { target, ops, errors, warnings };
}

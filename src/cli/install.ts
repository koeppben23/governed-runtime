#!/usr/bin/env node
/**
 * @module cli/install
 * @description CLI for installing/uninstalling FlowGuard into an OpenCode environment.
 *
 * Types, constants, and utility functions extracted to install-helpers.ts.
 * This module contains only CLI entry-point logic.
 */

import { existsSync, realpathSync, statSync } from 'node:fs';
import { writeFile, copyFile, rm, readdir } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import {
  TOOL_WRAPPER,
  PLUGIN_WRAPPER,
  COMMANDS,
  REVIEWER_AGENT,
  REVIEWER_AGENT_FILENAME,
  MANDATES_FILENAME,
  buildMandatesContent,
  extractManagedDigest,
  extractManagedVersion,
  extractManagedBody,
  isManagedArtifact,
  mandatesInstructionEntry,
  LEGACY_INSTRUCTION_ENTRY,
} from './templates.js';
import { configPath, readConfig, writeConfig } from '../adapters/persistence.js';
import { PersistenceError } from '../adapters/persistence.js';
import { DEFAULT_CONFIG } from '../config/flowguard-config.js';
import {
  ensureWorkspace,
  workspacesHome,
  computeFingerprint,
  workspaceDir as resolveWorkspaceDir,
} from '../adapters/workspace/index.js';
import {
  type InstallScope,
  type PolicyMode,
  type CliAction,
  type CliArgs,
  type FileOp,
  type CliResult,
  type DoctorStatus,
  type DoctorCheck,
  PACKAGE_VERSION,
  FLOWGUARD_OWNED_FILES,
  resolveTarget,
  sha256,
  computeMandatesDigest,
  ensureDir,
  safeRead,
  safeUnlink,
  vendorDependency,
  writeIfAbsent,
  mergePackageJson,
  mergeOpencodeJson,
  removeFromOpencodeJson,
} from './install-helpers.js';

// ─── Re-exports for backward compatibility ─────────────────────────────────
export {
  type InstallScope,
  type PolicyMode,
  type CliAction,
  type CliArgs,
  type FileOp,
  type CliResult,
  type DoctorStatus,
  type DoctorCheck,
} from './install-helpers.js';
export {
  resolveTarget,
  sha256,
  computeMandatesDigest,
  mergeReviewerTaskPermission,
} from './install-helpers.js';

// ─── Install ──────────────────────────────────────────────────────────────────
// ─── Install ──────────────────────────────────────────────────────────────────

/**
 * Install FlowGuard into the target directory.
 *
 * Ownership semantics:
 * - flowguard-mandates.md: ALWAYS replaced (hard-managed, versioned, digest-tracked)
 * - tools/plugins/commands: write if absent, --force to replace (hard-managed)
 * - package.json: merge (merge-managed)
 * - opencode.json: merge with migration (merge-managed)
 * - AGENTS.md: NEVER touched (user-owned)
 *
 * @param args - Parsed CLI arguments.
 * @returns Result with file operations, warnings, and any errors.
 */
export async function install(args: CliArgs): Promise<CliResult> {
  const target = resolveTarget(args.installScope);
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
    const versionMatch = tarballName.match(
      /^flowguard-core-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.tgz$/,
    );
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

    // Ensure base directories
    await ensureDir(join(target, 'tools'));
    await ensureDir(join(target, 'plugins'));
    await ensureDir(join(target, 'commands'));
    await ensureDir(join(target, 'agents'));

    // 1. Copy tarball to vendor directory (fixed path for A1 model)
    const vendorPath = join(target, 'vendor');
    await ensureDir(vendorPath);
    const vendorTarballPath = join(vendorPath, tarballName);
    await copyFile(tarballPath, vendorTarballPath);
    ops.push({ path: vendorTarballPath, action: 'written' });

    // 2. flowguard-mandates.md (always replace — managed artifact)
    const digest = computeMandatesDigest();
    const mandatesContent = buildMandatesContent(PACKAGE_VERSION(), digest);
    const mandatesPath = join(target, MANDATES_FILENAME);
    await ensureDir(dirname(mandatesPath));
    await writeFile(mandatesPath, mandatesContent, 'utf-8');
    ops.push({ path: mandatesPath, action: 'written' });

    // 3. Tool wrapper (write if absent, --force to replace)
    ops.push(await writeIfAbsent(join(target, 'tools', 'flowguard.ts'), TOOL_WRAPPER, args.force));

    // 4. Plugin wrapper (write if absent, --force to replace)
    ops.push(
      await writeIfAbsent(
        join(target, 'plugins', 'flowguard-audit.ts'),
        PLUGIN_WRAPPER,
        args.force,
      ),
    );

    // 5. Command files (write if absent, --force to replace)
    for (const [name, content] of Object.entries(COMMANDS)) {
      ops.push(await writeIfAbsent(join(target, 'commands', name), content, args.force));
    }

    // 6. Review subagent definition (write if absent, --force to replace)
    ops.push(
      await writeIfAbsent(
        join(target, 'agents', REVIEWER_AGENT_FILENAME),
        REVIEWER_AGENT,
        args.force,
      ),
    );

    // 7. package.json (merge) — now uses @flowguard/opencode-runtime with file:-dependency
    ops.push(await mergePackageJson(join(target, 'package.json'), PACKAGE_VERSION()));

    // 8. opencode.json (merge with migration)
    //    - global: merge into ~/.config/opencode/opencode.json
    //    - repo: merge into ./opencode.json (project root, parent of .opencode/)
    const opencodeJsonPath =
      args.installScope === 'global'
        ? join(target, 'opencode.json')
        : join(resolve('.'), 'opencode.json');
    ops.push(await mergeOpencodeJson(opencodeJsonPath, args.installScope));

    // 9. Workspace config.json (required artifact)
    // Persists args.policyMode as config.policy.defaultMode so that
    // /hydrate without explicit mode uses the installer's intent.
    // Priority: existing config preserved (unless --force), new config written with policyMode.
    const { workspaceDir: wsDir } = await ensureWorkspace(resolve('.'));
    const cfgPath = configPath(wsDir);
    if (!existsSync(cfgPath)) {
      const config = {
        ...DEFAULT_CONFIG,
        policy: { ...DEFAULT_CONFIG.policy, defaultMode: args.policyMode },
      };
      await writeConfig(wsDir, config);
      if (!existsSync(cfgPath)) {
        throw new Error(
          `WORKSPACE_CONFIG_WRITE_FAILED: workspace config is required but missing at ${cfgPath}`,
        );
      }
      ops.push({ path: cfgPath, action: 'written' });
    } else if (args.force) {
      const existing = await readConfig(wsDir);
      existing.policy.defaultMode = args.policyMode;
      await writeConfig(wsDir, existing);
      ops.push({ path: cfgPath, action: 'merged', reason: 'policy mode updated via --force' });
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  return { target, ops, errors, warnings };
}

// ─── Uninstall ────────────────────────────────────────────────────────────────

/**
 * Uninstall FlowGuard from the target directory.
 *
 * Removes all FlowGuard-owned files including flowguard-mandates.md.
 * Reports warnings for modified managed artifacts.
 * Cleans FlowGuard instruction entries from opencode.json.
 * Never touches AGENTS.md.
 *
 * @param args - Parsed CLI arguments.
 * @returns Result with file operations, warnings, and any errors.
 */
export async function uninstall(args: CliArgs): Promise<CliResult> {
  const target = resolveTarget(args.installScope);
  const ops: FileOp[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    // Remove FlowGuard-owned files
    for (const relPath of FLOWGUARD_OWNED_FILES) {
      const fullPath = join(target, relPath);

      // For flowguard-mandates.md, check if modified before removing
      if (relPath === MANDATES_FILENAME) {
        const content = await safeRead(fullPath);
        if (content !== null) {
          if (isManagedArtifact(content)) {
            const fileDigest = extractManagedDigest(content);
            const expectedDigest = computeMandatesDigest();
            const fileBody = extractManagedBody(content);
            const bodyModified = fileBody !== null && sha256(fileBody) !== expectedDigest;
            if ((fileDigest && fileDigest !== expectedDigest) || bodyModified) {
              warnings.push(`${MANDATES_FILENAME} was locally modified — removed anyway`);
            }
          } else {
            warnings.push(`${MANDATES_FILENAME} has no managed header — removed anyway`);
          }
        }
      }

      // Handle vendor directory specially (recursively remove)
      if (relPath === 'vendor') {
        try {
          if (existsSync(fullPath)) {
            await rm(fullPath, { recursive: true, force: true });
            ops.push({ path: fullPath, action: 'removed' });
          } else {
            ops.push({ path: fullPath, action: 'not_found' });
          }
          continue;
        } catch {
          ops.push({ path: fullPath, action: 'not_found' });
          continue;
        }
      }

      const removed = await safeUnlink(fullPath);
      ops.push({
        path: fullPath,
        action: removed ? 'removed' : 'not_found',
      });
    }

    // Remove @flowguard/core from package.json
    const pkgPath = join(target, 'package.json');
    const pkgContent = await safeRead(pkgPath);
    if (pkgContent) {
      try {
        const parsed = JSON.parse(pkgContent) as Record<string, unknown>;
        const deps = (parsed['dependencies'] ?? {}) as Record<string, string>;
        delete deps['@flowguard/core'];
        delete deps['@opencode-ai/plugin']; // Clean up legacy dep too
        parsed['dependencies'] = deps;
        await writeFile(pkgPath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
        ops.push({ path: pkgPath, action: 'merged', reason: 'removed FlowGuard dependencies' });
      } catch {
        ops.push({ path: pkgPath, action: 'skipped', reason: 'malformed JSON' });
      }
    }

    // Remove FlowGuard instruction entries from opencode.json
    const opencodeJsonPath =
      args.installScope === 'global'
        ? join(target, 'opencode.json')
        : join(resolve('.'), 'opencode.json');
    ops.push(await removeFromOpencodeJson(opencodeJsonPath, args.installScope));
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  return { target, ops, errors, warnings };
}

// ─── Doctor ───────────────────────────────────────────────────────────────────

/**
 * Verify the FlowGuard installation is correct and complete.
 *
 * Extended status model for managed artifacts:
 * - ok: file present, content/digest matches
 * - missing: file not found
 * - modified: file present, managed header found, digest mismatch
 * - unmanaged: file present, no managed header
 * - version_mismatch: file present, digest ok, header version != installed version
 * - instruction_missing: flowguard-mandates.md ok but opencode.json doesn't reference it
 * - instruction_stale: legacy "AGENTS.md" entry still in opencode.json instructions
 * - error: other problems (e.g. malformed JSON)
 *
 * @param args - Parsed CLI arguments.
 * @returns Array of check results.
 */
// ─── Doctor Phase Helpers ─────────────────────────────────────────────────────

/** Check managed artifacts: mandates.md, tool wrapper, plugin wrapper, commands. */
async function checkManagedArtifacts(target: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  // 1. flowguard-mandates.md (digest verification)
  const mandatesPath = join(target, MANDATES_FILENAME);
  const mandatesContent = await safeRead(mandatesPath);
  if (!mandatesContent) {
    checks.push({ file: mandatesPath, status: 'missing' });
  } else if (!isManagedArtifact(mandatesContent)) {
    checks.push({ file: mandatesPath, status: 'unmanaged', detail: 'no managed-artifact header' });
  } else {
    const fileDigest = extractManagedDigest(mandatesContent);
    const expectedDigest = computeMandatesDigest();
    const fileVersion = extractManagedVersion(mandatesContent);
    const fileBody = extractManagedBody(mandatesContent);

    if (!fileDigest) {
      checks.push({
        file: mandatesPath,
        status: 'error',
        detail: 'managed header found but no digest',
      });
    } else if (fileDigest !== expectedDigest) {
      checks.push({
        file: mandatesPath,
        status: 'modified',
        detail: 'content-digest mismatch — file was locally edited',
      });
    } else if (fileBody !== null && sha256(fileBody) !== fileDigest) {
      checks.push({
        file: mandatesPath,
        status: 'modified',
        detail: 'content-digest mismatch — file body was locally edited',
      });
    } else if (fileVersion !== PACKAGE_VERSION()) {
      checks.push({
        file: mandatesPath,
        status: 'version_mismatch',
        detail: `header v${fileVersion} != installed v${PACKAGE_VERSION()}`,
      });
    } else {
      checks.push({ file: mandatesPath, status: 'ok' });
    }
  }

  // 2. Tool wrapper
  const toolPath = join(target, 'tools', 'flowguard.ts');
  const toolContent = await safeRead(toolPath);
  if (!toolContent) {
    checks.push({ file: toolPath, status: 'missing' });
  } else if (toolContent.trim() !== TOOL_WRAPPER.trim()) {
    checks.push({ file: toolPath, status: 'modified', detail: 'content differs from template' });
  } else {
    checks.push({ file: toolPath, status: 'ok' });
  }

  // 3. Plugin wrapper
  const pluginPath = join(target, 'plugins', 'flowguard-audit.ts');
  const pluginContent = await safeRead(pluginPath);
  if (!pluginContent) {
    checks.push({ file: pluginPath, status: 'missing' });
  } else if (pluginContent.trim() !== PLUGIN_WRAPPER.trim()) {
    checks.push({ file: pluginPath, status: 'modified', detail: 'content differs from template' });
  } else {
    checks.push({ file: pluginPath, status: 'ok' });
  }

  // 4. Command files
  for (const [name, expectedContent] of Object.entries(COMMANDS)) {
    const cmdPath = join(target, 'commands', name);
    const cmdContent = await safeRead(cmdPath);
    if (!cmdContent) {
      checks.push({ file: cmdPath, status: 'missing' });
    } else if (cmdContent.trim() !== expectedContent.trim()) {
      checks.push({ file: cmdPath, status: 'modified', detail: 'content differs from template' });
    } else {
      checks.push({ file: cmdPath, status: 'ok' });
    }
  }

  return checks;
}

/** Check package.json A1 model + vendor tarball. */
async function checkDependencies(target: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  // 5. package.json (A1 model validation)
  const pkgPath = join(target, 'package.json');
  const pkgContent = await safeRead(pkgPath);
  if (!pkgContent) {
    checks.push({ file: pkgPath, status: 'missing' });
  } else {
    try {
      const parsed = JSON.parse(pkgContent) as Record<string, unknown>;
      const deps = (parsed['dependencies'] ?? {}) as Record<string, string>;
      const coreDep = deps['@flowguard/core'];
      const expectedDep = vendorDependency(PACKAGE_VERSION());

      if (!coreDep) {
        checks.push({
          file: pkgPath,
          status: 'error',
          detail: 'missing @flowguard/core dependency',
        });
      } else if (coreDep !== expectedDep) {
        checks.push({
          file: pkgPath,
          status: 'error',
          detail: `@flowguard/core must be "${expectedDep}" (got: ${coreDep})`,
        });
      } else {
        checks.push({ file: pkgPath, status: 'ok' });
      }
    } catch {
      checks.push({ file: pkgPath, status: 'error', detail: 'malformed JSON' });
    }
  }

  // Vendor tarball
  const vendorTarballPath = join(target, 'vendor', `flowguard-core-${PACKAGE_VERSION()}.tgz`);
  if (existsSync(vendorTarballPath)) {
    checks.push({ file: vendorTarballPath, status: 'ok' });
  } else {
    checks.push({
      file: vendorTarballPath,
      status: 'missing',
      detail: 'vendor tarball not found — run install with --core-tarball',
    });
  }

  return checks;
}

/** Check opencode.json instruction entries. */
async function checkOpencodeInstructions(
  target: string,
  scope: InstallScope,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  const opencodeJsonPath =
    scope === 'global' ? join(target, 'opencode.json') : join(resolve('.'), 'opencode.json');
  const opencodeContent = await safeRead(opencodeJsonPath);
  if (!opencodeContent) return checks;

  try {
    const parsed = JSON.parse(opencodeContent) as Record<string, unknown>;
    const instructions = Array.isArray(parsed['instructions'])
      ? (parsed['instructions'] as string[])
      : [];
    const entry = mandatesInstructionEntry(scope);

    if (!instructions.includes(entry)) {
      checks.push({
        file: opencodeJsonPath,
        status: 'instruction_missing',
        detail: `instructions array does not contain "${entry}"`,
      });
    }

    if (instructions.includes(LEGACY_INSTRUCTION_ENTRY)) {
      checks.push({
        file: opencodeJsonPath,
        status: 'instruction_stale',
        detail: `legacy "${LEGACY_INSTRUCTION_ENTRY}" entry still in instructions — run install to migrate`,
      });
    }

    const hasIssue = checks.some(
      (c) =>
        c.file === opencodeJsonPath &&
        (c.status === 'instruction_missing' || c.status === 'instruction_stale'),
    );
    if (!hasIssue) {
      checks.push({ file: opencodeJsonPath, status: 'ok' });
    }
  } catch {
    checks.push({ file: opencodeJsonPath, status: 'error', detail: 'malformed JSON' });
  }

  return checks;
}

/** Check workspace config.json. */
async function checkWorkspaceConfig(): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  try {
    // Read-only: doctor must not materialize workspace directories.
    const fpResult = await computeFingerprint(resolve('.'));
    const wsDir = resolveWorkspaceDir(fpResult.fingerprint);
    const cfgPath = configPath(wsDir);
    try {
      const config = await readConfig(wsDir);
      const fileExists = existsSync(cfgPath);
      if (!fileExists) {
        checks.push({
          file: cfgPath,
          status: 'error',
          detail:
            'WORKSPACE_CONFIG_MISSING: workspace config is required; run /hydrate or reinstall',
        });
      } else {
        const hasCustom =
          config.logging.level !== 'info' ||
          config.policy.defaultMode !== undefined ||
          config.policy.maxSelfReviewIterations !== undefined ||
          config.policy.maxImplReviewIterations !== undefined ||
          config.profile.defaultId !== undefined ||
          config.profile.activeChecks !== undefined;
        checks.push({
          file: cfgPath,
          status: 'ok',
          detail: hasCustom ? 'config valid (customized)' : 'config valid (defaults only)',
        });
      }
    } catch (err) {
      if (err instanceof PersistenceError) {
        if (err.code === 'PARSE_FAILED' || err.code === 'SCHEMA_VALIDATION_FAILED') {
          checks.push({ file: cfgPath, status: 'error', detail: err.message });
        } else {
          checks.push({
            file: cfgPath,
            status: 'error',
            detail: `cannot read config: ${err.message}`,
          });
        }
      } else {
        checks.push({
          file: cfgPath,
          status: 'error',
          detail: `unexpected error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  } catch (err) {
    checks.push({
      file: 'config.json',
      status: 'error',
      detail: `cannot resolve workspace: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return checks;
}

/** Check for config-only workspace directories missing workspace.json. */
async function checkWorkspaceMetadata(): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  try {
    const wsHome = workspacesHome();
    let entries: string[];
    try {
      entries = await readdir(wsHome);
    } catch {
      return checks;
    }

    for (const entry of entries) {
      if (!/^[0-9a-f]{24}$/.test(entry)) continue;
      const wsDir = join(wsHome, entry);
      const hasConfig = existsSync(join(wsDir, 'config.json'));
      const hasWorkspaceJson = existsSync(join(wsDir, 'workspace.json'));

      if (hasConfig && !hasWorkspaceJson) {
        let ageDays: number | undefined;
        try {
          const st = statSync(join(wsDir, 'config.json'));
          ageDays = Math.round((Date.now() - st.mtimeMs) / (24 * 60 * 60 * 1000));
        } catch {
          // stat failed — omit age
        }
        checks.push({
          file: join(wsDir, 'config.json'),
          status: 'warn',
          detail: [
            'WORKSPACE_METADATA_MISSING: config.json present but workspace.json missing.',
            ageDays !== undefined ? `Age: ${ageDays} days.` : '',
            'This workspace was not fully initialised.',
            'Repair is not automatic. Reinstall from the intended repository root after the fix,',
            'or remove stale config-only directories manually after verification.',
          ]
            .filter(Boolean)
            .join(' '),
        });
      }
    }
  } catch {
    // Non-critical — if we can't scan, don't fail the doctor
  }

  return checks;
}

export async function doctor(args: CliArgs): Promise<DoctorCheck[]> {
  const target = resolveTarget(args.installScope);
  const checks: DoctorCheck[] = [];
  checks.push(...(await checkManagedArtifacts(target)));
  checks.push(...(await checkDependencies(target)));
  checks.push(...(await checkOpencodeInstructions(target, args.installScope)));
  checks.push(...(await checkWorkspaceConfig()));
  checks.push(...(await checkWorkspaceMetadata()));
  return checks;
}

// ─── Argument Parsing ─────────────────────────────────────────────────────────

const VALID_POLICY_MODES: readonly PolicyMode[] = ['solo', 'team', 'team-ci', 'regulated'] as const;
const VALID_SCOPES: readonly InstallScope[] = ['global', 'repo'] as const;
const VALID_ACTIONS: readonly CliAction[] = [
  'install',
  'uninstall',
  'doctor',
  'run',
  'serve',
] as const;

/**
 * Parse CLI arguments from process.argv.
 *
 * Supports both new flags (--install-scope, --policy-mode) and deprecated
 * aliases (--global, --project, --mode) with warnings.
 *
 * @param argv - Raw argv (typically process.argv.slice(2)).
 * @returns Parsed arguments and deprecation warnings, or null if invalid.
 */
export function parseArgs(argv: string[]): { args: CliArgs; deprecations: string[] } | null {
  const action = argv[0] as CliAction | undefined;
  if (!action || !VALID_ACTIONS.includes(action)) {
    return null;
  }

  let installScope: InstallScope = 'global';
  let policyMode: PolicyMode = 'solo';
  let force = false;
  let coreTarball: string | undefined;
  const deprecations: string[] = [];

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      // ── New flags ──────────────────────────────────────────
      case '--install-scope': {
        const next = argv[i + 1];
        if (next && VALID_SCOPES.includes(next as InstallScope)) {
          installScope = next as InstallScope;
          i++;
        } else {
          return null;
        }
        break;
      }
      case '--policy-mode': {
        const next = argv[i + 1];
        if (next && VALID_POLICY_MODES.includes(next as PolicyMode)) {
          policyMode = next as PolicyMode;
          i++;
        } else {
          return null;
        }
        break;
      }
      case '--force':
        force = true;
        break;
      case '--core-tarball': {
        const next = argv[i + 1];
        if (next) {
          coreTarball = next;
          i++;
        } else {
          return null;
        }
        break;
      }

      // ── Deprecated aliases ─────────────────────────────────
      case '--global':
        installScope = 'global';
        deprecations.push('--global is deprecated, use --install-scope global');
        break;
      case '--project':
        installScope = 'repo';
        deprecations.push('--project is deprecated, use --install-scope repo');
        break;
      case '--mode': {
        const next = argv[i + 1];
        if (next && VALID_POLICY_MODES.includes(next as PolicyMode)) {
          policyMode = next as PolicyMode;
          deprecations.push('--mode is deprecated, use --policy-mode');
          i++;
        } else {
          return null;
        }
        break;
      }

      default:
        // Unknown argument
        return null;
    }
  }

  return {
    args: { action, installScope, policyMode, force, coreTarball },
    deprecations,
  };
}

// ─── CLI Entry Point ──────────────────────────────────────────────────────────

/**
 * Format a CliResult for human-readable console output.
 */
export function formatResult(result: CliResult): string {
  const lines: string[] = [];
  const written = result.ops.filter((o) => o.action === 'written').length;
  const merged = result.ops.filter((o) => o.action === 'merged').length;
  const skipped = result.ops.filter((o) => o.action === 'skipped').length;
  const removed = result.ops.filter((o) => o.action === 'removed').length;

  for (const op of result.ops) {
    const suffix = op.reason ? ` (${op.reason})` : '';
    lines.push(`  [${op.action}] ${op.path}${suffix}`);
  }

  lines.push('');
  if (written > 0) lines.push(`  Written: ${written} files`);
  if (merged > 0) lines.push(`  Merged:  ${merged} files`);
  if (skipped > 0) lines.push(`  Skipped: ${skipped} files`);
  if (removed > 0) lines.push(`  Removed: ${removed} files`);

  for (const w of result.warnings) {
    lines.push(`  [warn] ${w}`);
  }

  if (result.errors.length > 0) {
    lines.push('');
    for (const err of result.errors) {
      lines.push(`  [error] ${err}`);
    }
  }

  return lines.join('\n');
}

/**
 * Format doctor check results for console output.
 */
export function formatDoctor(checks: DoctorCheck[]): string {
  const lines: string[] = [];
  const iconMap: Record<DoctorStatus, string> = {
    ok: 'ok',
    missing: 'MISSING',
    modified: 'MODIFIED',
    unmanaged: 'UNMANAGED',
    version_mismatch: 'VERSION',
    instruction_missing: 'INSTR_MISSING',
    instruction_stale: 'INSTR_STALE',
    error: 'ERROR',
    warn: 'WARN',
  };

  for (const check of checks) {
    const suffix = check.detail ? ` — ${check.detail}` : '';
    lines.push(`  [${iconMap[check.status]}] ${check.file}${suffix}`);
  }

  const ok = checks.filter((c) => c.status === 'ok').length;
  const total = checks.length;
  lines.push('');
  lines.push(`  ${ok}/${total} checks passed`);

  return lines.join('\n');
}

function getUsage(): string {
  const v = PACKAGE_VERSION();
  return `\
Usage: flowguard <command> [options]

Commands:
  install     Install FlowGuard tools, plugins, and commands
  uninstall   Remove FlowGuard files
  doctor      Verify installation is correct and complete
  run         Execute FlowGuard commands in headless mode
  serve       Start an OpenCode server for headless operation

Options:
  --install-scope  Where to install: global (default) or repo
  --policy-mode    FlowGuard policy: solo (default), team, team-ci, regulated
  --force          Overwrite all managed artifacts
  --core-tarball   Path to flowguard-core-{version}.tgz (required for install)

Deprecated (still work):
  --global    → --install-scope global
  --project   → --install-scope repo
  --mode X    → --policy-mode X

Examples:
  npx --package ./flowguard-core-${v}.tgz flowguard install --core-tarball ./flowguard-core-${v}.tgz
  npx --package ./flowguard-core-${v}.tgz flowguard install --core-tarball ./flowguard-core-${v}.tgz --install-scope repo --policy-mode regulated
  npx --package ./flowguard-core-${v}.tgz flowguard doctor
  npx --package ./flowguard-core-${v}.tgz flowguard uninstall
  flowguard run -- "Run /hydrate policyMode=team-ci"
  flowguard serve --port 4096 --detach
`;
}

/**
 * CLI main entry point.
 * Only executes when this file is run directly (not when imported for testing).
 */
export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);

  if (!parsed) {
    console.log(getUsage());
    return 1;
  }

  const { args, deprecations } = parsed;

  // Emit deprecation warnings
  for (const d of deprecations) {
    console.error(`  [deprecated] ${d}`);
  }

  switch (args.action) {
    case 'install': {
      const result = await install(args);
      const targetLabel = args.installScope === 'global' ? '~/.config/opencode/' : './.opencode/';
      console.log(`Installing FlowGuard to ${targetLabel}...`);
      console.log(`  Install scope: ${args.installScope}`);
      console.log(`  Policy mode: ${args.policyMode}`);
      console.log('');
      console.log(formatResult(result));
      if (result.errors.length > 0) return 1;
      console.log('');
      console.log(`  Run 'npm install' in ${targetLabel} to install dependencies.`);
      return 0;
    }

    case 'uninstall': {
      const targetLabel = args.installScope === 'global' ? '~/.config/opencode/' : './.opencode/';
      const result = await uninstall(args);
      console.log(`Uninstalling FlowGuard from ${targetLabel}...`);
      console.log('');
      console.log(formatResult(result));
      return result.errors.length > 0 ? 1 : 0;
    }

    case 'doctor': {
      const targetLabel = args.installScope === 'global' ? '~/.config/opencode/' : './.opencode/';
      const checks = await doctor(args);
      console.log(`Checking FlowGuard installation at ${targetLabel}...`);
      console.log('');
      console.log(formatDoctor(checks));
      const allOk = checks.every((c) => c.status === 'ok');
      return allOk ? 0 : 1;
    }

    case 'run': {
      const { runMain } = await import('./run.js');
      return runMain(argv.slice(1));
    }

    case 'serve': {
      const { serveMain } = await import('./run.js');
      return serveMain(argv.slice(1));
    }
  }
}

// Auto-run when executed directly.
// realpathSync resolves symlinks so that both `flowguard` (symlink) and
// `install.js` (direct) executions trigger main().
const isDirectExecution =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]).endsWith('install.js');

if (isDirectExecution) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}

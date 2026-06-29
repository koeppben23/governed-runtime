/**
 * @module cli/doctor-command
 * @description FlowGuard doctor command implementation.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { globalConfigPath, PersistenceError } from '../adapters/persistence.js';
import { readConfig } from '../adapters/persistence-config.js';
import { FlowGuardConfigSchema } from '../config/flowguard-config.js';
import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';
import type { HostId } from '../shared/hosts.js';
import {
  COMMANDS,
  LEGACY_INSTRUCTION_ENTRY,
  MANDATES_FILENAME,
  PLUGIN_WRAPPER,
  REVIEWER_AGENT_FILENAME,
  TOOL_WRAPPER,
  extractManagedBody,
  extractManagedDigest,
  extractManagedVersion,
  isManagedArtifact,
  mandatesInstructionEntry,
} from './templates.js';
import {
  type CliArgs,
  type DoctorCheck,
  type InstallScope,
  PACKAGE_VERSION,
  SHIPPED_EXECUTABLE_CHECK,
  computeMandatesDigest,
  hasNonFlowGuardInstructions,
  parseJsonc,
  resolveOpencodeConfigPath,
  resolvePackageRoot,
  resolveTarget,
  safeRead,
  sha256,
  vendorDependency,
} from './install-helpers.js';
import { resolveClaudeCodePluginRoot } from './claude-code-plugin-install.js';
import { resolveCodexPluginRoot } from './codex-plugin-install.js';
import { buildPlatformTrustReport } from './platform-trust-report.js';

/**
 * Read a file for doctor inspection. Returns content or null.
 *
 * Pushes a DoctorCheck automatically:
 * - 'missing' when file does not exist (ENOENT)
 * - 'error' when file cannot be read (EACCES, EPERM, etc.)
 * Callers can check `if (!content) return/continue` without further checks.
 */
async function checkedRead(filePath: string, checks: DoctorCheck[]): Promise<string | null> {
  try {
    const content = await safeRead(filePath);
    if (content === null) {
      checks.push({ file: filePath, status: 'missing' });
    }
    return content;
  } catch (err: unknown) {
    const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
    const msg = err instanceof Error ? err.message : String(err);
    const detail = code ? `Cannot read (${code}): ${msg}` : `Cannot read: ${msg}`;
    checks.push({
      file: filePath,
      status: 'error',
      detail,
    });
    return null;
  }
}

/** Check managed artifacts: mandates.md, tool wrapper, plugin wrapper, commands. */
async function checkMandatesDigest(target: string, checks: DoctorCheck[]): Promise<void> {
  const mandatesPath = join(target, MANDATES_FILENAME);
  const mandatesContent = await checkedRead(mandatesPath, checks);
  if (!mandatesContent) return;
  if (!isManagedArtifact(mandatesContent)) {
    checks.push({ file: mandatesPath, status: 'unmanaged', detail: 'no managed-artifact header' });
    return;
  }
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

async function checkWrapperFile(
  target: string,
  subPath: string,
  expected: string,
  checks: DoctorCheck[],
): Promise<void> {
  const filePath = join(target, subPath);
  const content = await checkedRead(filePath, checks);
  if (!content) return;
  if (content.trim() !== expected.trim()) {
    checks.push({ file: filePath, status: 'modified', detail: 'content differs from template' });
  } else {
    checks.push({ file: filePath, status: 'ok' });
  }
}

async function checkCommandFiles(target: string, checks: DoctorCheck[]): Promise<void> {
  for (const [name, expectedContent] of Object.entries(COMMANDS)) {
    await checkWrapperFile(target, `commands/${name}`, expectedContent, checks);
  }
}

async function checkReviewerAgent(target: string, checks: DoctorCheck[]): Promise<void> {
  const agentPath = join(target, 'agents', REVIEWER_AGENT_FILENAME);
  const agentContent = await checkedRead(agentPath, checks);
  if (!agentContent) {
    const last = checks[checks.length - 1];
    if (last && last.file === agentPath && last.status === 'missing') {
      last.status = 'warn';
      last.detail = 'reviewer agent not installed — run flowguard install --force to restore';
    }
    return;
  }
  if (!agentContent.startsWith('---')) {
    checks.push({
      file: agentPath,
      status: 'warn',
      detail: 'agent file missing frontmatter — run flowguard install --force to restore',
    });
  } else {
    checks.push({ file: agentPath, status: 'ok' });
  }
}

async function checkManagedArtifacts(target: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  await checkMandatesDigest(target, checks);
  await checkWrapperFile(target, 'tools/flowguard.ts', TOOL_WRAPPER, checks);
  await checkWrapperFile(target, 'plugins/flowguard-audit.ts', PLUGIN_WRAPPER, checks);
  await checkCommandFiles(target, checks);
  await checkReviewerAgent(target, checks);
  return checks;
}

/** Check package.json A1 model + vendor tarball. */
async function checkDependencies(target: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  // 5. package.json (A1 model validation)
  const pkgPath = join(target, 'package.json');
  const pkgContent = await checkedRead(pkgPath, checks);
  if (!pkgContent) return checks;
  else {
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
  const opencodeJsonPath = resolveOpencodeConfigPath(scope, target);
  const opencodeContent = await checkedRead(opencodeJsonPath, checks);
  if (!opencodeContent) return checks;

  try {
    const parsed = parseJsonc(opencodeContent);
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

    checkDesktopTaskHardening(parsed, instructions, opencodeJsonPath, checks);
  } catch {
    checks.push({ file: opencodeJsonPath, status: 'error', detail: 'malformed JSON' });
  }

  return checks;
}

function checkDesktopTaskHardening(
  parsed: Record<string, unknown>,
  instructions: string[],
  path: string,
  checks: DoctorCheck[],
): void {
  const hasPluginField = Object.prototype.hasOwnProperty.call(parsed, 'plugin');
  const hasDesktopInstructions = hasNonFlowGuardInstructions(instructions);
  if (!hasPluginField && !hasDesktopInstructions) return;

  const agent = parsed['agent'] as Record<string, unknown> | undefined;
  const buildPerms = (agent?.['build'] as Record<string, unknown> | undefined)?.['permission'] as
    Record<string, unknown> | undefined;
  const taskPerms = buildPerms?.['task'] as Record<string, unknown> | undefined;
  const hasTaskHardening =
    taskPerms?.['*'] === 'deny' && taskPerms?.[REVIEWER_SUBAGENT_TYPE] === 'allow';
  if (!hasTaskHardening) {
    checks.push({
      file: path,
      status: 'warn',
      detail:
        'desktop-owned OpenCode config does not include FlowGuard reviewer task hardening; installer does not modify task permissions for desktop-owned configs',
    });
  }
}

/** Check FlowGuard config (flat path). Scope-aware: checks only the relevant config for the scope. */
async function checkWorkspaceConfig(
  scope: InstallScope,
  platform: HostId = 'opencode',
  target?: string,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const cwd = resolve('.');

  try {
    if (platform !== 'opencode') {
      return await checkPlatformWorkspaceConfig(scope, platform, target, checks);
    }

    if (scope === 'global') {
      const cfgPath = globalConfigPath();
      if (!existsSync(cfgPath)) {
        checks.push({
          file: cfgPath,
          status: 'error',
          detail: 'CONFIG_MISSING: FlowGuard global config not found; run flowguard install first',
        });
        return checks;
      }
      try {
        const config = await readConfig(); // no worktree = global only
        const hasCustom = detectCustomConfig(config);
        checks.push({
          file: cfgPath,
          status: 'ok',
          detail: hasCustom ? 'config valid (customized)' : 'config valid (defaults only)',
        });
      } catch (err) {
        pushConfigError(checks, cfgPath, err);
      }
    } else {
      // scope === 'repo': check only repo config, NO fallback to global
      const cfgPath = join(cwd, '.opencode', 'flowguard.json');
      if (!existsSync(cfgPath)) {
        checks.push({
          file: cfgPath,
          status: 'error',
          detail:
            'CONFIG_MISSING: FlowGuard repo config not found; run flowguard install --install-scope repo first',
        });
        return checks;
      }
      try {
        const config = await readConfig(cwd);
        const hasCustom = detectCustomConfig(config);
        checks.push({
          file: cfgPath,
          status: 'ok',
          detail: hasCustom ? 'config valid (customized)' : 'config valid (defaults only)',
        });
      } catch (err) {
        pushConfigError(checks, cfgPath, err);
      }
    }
  } catch (err) {
    checks.push({
      file: 'flowguard.json',
      status: 'error',
      detail: `cannot resolve workspace: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return checks;
}

async function checkPlatformWorkspaceConfig(
  scope: InstallScope,
  platform: HostId,
  target: string | undefined,
  checks: DoctorCheck[],
): Promise<DoctorCheck[]> {
  const cfgPath = join(target ?? resolveTarget(scope, platform), 'flowguard.json');
  const content = await checkedRead(cfgPath, checks);
  if (!content) return checks;

  try {
    const parsed = FlowGuardConfigSchema.parse(JSON.parse(content));
    const hasCustom = detectCustomConfig(parsed);
    checks.push({
      file: cfgPath,
      status: 'ok',
      detail: hasCustom ? 'config valid (customized)' : 'config valid (defaults only)',
    });
  } catch (err) {
    checks.push({
      file: cfgPath,
      status: 'error',
      detail: err instanceof Error ? err.message : 'malformed JSON',
    });
  }

  return checks;
}

/** Detect if config has been customized beyond installer defaults. */
function detectCustomConfig(config: {
  logging: { level: string };
  policy: Record<string, unknown>;
  profile: Record<string, unknown>;
}): boolean {
  return (
    config.logging.level !== 'info' ||
    config.policy.maxSelfReviewIterations !== undefined ||
    config.policy.maxImplReviewIterations !== undefined ||
    config.profile.defaultId !== undefined ||
    config.profile.activeChecks !== undefined
  );
}

/** Push a config-read error check. */
function pushConfigError(checks: DoctorCheck[], cfgPath: string, err: unknown): void {
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

export async function doctor(args: CliArgs): Promise<DoctorCheck[]> {
  const installPlatform = args.installPlatform ?? 'opencode';
  const target = resolveTarget(args.installScope, installPlatform);
  const checks: DoctorCheck[] = [];
  if (installPlatform === 'opencode') {
    checks.push(...(await checkManagedArtifacts(target)));
  } else {
    checks.push(
      ...(await checkPlatformPluginArtifacts(installPlatform, args.installScope, target)),
    );
  }
  checks.push(...(await checkDependencies(target)));
  if (installPlatform === 'opencode') {
    checks.push(...(await checkOpencodeInstructions(target, args.installScope)));
  }
  checks.push(...(await checkWorkspaceConfig(args.installScope, installPlatform, target)));
  if (installPlatform === 'opencode') {
    checks.push(...(await checkPluginActivation(target)));
    checks.push(...(await checkLastSessionHandshake(args.installScope)));
  }
  checks.push(...(await checkBrokenInstall(target)));
  checks.push(...checkShippedExecutables());
  checks.push(...buildPlatformTrustReport(installPlatform, args.installScope, target));
  return checks;
}

async function checkPlatformPluginArtifacts(
  platform: HostId,
  scope: InstallScope,
  target: string,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const pluginRoot =
    platform === 'claude-code'
      ? resolveClaudeCodePluginRoot(target)
      : resolveCodexPluginRoot(scope);
  const requiredFiles =
    platform === 'claude-code'
      ? [
          '.claude-plugin/plugin.json',
          '.mcp.json',
          'hooks/hooks.json',
          'agents/flowguard-reviewer.md',
        ]
      : [
          '.codex-plugin/plugin.json',
          '.mcp.json',
          'hooks/hooks.json',
          'subagents/flowguard-reviewer.md',
        ];

  for (const relativePath of requiredFiles) {
    const filePath = join(pluginRoot, relativePath);
    checks.push({
      file: filePath,
      status: existsSync(filePath) ? 'ok' : 'missing',
      detail: existsSync(filePath) ? 'configured; runtime load NOT_VERIFIED_RUNTIME' : undefined,
    });
  }

  return checks;
}

/** Node shebang every shipped FlowGuard executable must begin with. */
const EXPECTED_EXECUTABLE_SHEBANG = '#!/usr/bin/env node';

/**
 * Read the shipped-executable manifest (the `bin` map) from the FlowGuard
 * package.json at `packageRoot`. The `bin` map is the single SSOT for shipped
 * CLI/runtime executables — this is its only reader; doctor derives the validated
 * surface from it rather than from a hand-maintained duplicate list.
 *
 * Returns the bin map, or `null` when the manifest is unreadable or its `bin`
 * field is missing, empty, or not a string→string object. Callers MUST treat
 * `null` as a fail-closed error: a broken package manifest must not pass
 * diagnostics by silently validating zero executables.
 */
function readShippedExecutableManifest(packageRoot: string): Record<string, string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf-8'));
  } catch {
    return null;
  }
  const bin = (parsed as { bin?: unknown } | null)?.bin;
  if (typeof bin !== 'object' || bin === null || Array.isArray(bin)) return null;
  const entries = Object.entries(bin);
  if (entries.length === 0) return null;
  // All-or-error: a single non-string target means the bin SSOT is invalid, not
  // partially valid. Filtering bad entries would silently validate an incomplete
  // executable surface — a fail-closed violation.
  if (!entries.every((entry): entry is [string, string] => typeof entry[1] === 'string')) {
    return null;
  }
  return Object.fromEntries(entries);
}

/**
 * Validate one shipped executable. It must exist, be a regular file, be
 * non-empty, and begin with the Node shebang. Any deviation is a fail-closed
 * doctor failure (`missing`/`error`), never silently downgraded.
 *
 * Shebang presence — not a POSIX exec bit — is the corruption signal: the exec
 * bit is not cross-platform (Windows) and is not guaranteed by the installer's
 * file writes, whereas the shebang is emitted into every shipped bin entry.
 *
 * The file is read in a single operation with no separate existence/stat
 * pre-check: a check-then-read sequence is a time-of-check/time-of-use race
 * (CodeQL js/file-system-race). Existence and file-type are derived from the
 * read's own error codes (`ENOENT` → missing, `EISDIR` → not a regular file).
 */
function validateShippedExecutable(file: string): DoctorCheck {
  let content: string;
  try {
    content = readFileSync(file, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      return {
        file,
        status: 'missing',
        detail: 'shipped executable not found',
        check: SHIPPED_EXECUTABLE_CHECK,
      };
    }
    if (code === 'EISDIR') {
      return {
        file,
        status: 'error',
        detail: 'shipped executable is not a regular file',
        check: SHIPPED_EXECUTABLE_CHECK,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      file,
      status: 'error',
      detail: `cannot read shipped executable: ${msg}`,
      check: SHIPPED_EXECUTABLE_CHECK,
    };
  }
  if (content.length === 0) {
    return {
      file,
      status: 'error',
      detail: 'shipped executable is empty',
      check: SHIPPED_EXECUTABLE_CHECK,
    };
  }
  const firstLine = content.split('\n', 1)[0] ?? '';
  if (firstLine !== EXPECTED_EXECUTABLE_SHEBANG) {
    return {
      file,
      status: 'error',
      detail: 'shipped executable missing Node shebang (corrupt)',
      check: SHIPPED_EXECUTABLE_CHECK,
    };
  }
  return { file, status: 'ok', check: SHIPPED_EXECUTABLE_CHECK };
}

/**
 * Validate the shipped `dist/` executable surface declared in package.json `bin`.
 * The list is derived from that single SSOT, so adding a new bin entry is
 * validated automatically without a parallel hand-maintained list (#423). A
 * missing or invalid `bin` manifest fails closed with an explicit error check.
 *
 * `packageRoot` is injectable for tests; production resolves the running
 * FlowGuard package root.
 */
export function checkShippedExecutables(packageRoot: string = resolvePackageRoot()): DoctorCheck[] {
  const manifest = readShippedExecutableManifest(packageRoot);
  if (manifest === null) {
    return [
      {
        file: join(packageRoot, 'package.json'),
        status: 'error',
        detail:
          'package.json bin map missing, empty, or not an object — cannot validate shipped executables',
        check: SHIPPED_EXECUTABLE_CHECK,
      },
    ];
  }
  return Object.values(manifest).map((relativeTarget) =>
    validateShippedExecutable(join(packageRoot, relativeTarget)),
  );
}

/**
 * Detect "files installed but dependencies unresolved" broken state.
 * This happens when a previous install failed after writing assets but
 * before resolving dependencies.
 */
async function checkBrokenInstall(target: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const mandatesPath = join(target, MANDATES_FILENAME);
  const corePath = join(target, 'node_modules', '@flowguard', 'core');

  if (existsSync(mandatesPath) && !existsSync(corePath)) {
    checks.push({
      file: mandatesPath,
      status: 'error',
      detail:
        'FlowGuard files installed but dependencies unresolved — run `flowguard install --force` to repair, or `flowguard uninstall` to remove completely.',
    });
  }
  return checks;
}

/** Verify plugin file exists and @flowguard/core is ESM-importable. */
export async function checkPluginActivation(target: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const pluginFile = join(target, 'plugins', 'flowguard-audit.ts');

  if (!existsSync(pluginFile)) {
    checks.push({
      file: pluginFile,
      status: 'missing',
      detail: 'Plugin file not installed — run flowguard install',
    });
    return checks;
  }

  try {
    execSync(`node --input-type=module -e "import('@flowguard/core/integration/plugin')"`, {
      cwd: target,
      stdio: 'pipe',
      timeout: 10_000,
    });
    checks.push({
      file: pluginFile,
      status: 'ok',
      detail: 'Plugin package importable',
    });
  } catch {
    checks.push({
      file: pluginFile,
      status: 'error',
      detail:
        'Plugin package not importable — verify @flowguard/core is installed and dependencies are present',
    });
  }

  return checks;
}

async function checkObligationHandshake(
  pointer: { sessionId: string; worktree: string },
  pointerPath: string,
  checks: DoctorCheck[],
): Promise<void> {
  const { computeFingerprint } = await import('../adapters/workspace/fingerprint.js');
  const { sessionDir } = await import('../adapters/workspace/init.js');
  const fp = await computeFingerprint(pointer.worktree);
  const sessDir = sessionDir(fp.fingerprint, pointer.sessionId);

  if (!existsSync(join(sessDir, 'session-state.json'))) {
    checks.push({
      file: pointerPath,
      status: 'warn',
      detail: 'Session state file not found — cannot verify handshake',
    });
    return;
  }

  const stateRaw = readFileSync(join(sessDir, 'session-state.json'), 'utf-8');
  const state = JSON.parse(stateRaw) as Record<string, unknown>;
  const assurance = state.reviewAssurance as
    { obligations?: Array<{ status?: string; pluginHandshakeAt?: unknown }> } | undefined;

  const pendingObligation = assurance?.obligations?.find((o) => o.status === 'pending');
  if (!pendingObligation) return;

  if (pendingObligation.pluginHandshakeAt == null) {
    checks.push({
      file: pointerPath,
      status: 'error',
      detail:
        'Pending review obligation without plugin handshake — plugin enforcement hooks are not active. Restart OpenCode and verify flowguard-audit plugin loads.',
    });
  } else {
    checks.push({
      file: pointerPath,
      status: 'ok',
      detail: 'Last session plugin handshake present',
    });
  }
}

/** Check if the last session has a pending review obligation without plugin handshake. */
export async function checkLastSessionHandshake(scope: InstallScope): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  if (scope !== 'global') return checks;

  const pointerPath = join(
    process.env.OPENCODE_CONFIG_DIR || join(homedir(), '.config', 'opencode'),
    'SESSION_POINTER.json',
  );

  try {
    const raw = readFileSync(pointerPath, 'utf-8');
    const pointer = JSON.parse(raw) as { sessionId?: string; worktree?: string };
    if (!pointer.sessionId || !pointer.worktree) {
      checks.push({
        file: pointerPath,
        status: 'warn',
        detail: 'SESSION_POINTER.json missing sessionId or worktree — cannot verify handshake',
      });
      return checks;
    }
    await checkObligationHandshake(
      pointer as { sessionId: string; worktree: string },
      pointerPath,
      checks,
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      checks.push({
        file: pointerPath,
        status: 'warn',
        detail:
          'Cannot check session handshake: ' + (err instanceof Error ? err.message : String(err)),
      });
    }
  }

  return checks;
}

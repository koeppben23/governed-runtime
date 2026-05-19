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
import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';
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
  computeMandatesDigest,
  hasNonFlowGuardInstructions,
  parseJsonc,
  resolveOpencodeConfigPath,
  resolveTarget,
  safeRead,
  sha256,
  vendorDependency,
} from './install-helpers.js';

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
async function checkManagedArtifacts(target: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  // 1. flowguard-mandates.md (digest verification)
  const mandatesPath = join(target, MANDATES_FILENAME);
  const mandatesContent = await checkedRead(mandatesPath, checks);
  if (!mandatesContent) {
    // checkedRead already pushed missing or error
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
  const toolContent = await checkedRead(toolPath, checks);
  if (!toolContent) {
    // checkedRead already pushed missing or error
  } else if (toolContent.trim() !== TOOL_WRAPPER.trim()) {
    checks.push({ file: toolPath, status: 'modified', detail: 'content differs from template' });
  } else {
    checks.push({ file: toolPath, status: 'ok' });
  }

  // 3. Plugin wrapper
  const pluginPath = join(target, 'plugins', 'flowguard-audit.ts');
  const pluginContent = await checkedRead(pluginPath, checks);
  if (!pluginContent) {
    // checkedRead already pushed missing or error
  } else if (pluginContent.trim() !== PLUGIN_WRAPPER.trim()) {
    checks.push({ file: pluginPath, status: 'modified', detail: 'content differs from template' });
  } else {
    checks.push({ file: pluginPath, status: 'ok' });
  }

  // 4. Command files
  for (const [name, expectedContent] of Object.entries(COMMANDS)) {
    const cmdPath = join(target, 'commands', name);
    const cmdContent = await checkedRead(cmdPath, checks);
    if (!cmdContent) {
      // checkedRead already pushed missing or error
    } else if (cmdContent.trim() !== expectedContent.trim()) {
      checks.push({ file: cmdPath, status: 'modified', detail: 'content differs from template' });
    } else {
      checks.push({ file: cmdPath, status: 'ok' });
    }
  }

  // 5. Reviewer agent definition (warn, not error — system degrades gracefully)
  const agentPath = join(target, 'agents', REVIEWER_AGENT_FILENAME);
  const agentContent = await checkedRead(agentPath, checks);
  if (!agentContent) {
    // checkedRead pushed missing or error — override 'missing' to 'warn'
    const last = checks[checks.length - 1];
    if (last && last.file === agentPath && last.status === 'missing') {
      last.status = 'warn';
      last.detail = 'reviewer agent not installed — run flowguard install --force to restore';
    }
  } else if (!agentContent.startsWith('---')) {
    checks.push({
      file: agentPath,
      status: 'warn',
      detail: 'agent file missing frontmatter — run flowguard install --force to restore',
    });
  } else {
    checks.push({ file: agentPath, status: 'ok' });
  }

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

    // #107: Detect desktop-owned config without task hardening
    // Desktop-owned = has plugin field OR has non-FlowGuard instructions (mirrors installer logic)
    const hasPluginField = Object.prototype.hasOwnProperty.call(parsed, 'plugin');
    const hasDesktopInstructions = hasNonFlowGuardInstructions(instructions);
    if (hasPluginField || hasDesktopInstructions) {
      const agent = parsed['agent'] as Record<string, unknown> | undefined;
      const buildPerms = (agent?.['build'] as Record<string, unknown> | undefined)?.[
        'permission'
      ] as Record<string, unknown> | undefined;
      const taskPerms = buildPerms?.['task'] as Record<string, unknown> | undefined;
      const hasTaskHardening =
        taskPerms?.['*'] === 'deny' && taskPerms?.[REVIEWER_SUBAGENT_TYPE] === 'allow';
      if (!hasTaskHardening) {
        checks.push({
          file: opencodeJsonPath,
          status: 'warn',
          detail:
            'desktop-owned OpenCode config does not include FlowGuard reviewer task hardening; installer does not modify task permissions for desktop-owned configs',
        });
      }
    }
  } catch {
    checks.push({ file: opencodeJsonPath, status: 'error', detail: 'malformed JSON' });
  }

  return checks;
}

/** Check FlowGuard config (flat path). Scope-aware: checks only the relevant config for the scope. */
async function checkWorkspaceConfig(scope: InstallScope): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const cwd = resolve('.');

  try {
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
  const target = resolveTarget(args.installScope);
  const checks: DoctorCheck[] = [];
  checks.push(...(await checkManagedArtifacts(target)));
  checks.push(...(await checkDependencies(target)));
  checks.push(...(await checkOpencodeInstructions(target, args.installScope)));
  checks.push(...(await checkWorkspaceConfig(args.installScope)));
  checks.push(...(await checkPluginActivation(target)));
  checks.push(...(await checkLastSessionHandshake(args.installScope)));
  checks.push(...(await checkBrokenInstall(target)));
  return checks;
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

/** Check if the last session has a pending review obligation without plugin handshake. */
export async function checkLastSessionHandshake(scope: InstallScope): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  // Session pointer lives in the global config dir only — not relevant for repo-scope doctor.
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
      return checks;
    }

    const stateRaw = readFileSync(join(sessDir, 'session-state.json'), 'utf-8');
    const state = JSON.parse(stateRaw) as Record<string, unknown>;
    const assurance = state.reviewAssurance as
      | { obligations?: Array<{ status?: string; pluginHandshakeAt?: unknown }> }
      | undefined;

    const pendingObligation = assurance?.obligations?.find((o) => o.status === 'pending');
    if (!pendingObligation) return checks;

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
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      // Session pointer file doesn't exist — normal, no report
    } else {
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

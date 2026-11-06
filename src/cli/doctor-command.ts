/**
 * @module cli/doctor-command
 * @description FlowGuard doctor command implementation.
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { globalConfigPath, PersistenceError } from '../adapters/persistence.js';
import { readConfig } from '../adapters/persistence-config.js';
import { DEFAULT_CONFIG, FlowGuardConfigSchema } from '../config/flowguard-config.js';
import type { HostId } from '../shared/hosts.js';
import {
  COMMANDS,
  MANDATES_FILENAME,
  PLUGIN_WRAPPER,
  REVIEWER_AGENT_FILENAME,
  PLUGIN_RELATIVE_PATH,
  extractManagedBody,
  extractManagedDigest,
  extractManagedVersion,
  isManagedArtifact,
} from './templates.js';
import {
  computeMandatesDigest,
  resolveOpencodeConfigPath,
  resolveTarget,
  safeRead,
  sha256,
} from './install-helpers.js';
import {
  PACKAGE_VERSION,
  type CliArgs,
  type DoctorCheck,
  type InstallScope,
} from './install-types.js';
import { vendorDependency } from './install-json.js';
import { assertNativeOpenCodeInstallTarget } from './install-ownership.js';
import { resolveClaudeCodePluginRoot } from './claude-code-plugin-install.js';
import { resolveCodexPluginRoot } from './codex-plugin-install.js';
import { buildPlatformTrustReport } from './platform-trust-report.js';
import { checkShippedExecutables } from './doctor-executables.js';
import { checkBuildInfo } from './doctor-build-info.js';
import { checkPluginActivation } from './doctor-plugin.js';
import { checkLastSessionHandshake } from './doctor-handshake.js';

async function checkedRead(filePath: string, checks: DoctorCheck[]): Promise<string | null> {
  try {
    const content = await safeRead(filePath);
    if (content === null) checks.push({ file: filePath, status: 'missing' });
    return content;
  } catch (err: unknown) {
    const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({
      file: filePath,
      status: 'error',
      detail: code ? `Cannot read (${code}): ${msg}` : `Cannot read: ${msg}`,
    });
    return null;
  }
}

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
  await checkWrapperFile(target, PLUGIN_RELATIVE_PATH, PLUGIN_WRAPPER, checks);
  await checkCommandFiles(target, checks);
  await checkReviewerAgent(target, checks);
  return checks;
}

async function checkDependencies(target: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const pkgPath = join(target, 'package.json');
  const pkgContent = await checkedRead(pkgPath, checks);
  if (!pkgContent) return checks;
  try {
    const parsed = JSON.parse(pkgContent) as Record<string, unknown>;
    const deps = (parsed['dependencies'] ?? {}) as Record<string, string>;
    const coreDep = deps['@flowguard/core'];
    const expectedDep = vendorDependency(PACKAGE_VERSION());

    if (!coreDep) {
      checks.push({ file: pkgPath, status: 'error', detail: 'missing @flowguard/core dependency' });
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

async function checkNativeOpenCodeInstallation(
  scope: InstallScope,
  target: string,
): Promise<DoctorCheck[]> {
  const opencodeJsonPath = resolveOpencodeConfigPath(scope, target);
  try {
    await assertNativeOpenCodeInstallTarget(target, [
      target,
      ...(scope === 'repo' ? [resolve('.')] : []),
    ]);
  } catch (error) {
    return [
      {
        file: opencodeJsonPath,
        status: 'error',
        detail: error instanceof Error ? error.message : String(error),
        check: 'opencode-native-v2-installation',
      },
    ];
  }
  return [
    {
      file: opencodeJsonPath,
      status: 'warn',
      detail:
        'Native V2 discovery is configured without global mandates or permission rewrites. ' +
        'Runtime load, INACTIVE parity, operator UI provenance and reviewer assurance are NOT_VERIFIED; installation does not activate governance.',
      check: 'opencode-native-v2-installation',
    },
  ];
}

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
        const config = await readConfig();
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

function detectCustomConfig(config: {
  logging: { level: string };
  policy: Record<string, unknown>;
  profile: Record<string, unknown>;
  reviewer: { executionTimeoutMs: number };
}): boolean {
  return (
    config.logging.level !== 'info' ||
    config.policy.reviewBudget !== undefined ||
    config.profile.defaultId !== undefined ||
    config.profile.activeChecks !== undefined ||
    config.reviewer.executionTimeoutMs !== DEFAULT_CONFIG.reviewer.executionTimeoutMs
  );
}

function pushConfigError(checks: DoctorCheck[], cfgPath: string, err: unknown): void {
  if (err instanceof PersistenceError) {
    if (err.code === 'PARSE_FAILED' || err.code === 'SCHEMA_VALIDATION_FAILED') {
      checks.push({ file: cfgPath, status: 'error', detail: err.message });
    } else {
      checks.push({ file: cfgPath, status: 'error', detail: `cannot read config: ${err.message}` });
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
    checks.push(...(await checkNativeOpenCodeInstallation(args.installScope, target)));
  }
  checks.push(...(await checkWorkspaceConfig(args.installScope, installPlatform, target)));
  if (installPlatform === 'opencode') {
    checks.push(...(await checkPluginActivation(target)));
    checks.push(...(await checkLastSessionHandshake(args.installScope)));
  }
  checks.push(...(await checkBrokenInstall(target)));
  checks.push(...checkShippedExecutables());
  checks.push(...checkBuildInfo());
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
      ...(existsSync(filePath) ? { detail: 'configured; runtime load NOT_VERIFIED_RUNTIME' } : {}),
    });
  }

  return checks;
}

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

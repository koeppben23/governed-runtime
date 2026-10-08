/**
 * @module persistence-config
 * @description FlowGuard configuration file operations.
 *
 * Config resolution priority: repo-scoped → global → DEFAULT_CONFIG.
 * Config is stored as a flat file — no longer under workspace fingerprint folders.
 *
 * @version v1
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getAdapterLogger } from '../logging/adapter-logger.js';
import {
  FlowGuardConfigSchema,
  DEFAULT_CONFIG,
  type FlowGuardConfig,
} from '../config/flowguard-config.js';
import {
  globalConfigPath,
  repoConfigPath,
  ensureDir,
  atomicWrite,
  PersistenceError,
  isEnoent,
} from './persistence.js';

const CONFIG_FILE = 'flowguard.json';

type ConfigScope = 'Repo' | 'Global';

async function readConfigFile(filePath: string, scope: ConfigScope): Promise<FlowGuardConfig> {
  const raw = await fs.readFile(filePath, 'utf-8');
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new PersistenceError(
      'PARSE_FAILED',
      `${scope} config file is not valid JSON: ${filePath}`,
    );
  }
  const result = FlowGuardConfigSchema.safeParse(json);
  if (!result.success) {
    throw new PersistenceError(
      'SCHEMA_VALIDATION_FAILED',
      `${scope} config failed schema validation: ${result.error.message}`,
    );
  }
  return result.data;
}

function readFailure(scope: ConfigScope, err: unknown): PersistenceError {
  return new PersistenceError(
    'READ_FAILED',
    `Failed to read ${scope.toLowerCase()} config: ${err instanceof Error ? err.message : String(err)}`,
  );
}

async function readRepoConfig(worktree: string): Promise<FlowGuardConfig | null> {
  const repoPath = repoConfigPath(worktree);
  try {
    return await readConfigFile(repoPath, 'Repo');
  } catch (err) {
    if (err instanceof PersistenceError) throw err;
    if (!isEnoent(err)) throw readFailure('Repo', err);
  }
  getAdapterLogger().warn(
    'persistence-config',
    'Repo config not found, falling through to global',
    { repoPath },
  );
  return null;
}

async function readGlobalConfig(): Promise<FlowGuardConfig> {
  const globalPath = globalConfigPath();
  try {
    return await readConfigFile(globalPath, 'Global');
  } catch (err) {
    if (err instanceof PersistenceError) throw err;
    if (!isEnoent(err)) throw readFailure('Global', err);
  }
  getAdapterLogger().warn(
    'persistence-config',
    'Optional global config not found; using global defaults',
    { globalConfigPath: globalPath },
  );
  return structuredClone(DEFAULT_CONFIG);
}

/**
 * Read the optional global config without substituting defaults. Returns null
 * only on ENOENT; a malformed global config keeps failing closed.
 */
async function readGlobalConfigOrNull(): Promise<FlowGuardConfig | null> {
  const globalPath = globalConfigPath();
  try {
    return await readConfigFile(globalPath, 'Global');
  } catch (err) {
    if (err instanceof PersistenceError) throw err;
    if (!isEnoent(err)) throw readFailure('Global', err);
  }
  return null;
}

/** Effective archive redaction policy after the admin ceiling is applied. */
export type EffectiveArchiveRedactionPolicy = Pick<
  FlowGuardConfig['archive']['redaction'],
  'allowRawExport' | 'allowedModes' | 'maxAuditEvents'
>;

/**
 * Outcome of projecting the effective archive redaction policy. A conflict
 * (empty `allowedModes` intersection) is a fail-closed outcome, never a silent
 * fallback or an empty mode set.
 */
export type EffectiveArchivePolicy =
  | {
      readonly kind: 'resolved';
      readonly policy: EffectiveArchiveRedactionPolicy;
      readonly globalPresent: boolean;
    }
  | { readonly kind: 'blocked'; readonly code: 'ARCHIVE_POLICY_CONFLICT'; readonly reason: string };

/**
 * Project the effective archive redaction policy for the configurable
 * `archiveSession` export (`/archive` and the solo auto-archive).
 *
 * The explicit global installation config is an administrator ceiling:
 *
 * - `allowRawExport` requires an explicit global `true` AND a repo config that
 *   does not forbid it. An absent global config binds the secure default
 *   (`false`), so a repository config can never elevate raw export on its own.
 * - `allowedModes` is the intersection; the repo may only narrow the modes the
 *   administrator allows. An empty intersection is fail-closed.
 * - `maxAuditEvents` is the minimum; the repo may only lower the processing cap.
 *
 * System-authorized raw exports (`/export` and regulated completion) bypass this
 * projection by design and are not affected.
 */
export async function readEffectiveArchivePolicy(
  worktree?: string,
): Promise<EffectiveArchivePolicy> {
  // The global config is always read, even when a repo config exists, so a
  // malformed admin config fails closed instead of being silently ignored.
  const global = await readGlobalConfigOrNull();
  const repo = worktree ? await readRepoConfig(worktree) : null;
  return projectEffectiveArchivePolicy(global, repo);
}

/** Pure projection of the admin-ceiling rules over the two config sources. */
function projectEffectiveArchivePolicy(
  global: FlowGuardConfig | null,
  repo: FlowGuardConfig | null,
): EffectiveArchivePolicy {
  const defaults = DEFAULT_CONFIG.archive.redaction;
  const allowRawExport = projectAllowRawExport(global, repo, defaults);
  const allowedModes = projectAllowedModes(global, repo, defaults);
  if (allowedModes.length === 0) {
    return {
      kind: 'blocked',
      code: 'ARCHIVE_POLICY_CONFLICT',
      reason:
        `global allowedModes [${allowedModesOf(global, defaults).join(', ')}] and repository allowedModes ` +
        `[${allowedModesOf(repo, defaults).join(', ')}] have an empty intersection`,
    };
  }

  return {
    kind: 'resolved',
    policy: {
      allowRawExport,
      allowedModes,
      maxAuditEvents: Math.min(
        maxAuditEventsOf(global, defaults),
        maxAuditEventsOf(repo, defaults),
      ),
    },
    globalPresent: global !== null,
  };
}

type ArchiveRedactionConfig = FlowGuardConfig['archive']['redaction'];

function redactionOf(config: FlowGuardConfig | null): ArchiveRedactionConfig | undefined {
  return config === null ? undefined : config.archive.redaction;
}

/** Raw export requires an explicit global true and no repo prohibition. */
function projectAllowRawExport(
  global: FlowGuardConfig | null,
  repo: FlowGuardConfig | null,
  defaults: ArchiveRedactionConfig,
): boolean {
  const globalRedaction = redactionOf(global);
  const repoRedaction = redactionOf(repo);
  const globalAllows =
    globalRedaction === undefined ? defaults.allowRawExport : globalRedaction.allowRawExport;
  const repoAllows = repoRedaction === undefined ? true : repoRedaction.allowRawExport;
  return globalAllows && repoAllows;
}

function allowedModesOf(
  config: FlowGuardConfig | null,
  defaults: ArchiveRedactionConfig,
): ArchiveRedactionConfig['allowedModes'] {
  const redaction = redactionOf(config);
  return redaction === undefined ? defaults.allowedModes : redaction.allowedModes;
}

function projectAllowedModes(
  global: FlowGuardConfig | null,
  repo: FlowGuardConfig | null,
  defaults: ArchiveRedactionConfig,
): ArchiveRedactionConfig['allowedModes'] {
  const globalModes = allowedModesOf(global, defaults);
  const repoModes = allowedModesOf(repo, defaults);
  return globalModes.filter((mode) => repoModes.includes(mode));
}

function maxAuditEventsOf(
  config: FlowGuardConfig | null,
  defaults: ArchiveRedactionConfig,
): number {
  const redaction = redactionOf(config);
  return redaction === undefined ? defaults.maxAuditEvents : redaction.maxAuditEvents;
}

/**
 * Read the FlowGuard config. Resolves deterministically:
 *   1. {worktree}/.opencode/flowguard.json (repo override, if worktree provided)
 *   2. ~/.config/opencode/flowguard.json (global default)
 *   3. DEFAULT_CONFIG (built-in fallback)
 *
 * Config is stored as a flat file — no longer under workspace fingerprint folders.
 *
 * @param worktree - Optional git worktree root for repo-scoped config.
 * @returns Fully normalized FlowGuardConfig (never null).
 */
export async function readConfig(worktree?: string): Promise<FlowGuardConfig> {
  if (worktree) {
    const repoConfig = await readRepoConfig(worktree);
    if (repoConfig) return repoConfig;
  }
  return readGlobalConfig();
}

/**
 * Write a FlowGuard config to a target directory.
 *
 * Schema-validated before write (fail-closed — never persist invalid config).
 * Internal only — callers must use writeRepoConfig or writeGlobalConfig.
 *
 * @param targetDir - The directory containing flowguard.json.
 * @param config - The FlowGuardConfig to persist.
 * @throws PersistenceError if validation or write fails.
 */
async function writeConfig(targetDir: string, config: FlowGuardConfig): Promise<void> {
  const parsed = FlowGuardConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new PersistenceError(
      'SCHEMA_VALIDATION_FAILED',
      `Config failed schema validation: ${parsed.error.message}`,
    );
  }
  await ensureDir(targetDir);
  const json = JSON.stringify(parsed.data, null, 2) + '\n';
  await atomicWrite(path.join(targetDir, CONFIG_FILE), json);
}

/**
 * Write a repo-scoped config to {worktree}/.opencode/flowguard.json.
 */
export async function writeRepoConfig(worktree: string, config: FlowGuardConfig): Promise<void> {
  return writeConfig(path.join(worktree, '.opencode'), config);
}

/**
 * Write the global config to ~/.config/opencode/flowguard.json.
 */
export async function writeGlobalConfig(config: FlowGuardConfig): Promise<void> {
  return writeConfig(path.dirname(globalConfigPath()), config);
}

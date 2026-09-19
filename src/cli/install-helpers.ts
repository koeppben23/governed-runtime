/**
 * @module cli/install-helpers
 * @description Path resolution, reviewer agent transport, and file helpers for the FlowGuard CLI installer.
 *
 * Types and JSON merge logic extracted to install-types.ts and install-json.ts
 * following FG-REL-042. Tarball integrity and rollback helpers live in
 * install-helpers-integrity.ts and install-helpers-rollback.ts.
 *
 * @version v2
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile, unlink, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ensureDir } from '../adapters/persistence.js';
import { join, resolve, dirname, basename, relative as relativePath } from 'node:path';
import { homedir } from 'node:os';
import { hashText } from '../shared/hashing.js';
import {
  CLAUDE_REVIEWER_AGENT,
  CODEX_REVIEWER_SUBAGENT,
  REVIEWER_AGENT_FILENAME,
  REVIEWER_AGENT,
  FLOWGUARD_MANDATES_KERNEL,
  MANDATES_FILENAME,
} from './templates.js';

// ─── Typed Errors ────────────────────────────────────────────────────────────

export type { InstallErrorCode } from './install-types.js';
import { InstallError } from './install-recovery.js';
export { InstallError };

import {
  FLOWGUARD_REVIEWER_MODEL_ENV,
  VALID_MODEL_ID_PATTERN,
  FLOWGUARD_REVIEWER_EFFORT_ENV,
  REVIEWER_EFFORT_VALUES,
  VALID_EFFORT_PATTERN,
  OPENCODE_CONFIG_FILENAMES,
} from './install-types.js';
export { hashText as sha256 };

import type {
  InstallScope,
  InstallPlatform,
  FileOp,
  ArtifactDetection,
  ReviewerEffort,
} from './install-types.js';

// ---- Path Resolution ----

export function resolveTarget(scope: InstallScope, platform: InstallPlatform = 'opencode'): string {
  if (scope === 'global') {
    if (platform === 'claude-code')
      return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    if (platform === 'codex') return join(homedir(), '.codex', 'plugins', 'flowguard');
    return process.env.OPENCODE_CONFIG_DIR || join(homedir(), '.config', 'opencode');
  }
  if (platform === 'claude-code') return resolve('.claude');
  if (platform === 'codex') return resolve('plugins', 'flowguard');
  return resolve('.opencode');
}

export function formatTargetPath(target: string, scope: InstallScope, cwd: string): string {
  if (scope === 'global') return target.replace(homedir(), '~');
  const rel = relativePath(cwd, target);
  if (!rel) return './';
  return `./${rel.replace(/\\/g, '/')}`;
}

export function reviewerDefinitionForPlatform(platform: InstallPlatform): {
  readonly relativePath: string;
  readonly content: string;
} {
  if (platform === 'claude-code') {
    return {
      relativePath: `agents/${REVIEWER_AGENT_FILENAME}`,
      content: buildReviewerAgentContent(CLAUDE_REVIEWER_AGENT, 'claude-code'),
    };
  }
  if (platform === 'codex') {
    assertReviewerTuningSupported('codex');
    return {
      relativePath: `subagents/${REVIEWER_AGENT_FILENAME}`,
      content: CODEX_REVIEWER_SUBAGENT,
    };
  }
  return {
    relativePath: `agents/${REVIEWER_AGENT_FILENAME}`,
    content: buildReviewerAgentContent(REVIEWER_AGENT, 'opencode'),
  };
}

export function computeMandatesDigest(): string {
  return hashText(FLOWGUARD_MANDATES_KERNEL);
}

// ---- Reviewer Agent Capability Transport (model + reasoning effort) ----
//
// Operative-layer adaptation ONLY. Governance ceremony/mandates stay
// model-invariant; these knobs adjust the reviewer transport (which model and
// how much reasoning effort) without ever hardcoding a model name and without
// touching governance verbosity. Both knobs are operator-controlled env vars.
//
// Host support (verified against official host docs):
//   - opencode:    `model:` + passthrough `reasoningEffort:` frontmatter.
//   - claude-code: `model:` + `effort:` frontmatter.
//   - codex:       custom-agent tuning is configured via native TOML under
//                  `.codex/agents/` (model + model_reasoning_effort), NOT via the
//                  markdown plugin subagent FlowGuard ships. Injecting these
//                  directives into the markdown frontmatter is unsupported, so we
//                  fail closed instead of silently emitting a no-op directive.

/** Per-host frontmatter key for the reasoning-effort knob; null = unsupported. */
function reviewerEffortFieldForPlatform(platform: InstallPlatform): string | null {
  if (platform === 'claude-code') return 'effort';
  if (platform === 'codex') return null;
  return 'reasoningEffort'; // opencode (provider passthrough)
}

/** Whether reviewer `model:` frontmatter injection is supported for the host. */
function reviewerModelSupportedForPlatform(platform: InstallPlatform): boolean {
  return platform !== 'codex';
}

function readReviewerModelEnv(): string | null {
  const raw = process.env[FLOWGUARD_REVIEWER_MODEL_ENV];
  if (!raw) return null;
  const model = raw.trim();
  if (!model) return null;

  if (/[\r\n]/.test(model)) {
    throw new InstallError(
      'REVIEWER_CONFIG_REJECTED',
      `${FLOWGUARD_REVIEWER_MODEL_ENV} contains newline characters — ` +
        'rejected to prevent YAML injection.',
    );
  }
  if (!VALID_MODEL_ID_PATTERN.test(model)) {
    throw new InstallError(
      'REVIEWER_CONFIG_INVALID',
      `${FLOWGUARD_REVIEWER_MODEL_ENV} contains invalid characters: "${model}" — ` +
        'only alphanumeric, dots, slashes, @, colons, and hyphens are allowed.',
    );
  }
  return model;
}

function readReviewerEffortEnv(platform: InstallPlatform): ReviewerEffort | null {
  const raw = process.env[FLOWGUARD_REVIEWER_EFFORT_ENV];
  if (!raw) return null;
  const effort = raw.trim();
  if (!effort) return null;

  const supported: readonly ReviewerEffort[] =
    platform === 'opencode'
      ? REVIEWER_EFFORT_VALUES
      : REVIEWER_EFFORT_VALUES.filter((value) => value !== 'none');
  if (!VALID_EFFORT_PATTERN.test(effort) || !supported.includes(effort as ReviewerEffort)) {
    throw new InstallError(
      'REVIEWER_CONFIG_INVALID',
      `${FLOWGUARD_REVIEWER_EFFORT_ENV} contains invalid value: "${effort}" — ` +
        `allowed values for ${platform} are: ${supported.join(', ')}.`,
    );
  }
  return effort as ReviewerEffort;
}

/**
 * Fail closed when reviewer tuning is requested for a host that cannot honor it.
 *
 * Silently dropping an operator's explicit override would hide that their intent
 * is not applied (AGENTS.md red line: no silent fallback). For Codex we surface
 * the limitation and point at the native mechanism.
 */
function assertReviewerTuningSupported(platform: InstallPlatform): void {
  if (reviewerModelSupportedForPlatform(platform) && reviewerEffortFieldForPlatform(platform)) {
    return;
  }
  const requested: string[] = [];
  if (process.env[FLOWGUARD_REVIEWER_MODEL_ENV]?.trim())
    requested.push(FLOWGUARD_REVIEWER_MODEL_ENV);
  if (process.env[FLOWGUARD_REVIEWER_EFFORT_ENV]?.trim())
    requested.push(FLOWGUARD_REVIEWER_EFFORT_ENV);
  if (requested.length === 0) return;

  throw new InstallError(
    'REVIEWER_TUNING_UNSUPPORTED',
    `${requested.join(' and ')} ${requested.length > 1 ? 'are' : 'is'} set but reviewer ` +
      `model/effort tuning is not supported for platform "${platform}". ` +
      'Codex configures custom-agent model and model_reasoning_effort via native TOML under ' +
      '.codex/agents/, not via the FlowGuard markdown subagent. ' +
      `Unset ${requested.join('/')} for this install, or configure the Codex custom agent directly.`,
  );
}

/**
 * Inject operator-configured reviewer transport tuning into agent frontmatter.
 *
 * Returns the template unchanged when no override is set or the template has
 * no frontmatter line.
 */
export function buildReviewerAgentContent(template: string, platform: InstallPlatform): string {
  const lines: string[] = [];

  const model = readReviewerModelEnv();
  if (model && reviewerModelSupportedForPlatform(platform)) {
    lines.push(`model: ${model}`);
  }

  // OpenCode models that default to Thinking mode reject the host's required
  // structured-output tool. The reviewer is always non-thinking by default.
  const effort = readReviewerEffortEnv(platform) ?? (platform === 'opencode' ? 'none' : null);
  const effortField = reviewerEffortFieldForPlatform(platform);
  if (effort && effortField) {
    lines.push(`${effortField}: ${effort}`);
  }

  if (lines.length === 0) return template;

  const firstNewline = template.indexOf('\n');
  if (firstNewline < 0) return template;

  const injected = lines.map((line) => `${line}\n`).join('');
  return template.slice(0, firstNewline + 1) + injected + template.slice(firstNewline + 1);
}

// ---- OpenCode Config Path ----

export function resolveOpencodeConfigPath(
  scope: InstallScope,
  target = resolveTarget(scope),
  projectRoot = resolve('.'),
): string {
  const dir = scope === 'global' ? target : projectRoot;
  for (const filename of OPENCODE_CONFIG_FILENAMES) {
    const candidate = join(dir, filename);
    if (existsSync(candidate)) return candidate;
  }
  return join(dir, 'opencode.json');
}

export function findParallelOpencodeConfig(preferredPath: string): string | null {
  const dir = dirname(preferredPath);
  const preferredName = basename(preferredPath);
  for (const name of OPENCODE_CONFIG_FILENAMES) {
    if (name !== preferredName) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

// ---- File Helpers ----

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
}

export async function safeRead(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

export async function safeUnlink(filePath: string): Promise<boolean> {
  try {
    await unlink(filePath);
    return true;
  } catch (err: unknown) {
    if (isEnoent(err)) return false;
    throw err;
  }
}

export async function writeIfAbsent(
  filePath: string,
  content: string,
  force: boolean,
): Promise<FileOp> {
  if (!force) {
    try {
      const dir = dirname(filePath);
      if (dir) await ensureDir(dir);
      await writeFile(filePath, content, { encoding: 'utf-8', flag: 'wx' });
      return { path: filePath, action: 'written' };
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'EEXIST') {
        return { path: filePath, action: 'skipped', reason: 'already exists' };
      }
      throw err;
    }
  }

  const tmpPath = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
  const dir = dirname(filePath);
  if (dir) await ensureDir(dir);
  try {
    await writeFile(tmpPath, content, { encoding: 'utf-8', flag: 'wx' });
    await rename(tmpPath, filePath);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {
      /* ok */
    }
    throw err;
  }
  return { path: filePath, action: 'written' };
}

// ─── Structured Error Helpers (in install-recovery.ts) ────────────────────────

export { formatRecoveryLines, pushError, toCliError } from './install-recovery.js';

// ─── Artifact Detection ──────────────────────────────────────────────────────

function checkArtifactExistence(
  target: string,
  relativePath: string,
): { file: string; ok: boolean } {
  const fullPath = join(target, relativePath);
  return { file: relativePath, ok: existsSync(fullPath) };
}

export function detectInstalledArtifacts(
  target: string,
  platform: InstallPlatform,
): ArtifactDetection {
  const results: { file: string; ok: boolean }[] = [];

  if (platform === 'opencode') {
    results.push(checkArtifactExistence(target, MANDATES_FILENAME));
    results.push(checkArtifactExistence(target, 'tools/flowguard.ts'));
    results.push(checkArtifactExistence(target, 'plugins/flowguard-audit.ts'));
    results.push(checkArtifactExistence(target, 'flowguard.json'));
  } else if (platform === 'claude-code') {
    results.push(
      checkArtifactExistence(target, join('flowguard-plugin', '.claude-plugin', 'plugin.json')),
    );
    results.push(checkArtifactExistence(target, '.mcp.json'));
    results.push(checkArtifactExistence(target, join('hooks', 'hooks.json')));
    results.push(
      checkArtifactExistence(target, join('flowguard-plugin', 'agents', 'flowguard-reviewer.md')),
    );
  } else {
    results.push(checkArtifactExistence(target, join('.codex-plugin', 'plugin.json')));
    results.push(checkArtifactExistence(target, '.mcp.json'));
    results.push(checkArtifactExistence(target, join('hooks', 'hooks.json')));
    results.push(checkArtifactExistence(target, join('subagents', 'flowguard-reviewer.md')));
  }

  const found = results.some((r) => r.ok);
  const artifacts = results.filter((r) => r.ok).map((r) => r.file);

  return { found, artifacts };
}

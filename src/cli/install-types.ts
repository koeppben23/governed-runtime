/**
 * @module cli/install-types
 * @description Types, constants, and version helpers for the FlowGuard CLI installer.
 *
 * @version v1
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAdapterLogger } from '../logging/adapter-logger.js';
import {
  COMMANDS,
  MANDATES_FILENAME,
  REVIEWER_AGENT_FILENAME,
  LEGACY_INSTRUCTION_ENTRY,
} from './templates.js';

// ---- re-export canonical PolicyMode ----
export type { PolicyMode } from '../config/policy-types.js';
import type { PolicyMode } from '../config/policy-types.js';
import type { HostId } from '../shared/hosts.js';

// ---- Types ----

export type InstallScope = 'global' | 'repo';
export type InstallPlatform = HostId;

export type CliAction = 'install' | 'uninstall' | 'doctor' | 'run' | 'serve' | 'inspect';

export interface CliArgs {
  action: CliAction;
  installScope: InstallScope;
  installPlatform?: InstallPlatform;
  policyMode: PolicyMode;
  force: boolean;
  coreTarball?: string;
  checksumsFile?: string;
  logMode?: 'file' | 'console' | 'file+console';
}

export interface FileOp {
  path: string;
  action: 'written' | 'skipped' | 'merged' | 'removed' | 'not_found';
  reason?: string;
}

export interface CliResult {
  target: string;
  ops: FileOp[];
  errors: string[];
  warnings: string[];
}

export type DoctorStatus =
  | 'ok'
  | 'missing'
  | 'modified'
  | 'unmanaged'
  | 'version_mismatch'
  | 'instruction_missing'
  | 'instruction_stale'
  | 'error'
  | 'warn';

export interface DoctorCheck {
  file: string;
  status: DoctorStatus;
  detail?: string;
}

// ---- Version ----

function getPackageVersion(): string {
  const versionFile = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'VERSION');
  try {
    return readFileSync(versionFile, 'utf-8').trim();
  } catch {
    getAdapterLogger().error('cli', 'VERSION file not found', { versionFile });
    throw new Error(`VERSION file not found at ${versionFile}. Run from the project root.`);
  }
}

let _cachedVersion: string | undefined;
export function PACKAGE_VERSION(): string {
  if (!_cachedVersion) {
    _cachedVersion = getPackageVersion();
  }
  return _cachedVersion;
}

// ---- Constants ----

/** Files owned by FlowGuard that uninstall may remove. */
export const FLOWGUARD_OWNED_FILES = [
  MANDATES_FILENAME,
  'tools/flowguard.ts',
  'plugins/flowguard-audit.ts',
  `agents/${REVIEWER_AGENT_FILENAME}`,
  `subagents/${REVIEWER_AGENT_FILENAME}`,
  ...Object.keys(COMMANDS).map((name) => `commands/${name}`),
  'vendor',
] as const;

/** Canonical regex for FlowGuard tarball filenames. */
export const FLOWGUARD_TARBALL_PATTERN =
  /^flowguard-core-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.tgz$/;

export const FLOWGUARD_INSTRUCTION_ENTRIES: readonly string[] = [
  MANDATES_FILENAME,
  `.opencode/${MANDATES_FILENAME}`,
  LEGACY_INSTRUCTION_ENTRY,
];

export function hasNonFlowGuardInstructions(instructions: string[]): boolean {
  return instructions.some((i) => !FLOWGUARD_INSTRUCTION_ENTRIES.includes(i));
}

export const FLOWGUARD_REVIEWER_MODEL_ENV = 'FLOWGUARD_REVIEWER_MODEL';
export const VALID_MODEL_ID_PATTERN = /^[A-Za-z0-9._/@:-]+$/;

/**
 * Operator-controlled reviewer reasoning-effort override.
 *
 * Capability-based, NOT model-name-based: the operator sets a strength level
 * appropriate to the reviewer model they configured. FlowGuard never derives
 * this from a model registry — governance ceremony stays model-invariant; only
 * the operative reviewer transport adapts.
 */
export const FLOWGUARD_REVIEWER_EFFORT_ENV = 'FLOWGUARD_REVIEWER_EFFORT';

/**
 * Strict allow-pattern for reviewer effort values. Lowercase alphabetic only
 * (e.g. low, medium, high, xhigh, max). Deliberately model-agnostic — it accepts
 * future levels without a hardcoded enum — while blocking whitespace, colons,
 * and newlines to prevent YAML injection into reviewer-agent frontmatter.
 */
export const VALID_EFFORT_PATTERN = /^[a-z]+$/;

export const OPENCODE_CONFIG_FILENAMES = ['opencode.jsonc', 'opencode.json'] as const;

/**
 * @module cli/install-types
 * @description Types, constants, and version helpers for the FlowGuard CLI installer.
 *
 * @version v1
 */

import { COMMANDS, MANDATES_FILENAME, REVIEWER_AGENT_FILENAME } from './templates.js';

export type { PolicyMode } from '../config/policy-types.js';
import type { PolicyMode } from '../config/policy-types.js';
import type { HostId } from '../shared/hosts.js';
export { PACKAGE_VERSION, resolvePackageRoot } from '../shared/package-version.js';

export type InstallScope = 'global' | 'repo';
export type InstallPlatform = HostId;
export type CliAction = 'install' | 'uninstall' | 'doctor' | 'run' | 'serve' | 'inspect';
export type ScopeSource = 'default' | 'cli';

export interface CliArgs {
  action: CliAction;
  installScope: InstallScope;
  scopeSource?: ScopeSource;
  installPlatform?: InstallPlatform;
  policyMode: PolicyMode;
  force: boolean;
  coreTarball?: string;
  checksumsFile?: string;
  allowUnverifiedTarball?: boolean;
  logMode?: 'file' | 'console' | 'file+console';
}

export interface FileOp {
  path: string;
  action: 'written' | 'skipped' | 'merged' | 'removed' | 'not_found';
  reason?: string;
}

export interface CliError {
  code?: InstallErrorCode;
  message: string;
  recoveryContext?: { path?: string; target?: string };
}

export interface CliNotice {
  kind: 'next' | 'status';
  message: string;
}

export interface CliResult {
  target: string;
  ops: FileOp[];
  errors: string[];
  errorDetails?: CliError[];
  warnings: string[];
  notices?: CliNotice[];
}

export interface ArtifactDetection {
  found: boolean;
  artifacts: string[];
}

export type DoctorStatus =
  | 'ok'
  | 'missing'
  | 'modified'
  | 'unmanaged'
  | 'version_mismatch'
  | 'instruction_missing'
  | 'error'
  | 'warn'
  | 'info';

export interface DoctorCheck {
  file: string;
  status: DoctorStatus;
  detail?: string;
  check?: string;
}

export const SHIPPED_EXECUTABLE_CHECK = 'shipped-executable';
export const BUILD_INFO_CHECK = 'build-info';

export const FLOWGUARD_OWNED_FILES = [
  MANDATES_FILENAME,
  'tools/flowguard.ts',
  'plugins/flowguard-audit.ts',
  `agents/${REVIEWER_AGENT_FILENAME}`,
  `subagents/${REVIEWER_AGENT_FILENAME}`,
  ...Object.keys(COMMANDS).map((name) => `commands/${name}`),
  'vendor',
] as const;

export const FLOWGUARD_TARBALL_PATTERN =
  /^flowguard-core-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.tgz$/;

export const FLOWGUARD_INSTRUCTION_ENTRIES: readonly string[] = [
  MANDATES_FILENAME,
  `.opencode/${MANDATES_FILENAME}`,
];

export function hasNonFlowGuardInstructions(instructions: string[]): boolean {
  return instructions.some((i) => !FLOWGUARD_INSTRUCTION_ENTRIES.includes(i));
}

export const FLOWGUARD_REVIEWER_MODEL_ENV = 'FLOWGUARD_REVIEWER_MODEL';
export const VALID_MODEL_ID_PATTERN = /^[A-Za-z0-9._/@:-]+$/;
export const FLOWGUARD_REVIEWER_EFFORT_ENV = 'FLOWGUARD_REVIEWER_EFFORT';
export const VALID_EFFORT_PATTERN = /^[a-z]+$/;
export const OPENCODE_CONFIG_FILENAMES = ['opencode.jsonc', 'opencode.json'] as const;

export type InstallErrorCode =
  | 'TARBALL_CHECKSUMS_UNREADABLE'
  | 'TARBALL_DUPLICATE_ENTRY'
  | 'TARBALL_NOT_FOUND'
  | 'TARBALL_SHA256_MISMATCH'
  | 'TARBALL_NAME_INVALID'
  | 'TARBALL_VERSION_MISMATCH'
  | 'TARBALL_INTEGRITY_FAILED'
  | 'MISSING_CORE_TARBALL'
  | 'CONFIG_INCOMPATIBLE_FLAGS'
  | 'ALREADY_INSTALLED'
  | 'MANAGED_ARTIFACT_CONFLICT'
  | 'LEGACY_INSTRUCTION_AMBIGUOUS'
  | 'INSTALL_OWNERSHIP_UNAVAILABLE'
  | 'DEPENDENCY_INSTALL_FAILED'
  | 'INSTALL_LOCK_CONFLICT'
  | 'REVIEWER_CONFIG_REJECTED'
  | 'REVIEWER_CONFIG_INVALID'
  | 'REVIEWER_TUNING_UNSUPPORTED';

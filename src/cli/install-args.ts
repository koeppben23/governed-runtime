/**
 * @module cli/install-args
 * @description CLI argument parsing for the FlowGuard installer entrypoint.
 *
 * Split from install.ts following the file-size budget; parser behavior and
 * defaults are unchanged.
 *
 * @version v1
 */

import { HOST_IDS } from '../shared/hosts.js';
import { POLICY_MODES } from '../state/policy-mode.js';
import type { CliParseResult } from './parse-result.js';
import type {
  InstallScope,
  InstallPlatform,
  PolicyMode,
  CliAction,
  CliArgs,
  ScopeSource,
} from './install-types.js';

// ─── Argument Parsing ─────────────────────────────────────────────────────────

const VALID_POLICY_MODES: readonly PolicyMode[] = POLICY_MODES;
const VALID_SCOPES: readonly InstallScope[] = ['global', 'repo'] as const;
const VALID_PLATFORMS: readonly InstallPlatform[] = HOST_IDS;
const VALID_ACTIONS: readonly CliAction[] = [
  'install',
  'uninstall',
  'doctor',
  'run',
  'serve',
  'inspect',
] as const;

interface ParseState {
  installScope: InstallScope;
  scopeSource: ScopeSource;
  installPlatform: InstallPlatform;
  policyMode: PolicyMode;
  force: boolean;
  coreTarball: string | undefined;
  checksumsFile: string | undefined;
  allowUnverifiedTarball: boolean;
  logMode: 'file' | 'console' | 'file+console' | undefined;
}

function initialParseState(): ParseState {
  return {
    installScope: 'global',
    scopeSource: 'default',
    installPlatform: 'opencode',
    // Fail-closed default: a fresh install is human-gated (team) unless the
    // operator passes --policy-mode solo|team-ci for auto-approve behavior.
    policyMode: 'team',
    force: false,
    coreTarball: undefined,
    checksumsFile: undefined,
    allowUnverifiedTarball: false,
    logMode: undefined,
  };
}

function readNextValue(argv: string[], i: number): string | null {
  const next = argv[i + 1];
  return next ? next : null;
}

function isValidScope(value: string): value is InstallScope {
  return VALID_SCOPES.includes(value as InstallScope);
}
function isValidPlatform(value: string): value is InstallPlatform {
  return VALID_PLATFORMS.includes(value as InstallPlatform);
}
function isValidPolicyMode(value: string): value is PolicyMode {
  return VALID_POLICY_MODES.includes(value as PolicyMode);
}
function isValidLogMode(value: string): value is 'file' | 'console' | 'file+console' {
  return value === 'file' || value === 'console' || value === 'file+console';
}

function validateAndSetScope(st: ParseState, value: string): string | true {
  if (!isValidScope(value)) return `Invalid install scope: ${value}`;
  st.installScope = value;
  st.scopeSource = 'cli';
  return true;
}

function validateAndSetPlatform(st: ParseState, value: string): string | true {
  if (!isValidPlatform(value)) return `Invalid platform: ${value}`;
  st.installPlatform = value;
  return true;
}

function validateAndSetPolicyMode(st: ParseState, value: string): string | true {
  if (!isValidPolicyMode(value)) return `Invalid policy mode: ${value}`;
  st.policyMode = value;
  return true;
}

function validateAndSetLogMode(st: ParseState, value: string): string | true {
  if (!isValidLogMode(value)) return `Invalid log mode: ${value}`;
  st.logMode = value;
  return true;
}

function validateAndSetTarball(st: ParseState, value: string): true {
  st.coreTarball = value;
  return true;
}

function validateAndSetChecksums(st: ParseState, value: string): true {
  st.checksumsFile = value;
  return true;
}

function handleValueFlag(st: ParseState, flag: string, value: string | null): string | true {
  if (value === null) return `${flag} requires a value`;

  switch (flag) {
    case '--install-scope':
      return validateAndSetScope(st, value);
    case '--platform':
    case '--host':
      return validateAndSetPlatform(st, value);
    case '--policy-mode':
      return validateAndSetPolicyMode(st, value);
    case '--core-tarball':
      return validateAndSetTarball(st, value);
    case '--checksums-file':
      return validateAndSetChecksums(st, value);
    case '--log-mode':
      return validateAndSetLogMode(st, value);
  }
  return `Unknown option: ${flag}`;
}

function parseOneArg(st: ParseState, arg: string, argv: string[], i: number): number | string {
  if (arg === '--help' || arg === '-h') return -2;

  const valueFlags = new Set([
    '--install-scope',
    '--platform',
    '--host',
    '--policy-mode',
    '--core-tarball',
    '--checksums-file',
    '--log-mode',
  ]);

  if (valueFlags.has(arg)) {
    const value = readNextValue(argv, i);
    const result = handleValueFlag(st, arg, value);
    if (result !== true) return result;
    return 2;
  }

  switch (arg) {
    case '--force':
      st.force = true;
      return 1;
    case '--allow-unverified-tarball':
      st.allowUnverifiedTarball = true;
      return 1;
    default:
      return -1;
  }
}

function buildArgs(action: CliAction, st: ParseState): CliArgs {
  return {
    action,
    installScope: st.installScope,
    scopeSource: st.scopeSource,
    installPlatform: st.installPlatform,
    policyMode: st.policyMode,
    force: st.force,
    ...(st.coreTarball !== undefined ? { coreTarball: st.coreTarball } : {}),
    ...(st.checksumsFile !== undefined ? { checksumsFile: st.checksumsFile } : {}),
    allowUnverifiedTarball: st.allowUnverifiedTarball,
    ...(st.logMode !== undefined ? { logMode: st.logMode } : {}),
  };
}

function makeDelegatedResult(action: string): CliParseResult<CliArgs> {
  return {
    kind: 'ok',
    value: {
      action: action as CliAction,
      installScope: 'global',
      scopeSource: 'default',
      installPlatform: 'opencode',
      policyMode: 'team',
      force: false,
    },
  };
}

function parseInstallArgs(action: CliAction, argv: string[]): CliParseResult<CliArgs> {
  const st = initialParseState();

  for (let i = 1; i < argv.length;) {
    const arg = argv[i];
    if (arg === undefined) return { kind: 'error', error: 'Unexpected empty argument' };
    const advance = parseOneArg(st, arg, argv, i);
    if (advance === -2) return { kind: 'help' };
    if (typeof advance === 'string')
      return { kind: 'error', error: advance, hint: 'Use --help for usage' };
    if (advance < 0)
      return { kind: 'error', error: `Unknown option: ${arg}`, hint: 'Use --help for usage' };
    i += advance;
  }

  if (st.checksumsFile && st.allowUnverifiedTarball) {
    return {
      kind: 'error',
      error: '--checksums-file and --allow-unverified-tarball are mutually exclusive',
    };
  }

  return { kind: 'ok', value: buildArgs(action, st) };
}

/** Parse CLI arguments from process.argv. */
export function parseArgs(argv: string[]): CliParseResult<CliArgs> {
  const action = argv[0];
  if (action === '--help' || action === '-h') {
    return { kind: 'help' };
  }
  if (!action || !VALID_ACTIONS.includes(action as CliAction)) {
    return {
      kind: 'error',
      error: action ? `Unknown command: ${action}` : 'No command specified',
      hint: 'Use --help for usage',
    };
  }

  if (action === 'run' || action === 'serve' || action === 'inspect') {
    return makeDelegatedResult(action);
  }

  return parseInstallArgs(action as CliAction, argv);
}

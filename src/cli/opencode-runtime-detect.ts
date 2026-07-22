/**
 * @module cli/opencode-runtime-detect
 * @description Best-effort OpenCode runtime evidence collection + structured
 * logging. This module never gates: it only produces {@link OpenCodeRuntimeEvidence}
 * and records environment facts. Classification lives in opencode-runtime-compat.ts.
 *
 * Detection strategy (reviewed decision — "Desktop AND CLI, every version"):
 *   - runtimeKind is derived from the OpenCode config ownership heuristic that
 *     already exists in the installer (`hasNonFlowGuardInstructions` + a
 *     `plugin` field indicate a Desktop-owned config). The Desktop app exposes
 *     no `opencode --version` executable, so version detection is CLI-only.
 *   - The CLI version is probed best-effort via `opencode --version`. Any
 *     failure (not installed, not on PATH, timeout) yields `version: null` and
 *     never throws across this boundary.
 *   - runtimeLine is only set when a runtime can be positively identified.
 *     Today no positive runtime-line source exists, so it stays `null`
 *     (=> classifies as `not-classified`, i.e. not positively matched as incompatible).
 *     This is the deliberate deny-list posture.
 *
 * Exactly one structured log record is emitted per detection so operators can
 * see version, executable path, runtime kind, OS, install method and install
 * date in the FlowGuard logs.
 *
 * @version v1
 */

import { execFileSync } from 'node:child_process';
import { release } from 'node:os';
import { getAdapterLogger } from '../logging/adapter-logger.js';
import {
  hasNonFlowGuardInstructions,
  parseJsonc,
  resolveOpencodeConfigPath,
  safeRead,
} from './install-helpers.js';
import type { InstallScope, InstallPlatform } from './install-types.js';
import type { OpenCodeRuntimeEvidence, OpenCodeRuntimeKind } from './opencode-runtime-compat.js';

const VERSION_PROBE_TIMEOUT_MS = 5_000;
/** Guard against pathological output from a hijacked binary on PATH. */
const MAX_VERSION_OUTPUT_LEN = 200;

export interface DetectRuntimeParams {
  scope: InstallScope;
  platform: InstallPlatform;
  target: string;
}

/**
 * Probe the OpenCode CLI version. Best-effort; returns `null` on any failure.
 * Uses execFileSync (no shell) to avoid shell-injection and to keep the call
 * argument-safe.
 */
function probeCliVersion(): string | null {
  try {
    const out = execFileSync('opencode', ['--version'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: VERSION_PROBE_TIMEOUT_MS,
      encoding: 'utf-8',
    });
    const trimmed = String(out).trim();
    if (trimmed.length === 0 || trimmed.length > MAX_VERSION_OUTPUT_LEN) return null;
    return trimmed;
  } catch {
    // opencode not installed / not on PATH / timeout / Desktop-only host.
    return null;
  }
}

/**
 * Derive the runtime kind from the OpenCode config ownership heuristic.
 *
 * A config that carries a `plugin` field or non-FlowGuard instruction entries
 * is a Desktop-owned config (the installer treats these specially and does not
 * rewrite task permissions). Otherwise, if a version can be probed, it is a CLI
 * runtime. If neither signal is present, the kind is `unknown`.
 */
async function deriveRuntimeKind(
  params: DetectRuntimeParams,
  cliVersion: string | null,
): Promise<OpenCodeRuntimeKind> {
  const opencodeJsonPath = resolveOpencodeConfigPath(params.scope, params.target);
  const content = await safeRead(opencodeJsonPath);
  if (content !== null) {
    try {
      const parsed = parseJsonc(content);
      const instructions = Array.isArray(parsed['instructions'])
        ? (parsed['instructions'] as string[])
        : [];
      const isDesktopOwned =
        Object.prototype.hasOwnProperty.call(parsed, 'plugin') ||
        hasNonFlowGuardInstructions(instructions);
      if (isDesktopOwned) return 'desktop-owned';
    } catch {
      // Malformed config is handled elsewhere (doctor/install); for kind
      // derivation we simply fall through to version-based inference.
    }
  }
  return cliVersion !== null ? 'cli' : 'unknown';
}

/**
 * Collect runtime evidence and emit exactly one structured log record.
 *
 * Never throws: detection failures degrade to `null` fields and a fail-closed
 * warn log. A null runtimeLine classifies as `not-classified` (no positive
 * incompatibility match), not as a block signal.
 */
export async function detectOpenCodeRuntimeEvidence(
  params: DetectRuntimeParams,
): Promise<OpenCodeRuntimeEvidence> {
  const version = params.platform === 'opencode' ? probeCliVersion() : null;
  let runtimeKind: OpenCodeRuntimeKind;
  try {
    runtimeKind = await deriveRuntimeKind(params, version);
  } catch {
    runtimeKind = 'unknown';
  }

  // No positive runtime-line source exists today; stays null => not-classified.
  const evidence: OpenCodeRuntimeEvidence = { runtimeKind, version, runtimeLine: null };

  const envelope = {
    version: version ?? null,
    runtimeKind,
    runtimeLine: evidence.runtimeLine,
    executablePath: null as string | null,
    os: `${process.platform} ${release()}`,
    installMethod: `${params.platform}:${params.scope}`,
    installedAt: new Date().toISOString(),
  };

  if (runtimeKind === 'unknown' && version === null) {
    // Fail-closed diagnostic: could not positively identify the runtime. This
    // is not a block (deny-list posture) but is surfaced for operators.
    getAdapterLogger().warn('cli', 'opencode runtime evidence (undetectable)', envelope);
  } else {
    getAdapterLogger().info('cli', 'opencode runtime evidence', envelope);
  }

  return evidence;
}

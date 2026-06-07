/**
 * @module integration/plugin-policy
 * @description P32: Plugin session policy resolver.
 *
 * Extracted for testability - implements the actual P32 policy resolution:
 *
 * Priority: state.policySnapshot.mode > config.policy.defaultMode > solo
 *
 * Cases:
 * - sessDir null → config > solo
 * - state file missing → config > solo (fallback)
 * - state file exists + valid policySnapshot → state wins (no fallback)
 * - state file exists + corrupt/unparseable → throw (fail closed)
 *
 * @tested-by plugin-policy.test.ts
 */

import { resolveRuntimePolicyMode, resolvePolicyWithContext } from '../config/policy.js';
import type { PolicyMode, FlowGuardPolicy } from '../config/policy.js';
import type { SessionState } from '../state/schema.js';
import * as fs from 'node:fs/promises';
import { readState } from '../adapters/persistence.js';
import { resolvePolicyFromSnapshot } from '../config/policy.js';
import { detectCiContext } from '../config/policy.js';

interface Logger {
  debug: (topic: string, message: string, data?: Record<string, unknown>) => void;
  warn: (topic: string, message: string, data?: Record<string, unknown>) => void;
}

interface ResolvePluginSessionPolicyOpts {
  sessDir: string | null;
  configDefaultMode?: PolicyMode;
  log?: Logger;
}

interface ResolvePluginSessionPolicyResult {
  policy: FlowGuardPolicy;
  state: SessionState | null;
}

/**
 * P32: Resolve plugin session policy.
 *
 * Priority: state > config > solo
 */
async function checkStateFileExists(
  sessDir: string,
  log?: ResolvePluginSessionPolicyOpts['log'],
): Promise<boolean> {
  try {
    await fs.access(sessDir + '/session-state.json');
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      log?.warn('policy', 'Failed to access session state file', {
        sessionDir: sessDir,
        code,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return false;
  }
}

function makeFallbackPolicy(configDefaultMode?: PolicyMode) {
  const mode = resolveRuntimePolicyMode({ configDefaultMode });
  return { policy: resolvePolicyWithContext(mode, detectCiContext()).policy };
}

export async function resolvePluginSessionPolicy(
  opts: ResolvePluginSessionPolicyOpts,
): Promise<ResolvePluginSessionPolicyResult> {
  const { sessDir, configDefaultMode, log } = opts;

  if (!sessDir) return { ...makeFallbackPolicy(configDefaultMode), state: null };

  const stateFileExists = await checkStateFileExists(sessDir, log);
  if (!stateFileExists) {
    log?.debug('policy', 'no session state file, using config fallback');
    return { ...makeFallbackPolicy(configDefaultMode), state: null };
  }

  const state = await readState(sessDir);
  if (!state?.policySnapshot) {
    const resolution = resolvePolicyWithContext(
      resolveRuntimePolicyMode({ configDefaultMode }),
      detectCiContext(),
    );
    log?.debug('policy', 'resolved default policy', {
      requestedMode: resolution.requestedMode,
      effectiveMode: resolution.effectiveMode,
    });
    return { policy: resolution.policy, state };
  }

  const policy = resolvePolicyFromSnapshot(state.policySnapshot);
  log?.debug('policy', 'resolved session policy', {
    requestedMode: state.policySnapshot.requestedMode,
    effectiveMode: state.policySnapshot.mode,
  });
  return { policy, state };
}

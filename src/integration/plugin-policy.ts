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
import { policyFromSnapshot } from '../config/policy.js';
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
export async function resolvePluginSessionPolicy(
  opts: ResolvePluginSessionPolicyOpts,
): Promise<ResolvePluginSessionPolicyResult> {
  const { sessDir, configDefaultMode, log } = opts;

  // Case 1: No sessDir → config > solo
  if (!sessDir) {
    const fallbackMode = resolveRuntimePolicyMode({
      configDefaultMode,
    });
    const resolution = resolvePolicyWithContext(fallbackMode, detectCiContext());
    return { policy: resolution.policy, state: null };
  }

  // Case 2: Check if state file exists BEFORE reading
  // This distinguishes "missing state" from "corrupt state"
  let stateFileExists = false;
  try {
    const fs = await import('node:fs/promises');
    await fs.access(sessDir + '/session-state.json');
    stateFileExists = true;
  } catch {
    stateFileExists = false;
  }

  // Case 2a: State file missing → config > solo fallback
  if (!stateFileExists) {
    log?.debug('policy', 'no session state file, using config fallback');
    const fallbackMode = resolveRuntimePolicyMode({ configDefaultMode });
    const resolution = resolvePolicyWithContext(fallbackMode, detectCiContext());
    return { policy: resolution.policy, state: null };
  }

  // Case 2b: State file exists - try to read
  // Any error here is a state integrity problem → fail closed
  let state: SessionState | null = null;
  try {
    const { readState } = await import('../adapters/persistence.js');
    state = await readState(sessDir);
  } catch (err) {
    // Corrupt/unparseable state → fail closed, NOT fallback
    log?.warn('policy', 'failed to read session state, failing closed');
    throw err;
  }

  // Case 3: State exists but no policySnapshot → config > solo
  if (!state?.policySnapshot) {
    const fallbackMode = resolveRuntimePolicyMode({ configDefaultMode });
    const resolution = resolvePolicyWithContext(fallbackMode, detectCiContext());
    log?.debug('policy', 'resolved default policy', {
      requestedMode: resolution.requestedMode,
      effectiveMode: resolution.effectiveMode,
    });
    return { policy: resolution.policy, state };
  }

  // Case 4: Valid policySnapshot → use authority (no fallback)
  const policy = policyFromSnapshot(state.policySnapshot);
  log?.debug('policy', 'resolved session policy', {
    requestedMode: state.policySnapshot.requestedMode,
    effectiveMode: state.policySnapshot.mode,
  });
  return { policy, state };
}

/**
 * @module config/policy-central
 * @description Central policy bundle loading, validation, and strength ordering.
 */

import { readFile as fsReadFile } from 'node:fs/promises';
import * as nodePath from 'node:path';
import { getAdapterLogger } from '../logging/adapter-logger.js';
import type {
  CentralMinimumMode,
  CentralPolicyBundle,
  CentralPolicyEvidence,
  PolicyMode,
} from './policy-types.js';
import { PolicyConfigurationError } from './policy-errors.js';

function normalizeCentralMinimumMode(mode: unknown): CentralMinimumMode {
  if (mode === 'solo' || mode === 'team' || mode === 'regulated') {
    return mode;
  }
  throw new PolicyConfigurationError(
    'CENTRAL_POLICY_INVALID_MODE',
    `Central policy minimumMode must be one of: solo, team, regulated (received: ${String(mode)})`,
  );
}

function parseCentralPolicyBundle(raw: string): CentralPolicyBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PolicyConfigurationError(
      'CENTRAL_POLICY_INVALID_JSON',
      'Central policy file is not valid JSON',
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new PolicyConfigurationError(
      'CENTRAL_POLICY_INVALID_SCHEMA',
      'Central policy must be a JSON object',
    );
  }

  const obj = parsed as Record<string, unknown>;
  if (obj.schemaVersion !== 'v1') {
    throw new PolicyConfigurationError(
      'CENTRAL_POLICY_INVALID_SCHEMA',
      'Central policy schemaVersion must be "v1"',
    );
  }

  const minimumMode = normalizeCentralMinimumMode(obj.minimumMode);

  if (obj.version !== undefined && typeof obj.version !== 'string') {
    throw new PolicyConfigurationError(
      'CENTRAL_POLICY_INVALID_SCHEMA',
      'Central policy version must be a string when provided',
    );
  }

  if (obj.policyId !== undefined && typeof obj.policyId !== 'string') {
    throw new PolicyConfigurationError(
      'CENTRAL_POLICY_INVALID_SCHEMA',
      'Central policy policyId must be a string when provided',
    );
  }

  return {
    schemaVersion: 'v1',
    minimumMode,
    ...(typeof obj.policyId === 'string' ? { policyId: obj.policyId } : {}),
    ...(typeof obj.version === 'string' ? { version: obj.version } : {}),
  };
}

export function modeStrength(mode: PolicyMode | CentralMinimumMode): number {
  if (mode === 'solo') return 1;
  if (mode === 'team' || mode === 'team-ci') return 2;
  return 3;
}

function centralPathHint(absolutePath: string): string {
  return `basename:${nodePath.basename(absolutePath)}`;
}

export async function loadCentralPolicyEvidence(
  policyPath: string,
  digestFn: (text: string) => string,
  readFileFn: (path: string) => Promise<string> = async (path) => fsReadFile(path, 'utf8'),
): Promise<CentralPolicyEvidence> {
  if (!policyPath.trim()) {
    throw new PolicyConfigurationError(
      'CENTRAL_POLICY_PATH_EMPTY',
      'FLOWGUARD_POLICY_PATH is set but empty',
    );
  }

  const absolutePath = nodePath.resolve(policyPath);
  let raw: string;
  try {
    raw = await readFileFn(absolutePath);
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
    const message = err instanceof Error ? err.message : String(err);
    getAdapterLogger().error('policy', 'Central policy file cannot be read', {
      absolutePath,
      code: code || 'unknown',
      error: message,
    });
    throw new PolicyConfigurationError(
      code === 'ENOENT' ? 'CENTRAL_POLICY_MISSING' : 'CENTRAL_POLICY_UNREADABLE',
      `Central policy file cannot be read at ${absolutePath}: ${message}`,
    );
  }

  const bundle = parseCentralPolicyBundle(raw);
  return {
    minimumMode: bundle.minimumMode,
    digest: digestFn(raw),
    ...(bundle.version ? { version: bundle.version } : {}),
    pathHint: centralPathHint(absolutePath),
  };
}

/** Validate an existing session mode against optional central minimum (P29). */
export async function validateExistingPolicyAgainstCentral(opts: {
  existingMode: PolicyMode;
  centralPolicyPath?: string;
  digestFn: (text: string) => string;
  readFileFn?: (path: string) => Promise<string>;
}): Promise<CentralPolicyEvidence | undefined> {
  if (opts.centralPolicyPath === undefined) {
    return undefined;
  }

  const centralEvidence = await loadCentralPolicyEvidence(
    opts.centralPolicyPath,
    opts.digestFn,
    opts.readFileFn,
  );

  if (modeStrength(opts.existingMode) < modeStrength(centralEvidence.minimumMode)) {
    throw new PolicyConfigurationError(
      'EXISTING_POLICY_WEAKER_THAN_CENTRAL',
      `Existing session policy mode '${opts.existingMode}' is weaker than centrally required minimum '${centralEvidence.minimumMode}'`,
    );
  }

  return centralEvidence;
}

/**
 * @module integration/discovery-drift-status
 * @description Runtime-only advisory discovery drift projection for full status.
 *
 * Reuses checkDiscoveryDrift() as the canonical read-only comparison authority.
 * This module never writes discovery/session artifacts and never turns drift
 * into policy, phase, approval, or denial authority.
 */

import { checkDiscoveryDrift, type DriftResult } from '../discovery/drift.js';

export type DiscoveryDriftProjectionStatus =
  | 'clean'
  | 'drifted'
  | 'missing_discovery'
  | 'unavailable'
  | 'timeout'
  | 'not_checked';

export interface DiscoveryDriftStatusWarning {
  readonly code: string;
  readonly message: string;
}

export interface DiscoveryDriftStatusProjection {
  readonly kind: 'derived_discovery_drift';
  readonly advisory: true;
  readonly runtimeOnly: true;
  readonly source: 'checkDiscoveryDrift';
  readonly status: DiscoveryDriftProjectionStatus;
  readonly drifted: boolean | null;
  readonly currentDigest: string | null;
  readonly persistedDigest: string | null;
  readonly changedCollectorNames: string[];
  readonly diagnostics: string[];
  readonly notVerified: string[];
  readonly warnings: DiscoveryDriftStatusWarning[];
}

interface BuildDiscoveryDriftStatusInput {
  readonly workspaceDir: string;
  readonly worktree: string;
  readonly fingerprint: string;
  readonly timeoutMs?: number;
  readonly check?: typeof checkDiscoveryDrift;
}

const DEFAULT_STATUS_DRIFT_TIMEOUT_MS = 3_000;

const BASE_NOT_VERIFIED = [
  'NOT_VERIFIED: Discovery drift status is advisory and never overrides phase, policy, review, validation, or approval gates.',
];

/** Build a bounded, read-only discovery drift projection for full status. */
export async function buildDiscoveryDriftStatus(
  input: BuildDiscoveryDriftStatusInput,
): Promise<DiscoveryDriftStatusProjection> {
  const check = input.check ?? checkDiscoveryDrift;
  const timeoutMs = input.timeoutMs ?? DEFAULT_STATUS_DRIFT_TIMEOUT_MS;

  try {
    const result = await withStatusTimeout(
      check(input.workspaceDir, input.worktree, input.fingerprint),
      timeoutMs,
    );
    return fromDriftResult(result);
  } catch (error) {
    if (isStatusTimeout(error)) {
      return explicitFailure('timeout', 'discovery_drift_timeout', timeoutMessage(timeoutMs));
    }
    return explicitFailure(
      'unavailable',
      'discovery_drift_unavailable',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function notCheckedDiscoveryDriftStatus(reason: string): DiscoveryDriftStatusProjection {
  return explicitFailure('not_checked', 'discovery_drift_not_checked', reason);
}

function fromDriftResult(result: DriftResult): DiscoveryDriftStatusProjection {
  if (result.persistedDigest === null) {
    return {
      ...baseProjection('missing_discovery'),
      currentDigest: result.currentDigest,
      diagnostics: compactDiagnostics(result),
      warnings: [
        {
          code: 'discovery_drift_missing_discovery',
          message:
            'No persisted discovery artifact exists to compare against current repository state.',
        },
      ],
      notVerified: [
        ...BASE_NOT_VERIFIED,
        'NOT_VERIFIED: Persisted discovery artifact is missing; drift cannot be established.',
      ],
    };
  }

  const status: DiscoveryDriftProjectionStatus = result.drifted ? 'drifted' : 'clean';
  return {
    ...baseProjection(status),
    drifted: result.drifted,
    currentDigest: result.currentDigest,
    persistedDigest: result.persistedDigest,
    changedCollectorNames: result.changedCollectors ?? [],
    diagnostics: compactDiagnostics(result),
  };
}

function explicitFailure(
  status: Extract<DiscoveryDriftProjectionStatus, 'unavailable' | 'timeout' | 'not_checked'>,
  code: string,
  message: string,
): DiscoveryDriftStatusProjection {
  return {
    ...baseProjection(status),
    warnings: [{ code, message }],
    notVerified: [...BASE_NOT_VERIFIED, `NOT_VERIFIED: ${message}`],
  };
}

function baseProjection(status: DiscoveryDriftProjectionStatus): DiscoveryDriftStatusProjection {
  return {
    kind: 'derived_discovery_drift',
    advisory: true,
    runtimeOnly: true,
    source: 'checkDiscoveryDrift',
    status,
    drifted: null,
    currentDigest: null,
    persistedDigest: null,
    changedCollectorNames: [],
    diagnostics: [],
    notVerified: [...BASE_NOT_VERIFIED],
    warnings: [],
  };
}

function compactDiagnostics(result: DriftResult): string[] {
  return (result.diagnostics ?? [])
    .map((diag) => {
      const parts = [diag.name, diag.status];
      if (diag.timedOut) parts.push('timedOut');
      if (diag.errorCode) parts.push(diag.errorCode);
      if (diag.degradedReason) parts.push(diag.degradedReason);
      return parts.join(':');
    })
    .slice(0, 12);
}

function withStatusTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new StatusTimeoutError()), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function timeoutMessage(timeoutMs: number): string {
  return (
    `Discovery drift check exceeded ${timeoutMs}ms status budget. ` +
    'The timeout bounds the status response only; underlying discovery work may continue if existing discovery APIs do not support abort signals.'
  );
}

class StatusTimeoutError extends Error {
  constructor() {
    super('discovery drift status timeout');
    this.name = 'StatusTimeoutError';
  }
}

function isStatusTimeout(error: unknown): boolean {
  return error instanceof StatusTimeoutError;
}

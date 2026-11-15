/**
 * @module integration/discovery/discovery-drift-status
 * @description Runtime-only advisory discovery drift projection for full status.
 *
 * Reuses checkDiscoveryDrift() as the canonical read-only comparison authority.
 * This module never writes discovery/session artifacts and never turns drift
 * into policy, phase, approval, or denial authority.
 */

import { checkDiscoveryDrift, type DriftResult } from '../../discovery/drift.js';
import { DISCOVERY_IO } from './discovery-io.js';

export type DiscoveryDriftProjectionStatus =
  'clean' | 'drifted' | 'missing_discovery' | 'unavailable' | 'timeout' | 'not_checked';

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
  readonly changedContributorNames: string[];
  readonly diagnostics: string[];
  readonly notVerified: string[];
  readonly warnings: DiscoveryDriftStatusWarning[];
}

interface BuildDiscoveryDriftStatusInput {
  readonly workspaceDir: string;
  readonly worktree: string;
  readonly fingerprint: string;
  readonly timeoutMs?: number;
  readonly check?: (
    workspaceDir: string,
    worktree: string,
    fingerprint: string,
    signal: AbortSignal,
  ) => Promise<DriftResult>;
}

const DEFAULT_STATUS_DRIFT_TIMEOUT_MS = 3_000;

/** A flight is retained until its underlying operation actually settles. */
interface DriftFlight {
  readonly fingerprint: string;
  readonly controller: AbortController;
  readonly promise: Promise<DriftResult>;
}

/** No two rediscoveries for the same workspace may overlap. */
const activeDriftChecks = new Map<string, DriftFlight>();

function driftKey(input: BuildDiscoveryDriftStatusInput): string {
  return JSON.stringify([input.workspaceDir, input.worktree]);
}

function beginDriftCheck(
  input: BuildDiscoveryDriftStatusInput,
  check: NonNullable<BuildDiscoveryDriftStatusInput['check']>,
): DriftFlight | null {
  const key = driftKey(input);
  const current = activeDriftChecks.get(key);
  if (current) {
    if (current.fingerprint === input.fingerprint && !current.controller.signal.aborted) {
      return current;
    }
    // Even a non-cooperative timed-out operation must not admit another run.
    return null;
  }

  const controller = new AbortController();
  const promise = Promise.resolve().then(() =>
    check(input.workspaceDir, input.worktree, input.fingerprint, controller.signal),
  );
  const flight: DriftFlight = { fingerprint: input.fingerprint, controller, promise };
  activeDriftChecks.set(key, flight);
  const release = (): void => {
    if (activeDriftChecks.get(key) === flight) activeDriftChecks.delete(key);
  };
  void promise.then(release, release);
  return flight;
}

const BASE_NOT_VERIFIED = [
  'NOT_VERIFIED: Discovery drift status is advisory and never overrides phase, policy, review, validation, or approval gates.',
];

/** Build a bounded, read-only discovery drift projection for full status. */
export async function buildDiscoveryDriftStatus(
  input: BuildDiscoveryDriftStatusInput,
): Promise<DiscoveryDriftStatusProjection> {
  const check =
    input.check ??
    ((workspaceDir, worktree, fingerprint, signal) =>
      checkDiscoveryDrift(workspaceDir, worktree, fingerprint, DISCOVERY_IO, signal));
  const timeoutMs = input.timeoutMs ?? DEFAULT_STATUS_DRIFT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return explicitFailure('unavailable', 'discovery_drift_unavailable', 'Invalid status timeout.');
  }

  const flight = beginDriftCheck(input, check);
  if (flight === null) {
    return notCheckedDiscoveryDriftStatus(
      'A previous discovery drift check is still running or cancelling for this workspace.',
    );
  }

  try {
    const result = await withStatusTimeout(flight.promise, timeoutMs, flight.controller);
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
    changedContributorNames: result.changedContributors ?? [],
    diagnostics: compactDiagnostics(result),
    ...(result.attributionStatus === 'unavailable'
      ? {
          warnings: [
            {
              code: 'discovery_drift_attribution_incomplete',
              message:
                'Discovery drift was detected but could not be attributed to a named semantic contributor.',
            },
          ],
          notVerified: [
            ...BASE_NOT_VERIFIED,
            'NOT_VERIFIED: Discovery drift attribution is incomplete; inspect the persisted and current discovery artifacts.',
          ],
        }
      : {}),
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
    changedContributorNames: [],
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

function withStatusTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  controller: AbortController,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const error = new StatusTimeoutError();
      reject(error);
      controller.abort(error);
    }, timeoutMs);
    void promise.then(
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
    'Cancellation was requested; underlying work may continue if a collector ignores the abort signal.'
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

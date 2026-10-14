/**
 * @module workspace/upgrade-preflight-live-state
 * @description Classification of a live session state that the canonical
 * read boundary refused, for the read-only upgrade preflight.
 *
 * The single mapping from the canonical `readState` error code to the
 * preflight status and its registered finding code. Every finding code emitted
 * here is registered in `src/config/reasons-infra-preflight.ts` /
 * `src/config/reasons-infra.ts`; no code is assembled from a template.
 * @version v1
 */

/** Live-state statuses that denote a refused read. */
export type UnreadableLiveStateStatus = 'incompatible' | 'unreadable' | 'integrity_mismatch';

/** Registered finding code per refused live-state status. */
export const LIVE_STATE_FINDING_CODES: Readonly<Record<UnreadableLiveStateStatus, string>> = {
  incompatible: 'STATE_INCOMPATIBLE',
  unreadable: 'STATE_UNREADABLE',
  integrity_mismatch: 'STATE_INTEGRITY_MISMATCH',
};

export interface LiveStateReadFailure {
  readonly status: UnreadableLiveStateStatus;
  readonly finding: {
    readonly severity: 'blocker';
    readonly code: string;
    readonly message: string;
    readonly recovery: readonly string[];
  };
}

/** Classify an error thrown by the canonical state read for one session. */
export function classifyLiveStateReadFailure(
  sessionId: string,
  error: unknown,
): LiveStateReadFailure {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'UNKNOWN';
  const status: UnreadableLiveStateStatus =
    code === 'POLICY_SNAPSHOT_INTEGRITY_MISMATCH'
      ? 'integrity_mismatch'
      : code === 'SESSION_STATE_INCOMPATIBLE'
        ? 'incompatible'
        : 'unreadable';
  return {
    status,
    finding: {
      severity: 'blocker',
      code: LIVE_STATE_FINDING_CODES[status],
      message: `Session ${sessionId} state cannot be read under the current contract (${code}).`,
      recovery: [
        status === 'integrity_mismatch'
          ? 'Preserve the suspect state; restore a trusted copy and investigate the integrity mismatch. Changing runtime versions does not repair it.'
          : 'Recover the session with the release that wrote it: complete active sessions normally.',
        'Archive terminal sessions only when the archive preflight permits it; preserve aborted or otherwise non-exportable evidence unchanged.',
        'Do not edit persisted state to bridge the contract boundary.',
      ],
    },
  };
}

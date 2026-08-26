/**
 * @module integration/review/observation-resolution
 * @description Host-side resolution of an echoed observation capability to the
 *              exact review attempt, obligation, and session directory.
 *
 * The observation tool runs inside the reviewer CHILD session, which has no
 * session-state.json of its own. It therefore resolves the capability by
 * scanning the workspace's session directories for the owning attempt — the
 * capability is cryptographically unguessable, so a match is the binding
 * authority itself. Fail-closed: no match means the capability is unknown or
 * not currently usable.
 *
 * @version v1
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { readState } from '../../adapters/persistence.js';
import { sessionDir } from '../../adapters/workspace/index.js';
import type { SessionState } from '../../state/schema.js';
import type { ReviewAttempt, ReviewObligation } from '../../state/evidence.js';

export interface CapabilityResolution {
  /** Owning parent session directory. */
  readonly sessDir: string;
  /** Owning parent session identity — the authority that must reconcile its outbox before the observation may persist a capture. */
  readonly sessionId: string;
  readonly attempt: ReviewAttempt;
  readonly obligation: ReviewObligation;
}

/** Attempt statuses during which an observation capability may be used. */
const USABLE_ATTEMPT_STATUSES: ReadonlySet<ReviewAttempt['status']> = new Set([
  'created',
  'captured',
]);

/**
 * Resolve an echoed observation capability to its owning attempt by scanning
 * the workspace's session directories. Returns null when no usable attempt
 * carries the capability.
 */
export async function resolveAttemptByCapability(input: {
  readonly workspaceHome: string;
  readonly fingerprint: string;
  readonly capability: string;
}): Promise<CapabilityResolution | null> {
  const sessionsRoot = path.join(input.workspaceHome, input.fingerprint, 'sessions');
  let entries: string[];
  try {
    entries = await fs.readdir(sessionsRoot);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const sessDir = sessionDir(input.fingerprint, entry);
    let state: SessionState | null;
    try {
      state = await readState(sessDir);
    } catch {
      continue;
    }
    if (!state?.reviewAssurance) continue;
    const attempt = state.reviewAssurance.attempts.find(
      (a) => a.observationCapability === input.capability && USABLE_ATTEMPT_STATUSES.has(a.status),
    );
    if (!attempt) continue;
    const obligation = state.reviewAssurance.obligations.find(
      (o) => o.obligationId === attempt.obligationId,
    );
    if (!obligation) return null;
    return { sessDir, sessionId: entry, attempt, obligation };
  }
  return null;
}

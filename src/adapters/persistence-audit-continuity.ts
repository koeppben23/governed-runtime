/**
 * @module adapters/persistence-audit-continuity
 * @description Durable anti-reset guard for the canonical audit trail.
 *
 * The marker is not audit evidence. It exists only to distinguish a legitimate
 * genesis append from a trail that disappeared after canonical history existed.
 */
import * as fs from 'node:fs/promises';
import { channel } from 'node:diagnostics_channel';
import { join } from 'node:path';
import type { SessionState } from '../state/schema.js';
import { getAdapterLogger } from '../logging/adapter-logger.js';
import {
  auditPath,
  durableAtomicWrite,
  isEnoent,
  readState,
  syncDirectory,
} from './persistence.js';
import { AuditFormatError } from './persistence-audit-errors.js';

const AUDIT_HISTORY_MARKER = '.audit-history';
const auditContinuityChannel = channel('flowguard.audit.continuity-marker');

async function hasAuditHistoryMarker(sessionDir: string): Promise<boolean> {
  try {
    await fs.access(join(sessionDir, AUDIT_HISTORY_MARKER));
    return true;
  } catch (err) {
    if (isEnoent(err)) return false;
    throw err;
  }
}

/**
 * Persist the continuity marker durably before any audit bytes are published.
 *
 * The marker is a local crash-consistency guard, not audit evidence: a crash
 * after this write but before the audit rename leaves a marker without a trail,
 * which the next writer rejects with an explicit recovery requirement. That
 * false positive is the intentional fail-closed side of the crash window.
 */
export async function ensureAuditHistoryMarker(
  sessionDir: string,
): Promise<{ readonly created: boolean }> {
  if (await hasAuditHistoryMarker(sessionDir)) return { created: false };
  await durableAtomicWrite(join(sessionDir, AUDIT_HISTORY_MARKER), 'audit-chain.v3\n');
  if (auditContinuityChannel.hasSubscribers) {
    // Deterministic fault-injection seam for the crash matrix; production has
    // no subscribers and pays only the boolean check.
    auditContinuityChannel.publish({ sessionDir });
  }
  return { created: true };
}

/**
 * After a failed first publish, remove only the marker this invocation created.
 * The marker must survive whenever the audit file exists (even partially or
 * with an unconfirmed rename): that is history the next writer must verify.
 */
export async function removeMarkerIfTrailMissing(sessionDir: string): Promise<void> {
  try {
    await fs.access(auditPath(sessionDir));
    return;
  } catch (err) {
    if (!isEnoent(err)) return;
  }
  try {
    await fs.unlink(join(sessionDir, AUDIT_HISTORY_MARKER));
    await syncDirectory(sessionDir);
  } catch (err) {
    if (!isEnoent(err)) {
      getAdapterLogger().error(
        'persistence-audit',
        'Failed to remove continuity marker after a failed first append',
        {
          sessionDir,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }
}

/**
 * `state_committed` is the pre-audit outbox hand-off and therefore does not
 * prove that a trail ever existed. `audit_committed`/`reconciled` operations and
 * a retired outbox checkpoint reference canonical audit positions, so their
 * presence without a trail requires explicit recovery.
 */
function hasPublishedAuditEvidence(state: SessionState): boolean {
  if (state.auditOutboxCheckpoint !== undefined) return true;
  return state.pendingAuditOperations.some((operation) => operation.status !== 'state_committed');
}

/**
 * A missing/empty trail is only a valid genesis when no prior history is known.
 * The in-process proof catches same-process deletion; the durable marker catches
 * a restart after the first append; persisted audit acknowledgements catch
 * legacy sessions whose trail disappeared before the marker existed.
 */
export async function assertAuditHistoryContinuity(
  sessionDir: string,
  existing: string,
  hasPriorProof: boolean,
): Promise<void> {
  if (existing.length > 0) return;
  if (hasPriorProof) {
    throw new AuditFormatError(
      'Audit trail disappeared after canonical history; explicit recovery is required.',
    );
  }
  if (await hasAuditHistoryMarker(sessionDir)) {
    throw new AuditFormatError(
      'Audit trail is missing but a prior history marker exists; explicit recovery is required.',
    );
  }
  const state = await readState(sessionDir);
  if (state !== null && hasPublishedAuditEvidence(state)) {
    throw new AuditFormatError(
      'Audit trail is missing for a session with persisted audit evidence; explicit recovery is required.',
    );
  }
}

/**
 * @module persistence-observation-ledger
 * @description Append-only JSONL store for child-side repository observation
 *              captures.
 *
 * Written by the sanctioned observation tool while the reviewer child session
 * runs. Namespaced by the capability digest so a capture can never bleed into
 * another attempt's ledger. Reads tolerate corrupt lines and skip them,
 * mirroring the reviewer-capture read contract.
 *
 * Transport facts only — the ledger is NEVER governance authority. The parent
 * replay validates every entry (capability match, frozen re-acquisition,
 * digest equality) before minting authoritative `RepositoryObservation`
 * records onto the review attempt.
 *
 * @version v1
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { RepositoryObservationCapture } from '../state/evidence.js';
import { durableAtomicWrite, ensureDir, PersistenceError, isEnoent } from './persistence.js';
import { withSessionWriteLock } from './persistence-lock.js';

/** Namespace key of an observation ledger: sha256 hex of the capability. */
export function observationCapabilityDigest(capability: string): string {
  return createHash('sha256').update(capability, 'utf-8').digest('hex');
}

/** Ledger directory root for a workspace fingerprint. */
export function observationLedgerRoot(workspaceHome: string, fingerprint: string): string {
  return path.join(workspaceHome, 'observation-ledgers', fingerprint);
}

export function observationLedgerPath(ledgerRoot: string, capabilityDigest: string): string {
  return path.join(ledgerRoot, `${capabilityDigest}.jsonl`);
}

/**
 * Append a single observation capture to the capability-namespaced ledger.
 * Zod-validates before appending (fail-closed). Single-line JSON, trailing
 * newline. The caller supplies the already-computed capability digest.
 */
export async function appendObservationCapture(
  ledgerRoot: string,
  capabilityDigest: string,
  capture: RepositoryObservationCapture,
): Promise<RepositoryObservationCapture> {
  const result = RepositoryObservationCapture.safeParse(capture);
  if (!result.success) {
    throw new PersistenceError(
      'SCHEMA_VALIDATION_FAILED',
      `Refusing to append invalid observation capture: ${result.error.message}`,
    );
  }
  await withSessionWriteLock(ledgerRoot, async () => {
    await ensureDir(ledgerRoot);
    const filePath = observationLedgerPath(ledgerRoot, capabilityDigest);
    let existing = '';
    try {
      existing = await fs.readFile(filePath, 'utf-8');
    } catch (err: unknown) {
      if (!isEnoent(err)) {
        throw new PersistenceError(
          'WRITE_FAILED',
          `Failed to read existing observation ledger before append: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const line = JSON.stringify(result.data) + '\n';
    const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    await durableAtomicWrite(filePath, existing + separator + line);
  });
  return result.data;
}

/**
 * Read all captures from a capability-namespaced ledger. Returns an empty
 * array when no file exists; skips malformed lines with best-effort tolerance.
 */
export async function readObservationCaptures(
  ledgerRoot: string,
  capabilityDigest: string,
): Promise<{ captures: RepositoryObservationCapture[]; skipped: number }> {
  let raw: string;
  try {
    raw = await fs.readFile(observationLedgerPath(ledgerRoot, capabilityDigest), 'utf-8');
  } catch (err: unknown) {
    if (isEnoent(err)) return { captures: [], skipped: 0 };
    throw new PersistenceError(
      'READ_FAILED',
      `Failed to read observation ledger: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const captures: RepositoryObservationCapture[] = [];
  let skipped = 0;
  for (const lineRaw of raw.split('\n')) {
    const trimmed = lineRaw.trim();
    if (!trimmed) continue;
    try {
      const parsed = RepositoryObservationCapture.safeParse(JSON.parse(trimmed));
      if (parsed.success) captures.push(parsed.data);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { captures, skipped };
}

/**
 * @module integration/review/observation-replay
 * @description Parent-side replay that turns child observation captures into
 *              authoritative, attempt-bound RepositoryObservation records.
 *
 * A capture is transport fact. Only this replay mints governance authority,
 * and only AFTER the actual reviewer child session is known. Every capture is
 * re-validated against the frozen repository target:
 *
 * ```text
 * capture.capability ledger namespace (attempt-scoped file)
 *   + capture.revision → frozen revision target
 *   + capture.resolvedObjectSha === target.objectSha
 *   + re-acquired immutable bytes digest === capture.contentDigest
 *   + rebuilt delivered payload digest === capture.responseDigest
 * ```
 *
 * Invalid captures are dropped and never become authority. Re-acquisition and
 * digest verification run OUTSIDE the serialized assurance mutation.
 *
 * @version v1
 */

import { randomUUID } from 'node:crypto';
import { computeFingerprint, workspacesHome } from '../../adapters/workspace/index.js';
import {
  FrozenRepositoryError,
  acquireFrozenRepositoryContent,
} from '../../adapters/frozen-repository.js';
import {
  observationCapabilityDigest,
  observationLedgerRoot,
  readObservationCaptures,
} from '../../adapters/persistence-observation-ledger.js';
import type { SessionState } from '../../state/schema.js';
import type { RepositoryObservation, ReviewAttempt } from '../../state/evidence.js';
import { resolveFrozenRevisionTarget } from '../../state/evidence.js';
import {
  buildObservationToolResponse,
  classifyRepresentation,
  contentDigestOf,
  responseDigestOf,
} from './observation-service.js';

export interface ObservationReplayResult {
  /** Authoritative observations minted by this replay. */
  readonly observations: RepositoryObservation[];
  /** Capture lines that failed validation and were dropped (audit signal). */
  readonly dropped: number;
}

async function resolveCapability(
  assurance: SessionState['reviewAssurance'],
  attemptId: string,
): Promise<string | null> {
  const attempt = assurance?.attempts.find((a) => a.attemptId === attemptId);
  if (!attempt?.observationCapability) return null;
  return attempt.observationCapability;
}

function mintObservation(input: {
  attempt: ReviewAttempt;
  childSessionId: string;
  now: string;
  path: string;
  revision: 'base' | 'head';
  target: NonNullable<ReturnType<typeof resolveFrozenRevisionTarget>>;
  contentDigest: string;
  byteLength: number;
  representation: 'utf8_text' | 'binary';
  capturedAt: string;
  acquisitionKind: 'local_git_object' | 'remote_commit_blob';
}): RepositoryObservation {
  return {
    observationId: randomUUID(),
    obligationId: input.attempt.obligationId,
    attemptId: input.attempt.attemptId,
    observedBySessionId: input.childSessionId,
    path: input.path,
    revision: input.revision,
    repositoryIdentity: input.target.repositoryIdentity,
    resolvedObjectSha: input.target.objectSha,
    contentDigest: input.contentDigest,
    byteLength: input.byteLength,
    representation: input.representation,
    capturedAt: input.capturedAt,
    boundAt: input.now,
    acquisition: { kind: input.acquisitionKind },
  };
}

/**
 * Validate ONE capture against the frozen authority and re-acquired bytes.
 * Returns the minted observation or a drop marker. A capture is authority
 * only when every digest binds: frozen target, exact bytes, delivered payload.
 */
function validateAndMintCapture(input: {
  readonly attempt: ReviewAttempt;
  readonly obligation: import('../../state/evidence.js').ReviewObligation;
  readonly worktree: string;
  readonly childSessionId: string;
  readonly now: string;
  readonly capture: import('../../state/evidence.js').RepositoryObservationCapture;
}): { observation: RepositoryObservation } | { drop: true } {
  const { capture, obligation, worktree } = input;
  // Execution boundary: the capture must have been produced by the EXACT
  // session the replay binds. A parent-side tool call (or any other session)
  // never becomes reviewer observation authority — the session identity was
  // recorded at capture time, not invented here.
  if (capture.capturedSessionId !== input.childSessionId) return { drop: true };
  const target = resolveFrozenRevisionTarget(obligation, capture.revision);
  if (!target || target.objectSha !== capture.resolvedObjectSha) return { drop: true };
  let acquired;
  try {
    acquired = acquireFrozenRepositoryContent(worktree, target, capture.path);
  } catch (err) {
    if (err instanceof FrozenRepositoryError) return { drop: true };
    throw err;
  }
  const contentDigest = contentDigestOf(acquired.bytes);
  if (contentDigest !== capture.contentDigest) return { drop: true };
  const representation = classifyRepresentation(acquired.bytes);
  if (representation !== capture.representation) return { drop: true };
  const content =
    representation === 'utf8_text'
      ? acquired.bytes.toString('utf-8')
      : acquired.bytes.toString('base64');
  const response = buildObservationToolResponse({
    path: capture.path,
    revision: capture.revision,
    representation,
    content,
  });
  if (responseDigestOf(response) !== capture.responseDigest) return { drop: true };
  return {
    observation: mintObservation({
      attempt: input.attempt,
      childSessionId: input.childSessionId,
      now: input.now,
      path: capture.path,
      revision: capture.revision,
      target,
      contentDigest,
      byteLength: acquired.bytes.length,
      representation,
      capturedAt: capture.capturedAt,
      acquisitionKind: acquired.kind,
    }),
  };
}

/**
 * Resolve the observation ledger fingerprint. The persisted workspace binding
 * carries the canonical fingerprint from hydrate time; recomputing it here
 * would re-run git remote resolution and emit misleading warnings for
 * legitimate local repositories.
 */
async function resolveLedgerFingerprint(state: SessionState, worktree: string): Promise<string> {
  const bound = state.binding?.fingerprint;
  if (bound) return bound;
  return (await computeFingerprint(worktree)).fingerprint;
}

/**
 * Replay the observation ledger of an attempt AFTER its reviewer child session
 * is known, and return the authoritative observations to persist. Never
 * mutates state; the caller persists via the serialized assurance channel.
 */
export async function replayObservationCaptures(input: {
  readonly state: SessionState;
  readonly worktree: string;
  readonly attemptId: string;
  readonly childSessionId: string;
  readonly now: string;
}): Promise<ObservationReplayResult> {
  const assurance = input.state.reviewAssurance;
  const attempt = assurance?.attempts.find((a) => a.attemptId === input.attemptId);
  const capability = attempt ? await resolveCapability(assurance, input.attemptId) : null;
  if (!attempt || !capability) return { observations: [], dropped: 0 };
  const obligation = assurance?.obligations.find((o) => o.obligationId === attempt.obligationId);
  if (!obligation) return { observations: [], dropped: 0 };

  const fingerprint = await resolveLedgerFingerprint(input.state, input.worktree);
  const ledgerRoot = observationLedgerRoot(workspacesHome(), fingerprint);
  const { captures, skipped } = await readObservationCaptures(
    ledgerRoot,
    observationCapabilityDigest(capability),
  );

  const existing = new Set(
    (attempt.observations ?? []).map((o) => `${o.path}\u0000${o.revision}\u0000${o.contentDigest}`),
  );
  const observations: RepositoryObservation[] = [];
  let dropped = skipped;

  for (const capture of captures) {
    const result = validateAndMintCapture({
      attempt,
      obligation,
      worktree: input.worktree,
      childSessionId: input.childSessionId,
      now: input.now,
      capture,
    });
    if ('drop' in result) {
      dropped++;
      continue;
    }
    const key = `${capture.path}\u0000${capture.revision}\u0000${result.observation.contentDigest}`;
    if (existing.has(key)) continue;
    existing.add(key);
    observations.push(result.observation);
  }

  return { observations, dropped };
}

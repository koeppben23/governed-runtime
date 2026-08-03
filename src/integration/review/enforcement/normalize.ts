/**
 * @module integration/review-enforcement-normalize
 * @description Host-authoritative normalization of reviewer challenge output.
 *
 * The reviewer subagent never defines a challenge identity — only the host does.
 * The canonical reviewer prompt therefore asks for a `clientReference` slug (see
 * `renderReviewerTaskPrompt`), and this module maps each slug to a host-minted
 * UUID `challengeId` before the canonical schema gate runs.
 *
 * Normalization is deliberately mechanical: it assigns host-authoritative
 * identity and nothing else. It never validates challenge shape, so the
 * canonical `ReviewFindings` schema stays the single runtime gate and there is
 * exactly one place that can reject reviewer output.
 *
 * @version v1
 */

import { randomUUID } from 'node:crypto';

/** Outcome of mapping reviewer challenge slugs onto host-minted identities. */
export type NormalizeChallengesResult =
  | { readonly ok: true; readonly challenges: readonly Record<string, unknown>[] }
  | {
      readonly ok: false;
      readonly code: 'duplicate_client_reference';
      readonly clientReference: string;
      readonly index: number;
    };

/** Read a reviewer-supplied `clientReference`, or null when none was provided. */
function readClientReference(entry: Record<string, unknown>): string | null {
  const ref = entry.clientReference;
  return typeof ref === 'string' && ref.length > 0 ? ref : null;
}

/**
 * Assign host-authoritative identity to reviewer-supplied challenges.
 *
 * - Mints a fresh `challengeId` for every entry; a reviewer-supplied one is
 *   always discarded, never trusted.
 * - Stamps the bound `obligationId`, mirroring how `reviewedBy` / `reviewedAt`
 *   are host-stamped. A challenge cannot name an obligation other than the one
 *   its findings payload is being bound to.
 * - Preserves a supplied `clientReference` for audit correlation, and rejects
 *   duplicates within a single payload because they would make the mapping from
 *   reviewer slug to canonical `challengeId` ambiguous.
 * - Never invents a `clientReference` when the reviewer omitted one.
 *
 * Non-object entries pass through untouched so the canonical schema gate — not
 * this function — produces the authoritative rejection.
 *
 * @param inputs - Raw, unvalidated `challenges` entries from reviewer output.
 * @param obligationId - The obligation the findings payload is bound to.
 * @param newChallengeId - Identity factory; injectable for deterministic tests.
 */
export function normalizeChallenges(
  inputs: readonly unknown[],
  obligationId: string,
  newChallengeId: () => string = randomUUID,
): NormalizeChallengesResult {
  const challenges: Record<string, unknown>[] = [];
  const usedRefs = new Set<string>();

  for (const [index, input] of inputs.entries()) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      challenges.push(input as Record<string, unknown>);
      continue;
    }

    const entry = input as Record<string, unknown>;
    const ref = readClientReference(entry);
    if (ref !== null) {
      if (usedRefs.has(ref)) {
        return { ok: false, code: 'duplicate_client_reference', clientReference: ref, index };
      }
      usedRefs.add(ref);
    }

    challenges.push({
      ...entry,
      challengeId: newChallengeId(),
      obligationId,
      ...(ref === null ? {} : { clientReference: ref }),
    });
  }

  return { ok: true, challenges };
}

/**
 * @module integration/review/evidence/finding-identity
 * @description Host-authoritative finding identity.
 *
 * Reviewer-supplied `findingId` values are never trusted. The host mints one
 * identity per finding exactly once, at the authoritative evidence-binding
 * boundary, and persists it with the canonical findings. Later consumption
 * must reuse that identity rather than minting a second one.
 */

import { randomUUID } from 'node:crypto';
import type { ReviewFindings } from '../../../state/evidence.js';

/** Mint host-authoritative identities for every blocking finding and major risk. */
export function mintHostFindingIds(findings: ReviewFindings): ReviewFindings {
  return {
    ...findings,
    blockingIssues: findings.blockingIssues.map((finding) => ({
      ...finding,
      findingId: randomUUID(),
    })),
    majorRisks: findings.majorRisks.map((finding) => ({
      ...finding,
      findingId: randomUUID(),
    })),
  };
}

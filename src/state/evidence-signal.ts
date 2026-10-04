/**
 * @module evidence-signal
 * @description Canonical evidence signal classification vocabulary.
 *
 * A single, shared enum for classifying how strongly a repository/evidence
 * signal is grounded. It is deliberately layer-neutral (depends only on Zod)
 * so every consumer references the SAME vocabulary instead of duplicating it:
 *
 * - Discovery (`discovery/types.ts`) re-exports it as `EvidenceClassSchema`.
 * - ProofGraph (`state/proofgraph.ts`) consumes it as a claim's `signalClass`.
 *
 * Semantics (aligned with ROADMAP `RepoIntelligenceSnapshot v1`):
 * - `fact`: directly observed in the repository (file/config present, executed).
 *   Only `fact` claims may participate in a blocking policy decision.
 * - `derived_signal`: inferred from a combination of facts; advisory unless
 *   independently corroborated by policy.
 * - `hypothesis`: low-confidence heuristic; drives review prompts and
 *   `NOT_VERIFIED` items, never an automatic blocking decision.
 *
 * @version v1
 */

import { z } from 'zod';

/** Canonical evidence/claim signal classification. */
export const SignalClass = z.enum(['fact', 'derived_signal', 'hypothesis']);
export type SignalClass = z.infer<typeof SignalClass>;

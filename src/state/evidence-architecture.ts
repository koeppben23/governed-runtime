/**
 * @module evidence-architecture
 * @description Architecture Decision Record (ADR) evidence schemas.
 *
 * @version v1
 */

import { z } from 'zod';
import { AdrStatus } from './evidence-primitives.js';
import { ReviewFindings } from './evidence-review.js';

/**
 * Required MADR sections in the ADR text.
 * The adrText MUST contain these markdown headings for section validation.
 */
export const REQUIRED_ADR_SECTIONS = ['## Context', '## Decision', '## Consequences'] as const;

/**
 * Validate that an ADR text contains all required MADR sections.
 * Returns the list of missing section headings (empty = valid).
 */
export function validateAdrSections(adrText: string): string[] {
  return REQUIRED_ADR_SECTIONS.filter((heading) => !adrText.includes(heading));
}

/**
 * Architecture Decision Record (ADR) evidence.
 * Produced by the /architecture flow. Follows MADR format.
 *
 * The adrText is free-form Markdown that MUST contain:
 * - ## Context
 * - ## Decision
 * - ## Consequences
 */
export const ArchitectureDecision = z
  .object({
    /** ADR identifier (e.g., "ADR-1", "ADR-42"). */
    id: z.string().regex(/^ADR-\d+$/),
    /** Short title of the architecture decision. */
    title: z.string().min(1),
    /** Full ADR body in Markdown (MADR format with required sections). */
    adrText: z.string().min(1),
    /** Lifecycle status of the ADR. */
    status: AdrStatus,
    /** When the ADR was created. */
    createdAt: z.string().datetime(),
    /** SHA-256 digest of the adrText for integrity verification. */
    digest: z.string().min(1),
    /**
     * Independent review findings, one entry per review iteration (F13).
     *
     * Parallel to plan.reviewFindings and implementation.reviewFindings:
     * stored append-only as the architecture review loop progresses, so the
     * full review history is auditable. Optional for backwards-compat with
     * sessions created before F13 — absent and empty array MUST be treated
     * equivalently by all consumers.
     */
    reviewFindings: z.array(ReviewFindings).optional(),
  })
  .readonly();
export type ArchitectureDecision = z.infer<typeof ArchitectureDecision>;

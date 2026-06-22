/**
 * @module integration/review/orchestrator-constants
 * @description Shared constants for the review orchestrator.
 *
 * Extracted from orchestrator.ts as a leaf module so both output-mutation
 * and core invocation can reference the prefix without cyclical imports.
 *
 * @version v1
 */

/** Prefix used in the mutated output to indicate review was completed by plugin. */
export const REVIEW_COMPLETED_PREFIX = 'INDEPENDENT_REVIEW_COMPLETED';

/**
 * @module evidence
 * @description Canonical public aggregation facade for evidence contracts.
 *              All implementation lives in focused evidence-* modules.
 *              This file is the public entry point for `state/evidence.js` imports.
 *
 *              evidence-assurance-internal.ts MUST NOT appear in these re-exports —
 *              OpenCodeSessionId is an internal helper and was never part of the
 *              public evidence.ts API surface.
 *
 * @version v2 (split into focused modules, no behavior change, no API expansion)
 */

// ─── Primitives (public enums, scalars) — no internal helpers ────────────────

export * from './evidence-primitives.js';

// ─── Error ─────────────────────────────────────────────────────────────────────

export * from './evidence-error.js';

// ─── Ticket ────────────────────────────────────────────────────────────────────

export * from './evidence-ticket.js';

// ─── Binding ───────────────────────────────────────────────────────────────────

export * from './evidence-binding.js';

// ─── Validation ────────────────────────────────────────────────────────────────

export * from './evidence-validation.js';

// ─── Implementation ────────────────────────────────────────────────────────────

export * from './evidence-impl.js';

// ─── Plan ──────────────────────────────────────────────────────────────────────

export * from './evidence-plan.js';

// ─── Architecture ──────────────────────────────────────────────────────────────

export * from './evidence-architecture.js';

// ─── ProofGraph Approval ───────────────────────────────────────────────────────

export * from './proofgraph-approval.js';

// ─── Review (findings, obligations, assurance, completeness, report, decision) ─

export * from './evidence-findings.js';
export * from './evidence-review-subject.js';
export * from './evidence-review-authority.js';
export * from './evidence-review-attempt-discovery.js';
export * from './evidence-review-challenge.js';
export * from './evidence-review-invocation.js';
export * from './review-cycles.js';
export * from './evidence-review.js';
export * from './evidence-review-completeness.js';
export * from './evidence-review-attestation.js';
export * from './evidence-review-report.js';
export * from './evidence-review-input.js';

// ─── Peer review (coverage projection over canonical peer-review evidence) ────

export { PeerReviewCoverage } from './peer-review.js';

// ─── Identity ──────────────────────────────────────────────────────────────────

export * from './evidence-identity.js';

// ─── Policy Snapshot ───────────────────────────────────────────────────────────

export * from './evidence-policy.js';

// ─── Audit ─────────────────────────────────────────────────────────────────────

export * from './evidence-audit.js';

// ─── Mutation ───────────────────────────────────────────────────────────────────

export * from './evidence-mutation.js';

// ─── Implementation review budget ────────────────────────────────────────────

export * from './implementation-review-budget.js';

// ─── Timestamp ─────────────────────────────────────────────────────────────────

export * from './evidence-timestamp.js';

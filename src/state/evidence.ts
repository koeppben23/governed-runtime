/**
 * @module evidence
 * @description Evidence barrel — stable compatibility facade.
 *              All implementation lives in focused evidence-* modules.
 *              Keep this file as the entry point for existing imports from 'state/evidence.js'.
 *
 *              evidence-assurance-internal.ts MUST NOT appear in these re-exports —
 *              OpenCodeSessionId, coerceAssurance, and assuranceSchema are internal helpers
 *              and were never part of the public evidence.ts API surface.
 *
 * @version v2 (split into focused modules, no behavior change, no API expansion)
 */

// ─── Primitives (public enums, scalars) — no internal helpers ────────────────

export * from './evidence-primitives.js';
export type * from './evidence-primitives.js';

// ─── Error ─────────────────────────────────────────────────────────────────────

export * from './evidence-error.js';
export type * from './evidence-error.js';

// ─── Ticket ────────────────────────────────────────────────────────────────────

export * from './evidence-ticket.js';
export type * from './evidence-ticket.js';

// ─── Binding ───────────────────────────────────────────────────────────────────

export * from './evidence-binding.js';
export type * from './evidence-binding.js';

// ─── Validation ────────────────────────────────────────────────────────────────

export * from './evidence-validation.js';
export type * from './evidence-validation.js';

// ─── Implementation ────────────────────────────────────────────────────────────

export * from './evidence-impl.js';
export type * from './evidence-impl.js';

// ─── Plan ──────────────────────────────────────────────────────────────────────

export * from './evidence-plan.js';
export type * from './evidence-plan.js';

// ─── Architecture ──────────────────────────────────────────────────────────────

export * from './evidence-architecture.js';
export type * from './evidence-architecture.js';

// ─── Review (findings, obligations, assurance, completeness, report, decision) ─

export * from './evidence-review.js';
export type * from './evidence-review.js';

// ─── Identity ──────────────────────────────────────────────────────────────────

export * from './evidence-identity.js';
export type * from './evidence-identity.js';

// ─── Policy Snapshot ───────────────────────────────────────────────────────────

export * from './evidence-policy.js';
export type * from './evidence-policy.js';

// ─── Audit ─────────────────────────────────────────────────────────────────────

export * from './evidence-audit.js';
export type * from './evidence-audit.js';

// ─── Timestamp ─────────────────────────────────────────────────────────────────

export * from './evidence-timestamp.js';
export type * from './evidence-timestamp.js';

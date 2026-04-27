/**
 * @module state/discovery-schemas
 * @description Zod schemas for discovery-derived data embedded in SessionState.
 *
 * These schemas define the persistence shape of discovery results stored in
 * session state (DiscoverySummary, DetectedStack, VerificationCandidates).
 * They live in the state layer because they are part of SessionState — the
 * innermost layer must not depend on outer layers (discovery, integration, adapters).
 *
 * The discovery layer imports and re-exports these schemas for backward
 * compatibility. The full DiscoveryResult (with all collector outputs) remains
 * in discovery/types.ts — only the session-embedded subset lives here.
 *
 * @version v1
 */

import { z } from 'zod';

// ─── Topology (subset for state) ─────────────────────────────────────────────

/** Topology kind: monorepo, single-project, or unknown. */
export const TopologyKindSchema = z.enum(['monorepo', 'single-project', 'unknown']);
export type TopologyKind = z.infer<typeof TopologyKindSchema>;

// ─── Code Surface Status (subset for state) ──────────────────────────────────

/** Code-surface collector status. */
export const CodeSurfaceStatusSchema = z.enum(['ok', 'partial', 'failed']);
export type CodeSurfaceStatus = z.infer<typeof CodeSurfaceStatusSchema>;

// ─── Verification Candidates ─────────────────────────────────────────────────

/** Verification candidate command kind. */
export const VerificationCandidateKindSchema = z.enum([
  'build',
  'test',
  'lint',
  'typecheck',
  'format',
  'security',
  'coverage',
]);
export type VerificationCandidateKind = z.infer<typeof VerificationCandidateKindSchema>;

/** Confidence level for a planned verification candidate. */
export const VerificationCandidateConfidenceSchema = z.enum(['high', 'medium', 'low']);
export type VerificationCandidateConfidence = z.infer<typeof VerificationCandidateConfidenceSchema>;

/**
 * Evidence-backed verification command candidate.
 *
 * Advisory only: this command is a planning suggestion, not an execution result
 * and not an instruction to auto-run it.
 */
export const VerificationCandidateSchema = z.object({
  kind: VerificationCandidateKindSchema,
  command: z.string().min(1),
  source: z.string().min(1),
  confidence: VerificationCandidateConfidenceSchema,
  reason: z.string().min(1),
});
export type VerificationCandidate = z.infer<typeof VerificationCandidateSchema>;

/** Deterministic ordered list of advisory verification candidates. */
export const VerificationCandidatesSchema = z.array(VerificationCandidateSchema);
export type VerificationCandidates = z.infer<typeof VerificationCandidatesSchema>;

// ─── Detected Stack ──────────────────────────────────────────────────────────

/**
 * Detected stack category.
 *
 * Determines sort order in the summary string:
 * language → framework → runtime → buildTool → tool → testFramework → qualityTool → database (deterministic).
 */
export const DetectedStackTargetSchema = z.enum([
  'language',
  'framework',
  'runtime',
  'buildTool',
  'tool',
  'testFramework',
  'qualityTool',
  'database',
]);
export type DetectedStackTarget = z.infer<typeof DetectedStackTargetSchema>;

/**
 * A single version-bearing item extracted from DiscoveryResult.stack.
 *
 * Derived evidence — NOT SSOT. The authoritative version data lives in
 * the DiscoveryResult returned by the discovery orchestrator. This is a
 * compact projection for quick consumption by LLM instructions via
 * flowguard_status.
 */
export const DetectedStackVersionSchema = z.object({
  /** Stack item identifier (e.g., "java", "spring-boot", "node"). */
  id: z.string().min(1),
  /** Detected version string (e.g., "21", "3.4.1", "20.11.0"). */
  version: z.string().min(1),
  /** Category of this item. */
  target: DetectedStackTargetSchema,
  /** Optional provenance string (e.g., "pom.xml:<java.version>"). */
  evidence: z.string().optional(),
});
export type DetectedStackVersion = z.infer<typeof DetectedStackVersionSchema>;

/**
 * A single detected stack item — version optional.
 *
 * Surfaces ALL items recognized by stack detection, regardless of whether
 * a version could be extracted. Versioned items carry `version`; unversioned
 * items (e.g., vitest, maven, eslint) appear with `version` omitted.
 *
 * Derived evidence — NOT SSOT.
 */
export const DetectedStackItemSchema = z.object({
  /** Category of this item (determines sort order). */
  kind: DetectedStackTargetSchema,
  /** Stack item identifier (e.g., "java", "vitest", "maven"). */
  id: z.string().min(1),
  /** Detected version string, if available. */
  version: z.string().min(1).optional(),
  /** Single provenance string (e.g., "pom.xml:<java.version>"). */
  evidence: z.string().optional(),
});
export type DetectedStackItem = z.infer<typeof DetectedStackItemSchema>;

/**
 * A compiler/runtime target entry (e.g., ES2022 from tsconfig).
 *
 * Derived evidence — NOT SSOT.
 */
export const DetectedStackTargetEntrySchema = z.object({
  /** Always 'compilerTarget' for now; extensible for future target kinds. */
  kind: z.literal('compilerTarget'),
  /** Identifier (e.g., "typescript", "java"). */
  id: z.string().min(1),
  /** Target value (e.g., "ES2022", "21"). */
  value: z.string().min(1),
  /** Optional provenance string. */
  evidence: z.string().optional(),
});
export type DetectedStackTargetEntry = z.infer<typeof DetectedStackTargetEntrySchema>;

/**
 * Compact detected stack evidence embedded in SessionState.
 *
 * Derived evidence — NOT SSOT. The authoritative stack data lives in
 * DiscoveryResult.stack. This structure provides a compact, deterministic
 * projection of detected stack items for surfacing in flowguard_status.
 *
 * `summary` is a pre-formatted string: "java=21, spring-boot=3.4.1, maven, vitest"
 * sorted by category (language → framework → runtime → buildTool → tool →
 * testFramework → qualityTool → database), then by id. Versioned: `id=version`, unversioned: `id`.
 *
 * `items` contains ALL detected items (version optional).
 * `versions` contains only versioned items (backward compatible).
 * `targets` contains compiler/runtime targets when detected.
 */
export const DetectedStackSchema = z.object({
  /** Pre-formatted summary string for quick injection into status. */
  summary: z.string(),
  /** ALL detected items — version optional. */
  items: z.array(DetectedStackItemSchema),
  /** Versioned items only (backward compatible). */
  versions: z.array(DetectedStackVersionSchema),
  /** Compiler/runtime targets (e.g., ES2022 from tsconfig). */
  targets: z.array(DetectedStackTargetEntrySchema).optional(),
  /** Module-scoped stack items for monorepos (optional). */
  scopes: z
    .array(
      z.object({
        /** Relative path to the module root (e.g., "apps/web"). */
        path: z.string().min(1),
        /** Pre-formatted summary string for this scope. */
        summary: z.string().optional(),
        /** All detected items in this scope. */
        items: z.array(DetectedStackItemSchema),
        /** Versioned items in this scope. */
        versions: z.array(DetectedStackVersionSchema).default([]),
      }),
    )
    .optional(),
});
export type DetectedStack = z.infer<typeof DetectedStackSchema>;

// ─── Discovery Summary ───────────────────────────────────────────────────────

/**
 * Lightweight discovery summary embedded in SessionState.
 *
 * NOT the full DiscoveryResult — just the most useful fields for
 * quick consumption by Plan/Review/Implement phases without loading
 * the full discovery blob.
 */
export const DiscoverySummarySchema = z.object({
  primaryLanguages: z.array(z.string()),
  frameworks: z.array(z.string()),
  topologyKind: TopologyKindSchema,
  moduleCount: z.number().int().nonnegative(),
  hasApiSurface: z.boolean(),
  hasPersistenceSurface: z.boolean(),
  hasCiCd: z.boolean(),
  hasSecuritySurface: z.boolean(),
  codeSurfaceStatus: CodeSurfaceStatusSchema.optional(),
  apiEndpointCount: z.number().int().nonnegative().optional(),
  hasAuthBoundary: z.boolean().optional(),
});
export type DiscoverySummary = z.infer<typeof DiscoverySummarySchema>;

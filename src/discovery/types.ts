/**
 * @module discovery/types
 * @description Zod schemas and TypeScript types for the Discovery system.
 *
 * Single source of truth for all discovery-related data structures:
 * - DiscoveryResult: comprehensive repository analysis output
 * - Collector types: repo-metadata, stack, topology, surfaces, domain-signals
 * - Evidence classification: fact / derived_signal / hypothesis
 * - CollectorStatus: per-collector health tracking
 * - ProfileResolution: profile detection result with rejected candidates
 * - DiscoverySummary: lightweight digest for session state
 *
 * P2d: Session-embedded schemas (DiscoverySummary, DetectedStack, VerificationCandidates
 * and their transitive dependencies) are canonically defined in state/discovery-schemas.ts
 * to preserve the architecture boundary: state/ must not import from discovery/.
 * Re-exported here for backward compatibility.
 *
 * @version v2
 */

import { z } from 'zod';

// P2d: Session-embedded schemas re-imported from canonical state layer definitions.
// This preserves backward compatibility: all existing imports from discovery/types
// continue to work, while state/schema.ts imports from state/discovery-schemas.ts.
import {
  TopologyKindSchema,
  type TopologyKind,
  CodeSurfaceStatusSchema,
  type CodeSurfaceStatus,
  VerificationCandidateKindSchema,
  type VerificationCandidateKind,
  VerificationCandidateConfidenceSchema,
  type VerificationCandidateConfidence,
  VerificationCandidateSchema,
  type VerificationCandidate,
  VerificationCandidatesSchema,
  type VerificationCandidates,
  DetectedStackTargetSchema,
  type DetectedStackTarget,
  DetectedStackVersionSchema,
  type DetectedStackVersion,
  DetectedStackItemSchema,
  type DetectedStackItem,
  DetectedStackTargetEntrySchema,
  type DetectedStackTargetEntry,
  DetectedStackSchema,
  type DetectedStack,
  DiscoverySummarySchema,
  type DiscoverySummary,
} from '../state/discovery-schemas.js';

// Re-export for backward compatibility
export {
  TopologyKindSchema,
  type TopologyKind,
  CodeSurfaceStatusSchema,
  type CodeSurfaceStatus,
  VerificationCandidateKindSchema,
  type VerificationCandidateKind,
  VerificationCandidateConfidenceSchema,
  type VerificationCandidateConfidence,
  VerificationCandidateSchema,
  type VerificationCandidate,
  VerificationCandidatesSchema,
  type VerificationCandidates,
  DetectedStackTargetSchema,
  type DetectedStackTarget,
  DetectedStackVersionSchema,
  type DetectedStackVersion,
  DetectedStackItemSchema,
  type DetectedStackItem,
  DetectedStackTargetEntrySchema,
  type DetectedStackTargetEntry,
  DetectedStackSchema,
  type DetectedStack,
  DiscoverySummarySchema,
  type DiscoverySummary,
};

// ─── Constants ────────────────────────────────────────────────────────────────

export const DISCOVERY_SCHEMA_VERSION = 'discovery.v1' as const;
export const PROFILE_RESOLUTION_SCHEMA_VERSION = 'profile-resolution.v1' as const;

// ─── Evidence Classification ──────────────────────────────────────────────────

/**
 * Evidence classification for detected items.
 *
 * - fact: directly observed in the repository (file exists, config present)
 * - derived_signal: inferred from a combination of facts (framework detected from dependencies)
 * - hypothesis: low-confidence guess based on heuristics
 */
export const EvidenceClassSchema = z.enum(['fact', 'derived_signal', 'hypothesis']);
export type EvidenceClass = z.infer<typeof EvidenceClassSchema>;

// ─── Collector Status ─────────────────────────────────────────────────────────

/**
 * Per-collector execution status.
 *
 * - complete: all detection logic ran successfully
 * - partial: some detection logic succeeded, some failed (degraded)
 * - failed: collector could not produce any result
 */
export const CollectorStatusSchema = z.enum(['complete', 'partial', 'failed']);
export type CollectorStatus = z.infer<typeof CollectorStatusSchema>;

// ─── Detected Item ────────────────────────────────────────────────────────────

/**
 * A single detected item with confidence scoring and evidence classification.
 *
 * Used by stack detection, surface detection, and validation hints
 * to report what was found and how confident the detection is.
 */
export const DetectedItemSchema = z.object({
  /** Identifier for the detected item (e.g., "typescript", "vitest", "express"). */
  id: z.string().min(1),
  /** Confidence score: 0.0 (no confidence) to 1.0 (certain). */
  confidence: z.number().min(0).max(1),
  /** Evidence classification for this detection. */
  classification: EvidenceClassSchema,
  /** Concrete evidence supporting this detection (file paths, config keys, etc.). */
  evidence: z.array(z.string()),
  /** Detected version string (e.g., "21", "3.4.1"). Absent if not extractable. */
  version: z.string().optional(),
  /** Provenance of the version detection (e.g., "pom.xml:<java.version>"). */
  versionEvidence: z.string().optional(),
  /** Compiler target (e.g., "ES2022" from tsconfig.json). Not a tool/language version. */
  compilerTarget: z.string().optional(),
  /** Provenance of the compiler target detection. */
  compilerTargetEvidence: z.string().optional(),
});
export type DetectedItem = z.infer<typeof DetectedItemSchema>;

// ─── Repo Metadata ────────────────────────────────────────────────────────────

/** Repository metadata collected from git. */
export const RepoMetadataSchema = z.object({
  defaultBranch: z.string().nullable(),
  headCommit: z.string().nullable(),
  isDirty: z.boolean(),
  worktreePath: z.string().min(1),
  canonicalRemote: z.string().nullable(),
  fingerprint: z.string().regex(/^[0-9a-f]{24}$/),
});
export type RepoMetadata = z.infer<typeof RepoMetadataSchema>;

// ─── Stack Detection ──────────────────────────────────────────────────────────

/** Stack detection result: languages, frameworks, build tools, test frameworks, runtimes, tools, quality tools, databases. */
export const StackInfoSchema = z.object({
  languages: z.array(DetectedItemSchema),
  frameworks: z.array(DetectedItemSchema),
  buildTools: z.array(DetectedItemSchema),
  testFrameworks: z.array(DetectedItemSchema),
  runtimes: z.array(DetectedItemSchema),
  /** Detected ecosystem tools (e.g., openapi-generator, flyway, liquibase). Default [] for backward compat. */
  tools: z.array(DetectedItemSchema).default([]),
  /** Detected quality/analysis tools (e.g., spotless, checkstyle, jacoco). Default [] for backward compat. */
  qualityTools: z.array(DetectedItemSchema).default([]),
  /** Detected database engines (e.g., postgresql, mysql, mongodb). Default [] for backward compat. */
  databases: z.array(DetectedItemSchema).default([]),
});
export type StackInfo = z.infer<typeof StackInfoSchema>;

// ─── Topology ─────────────────────────────────────────────────────────────────
// TopologyKindSchema + TopologyKind: re-exported from state/discovery-schemas.ts

/** Information about a module/package within the repository. */
export const ModuleInfoSchema = z.object({
  /** Relative path from worktree root. */
  path: z.string().min(1),
  /** Module name (from package.json name, pom.xml artifactId, etc.). */
  name: z.string(),
  /** Package manager manifest file that defines this module. */
  manifestFile: z.string(),
});
export type ModuleInfo = z.infer<typeof ModuleInfoSchema>;

/** Entry point detected in the repository. */
export const EntryPointInfoSchema = z.object({
  /** Relative path from worktree root. */
  path: z.string().min(1),
  /** Kind of entry point. */
  kind: z.enum(['main', 'bin', 'script', 'handler', 'other']),
});
export type EntryPointInfo = z.infer<typeof EntryPointInfoSchema>;

/** Topology analysis result. */
export const TopologyInfoSchema = z.object({
  kind: TopologyKindSchema,
  modules: z.array(ModuleInfoSchema),
  entryPoints: z.array(EntryPointInfoSchema),
  /** Root-level config files (relative paths). */
  rootConfigs: z.array(z.string()),
  /** Paths to ignore during analysis (node_modules, dist, etc.). */
  ignorePaths: z.array(z.string()),
});
export type TopologyInfo = z.infer<typeof TopologyInfoSchema>;

// ─── Surface Detection ────────────────────────────────────────────────────────

/** Information about a detected API, persistence, CI/CD, or security surface. */
export const SurfaceInfoSchema = z.object({
  /** Identifier for the surface (e.g., "express-routes", "prisma-schema"). */
  id: z.string().min(1),
  /** Human-readable label. */
  label: z.string(),
  /** Evidence classification. */
  classification: EvidenceClassSchema,
  /** Files or paths that constitute this surface. */
  evidence: z.array(z.string()),
});
export type SurfaceInfo = z.infer<typeof SurfaceInfoSchema>;

/** Architectural layer detected in the repository. */
export const LayerInfoSchema = z.object({
  /** Layer name (e.g., "controller", "service", "repository", "model"). */
  name: z.string().min(1),
  /** Path patterns associated with this layer. */
  pathPatterns: z.array(z.string()),
});
export type LayerInfo = z.infer<typeof LayerInfoSchema>;

/** All detected surfaces in the repository. */
export const SurfacesInfoSchema = z.object({
  api: z.array(SurfaceInfoSchema),
  persistence: z.array(SurfaceInfoSchema),
  cicd: z.array(SurfaceInfoSchema),
  security: z.array(SurfaceInfoSchema),
  layers: z.array(LayerInfoSchema),
});
export type SurfacesInfo = z.infer<typeof SurfacesInfoSchema>;

// ─── Code Surface Analysis ────────────────────────────────────────────────────

/** A semantically detected code-surface signal. */
export const CodeSurfaceSignalSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  confidence: z.number().min(0).max(1),
  classification: EvidenceClassSchema,
  evidence: z.array(z.string()),
  location: z.string().min(1),
});
export type CodeSurfaceSignal = z.infer<typeof CodeSurfaceSignalSchema>;

// CodeSurfaceStatusSchema + CodeSurfaceStatus: re-exported from state/discovery-schemas.ts

/** Collector budget stats for code-surface analysis. */
export const CodeSurfaceBudgetSchema = z.object({
  scannedFiles: z.number().int().nonnegative(),
  scannedBytes: z.number().int().nonnegative(),
  maxFiles: z.number().int().positive(),
  maxBytesPerFile: z.number().int().positive(),
  maxTotalBytes: z.number().int().positive(),
  timedOut: z.boolean(),
});
export type CodeSurfaceBudget = z.infer<typeof CodeSurfaceBudgetSchema>;

/** Bounded heuristic code-surface analysis result. */
export const CodeSurfacesInfoSchema = z.object({
  status: CodeSurfaceStatusSchema,
  endpoints: z.array(CodeSurfaceSignalSchema),
  authBoundaries: z.array(CodeSurfaceSignalSchema),
  dataAccess: z.array(CodeSurfaceSignalSchema),
  integrations: z.array(CodeSurfaceSignalSchema),
  budget: CodeSurfaceBudgetSchema,
});
export type CodeSurfacesInfo = z.infer<typeof CodeSurfacesInfoSchema>;

// ─── Domain Signals ───────────────────────────────────────────────────────────

/** A domain keyword detected in the repository. */
export const DomainKeywordSchema = z.object({
  /** The keyword or term. */
  term: z.string().min(1),
  /** Number of occurrences found. */
  occurrences: z.number().int().nonnegative(),
  /** Evidence classification. */
  classification: EvidenceClassSchema,
});
export type DomainKeyword = z.infer<typeof DomainKeywordSchema>;

/** Domain signals collected from the repository. */
export const DomainSignalsSchema = z.object({
  keywords: z.array(DomainKeywordSchema),
  /** Files that might contain domain glossary (README, GLOSSARY, etc.). */
  glossarySources: z.array(z.string()),
});
export type DomainSignals = z.infer<typeof DomainSignalsSchema>;

// ─── Validation Hints ─────────────────────────────────────────────────────────

/** A command hint for validation (build, test, lint, etc.). */
export const CommandHintSchema = z.object({
  /** Command category. */
  kind: z.enum(['build', 'test', 'lint', 'typecheck', 'format', 'other']),
  /** The command string (e.g., "npm test", "mvn verify"). */
  command: z.string().min(1),
  /** Confidence that this is the right command. */
  confidence: z.number().min(0).max(1),
  /** Evidence classification. */
  classification: EvidenceClassSchema,
});
export type CommandHint = z.infer<typeof CommandHintSchema>;

/** Validation hints: detected commands and lint tools. */
export const ValidationHintsSchema = z.object({
  commands: z.array(CommandHintSchema),
  lintTools: z.array(DetectedItemSchema),
});
export type ValidationHints = z.infer<typeof ValidationHintsSchema>;

// ─── Verification Candidates (advisory planner output) ───────────────────────
// VerificationCandidate* schemas: re-exported from state/discovery-schemas.ts

// ─── Discovery Result ─────────────────────────────────────────────────────────

/**
 * Complete discovery result — output of the discovery orchestrator.
 *
 * Contains comprehensive repository analysis from all 6 collectors:
 * 1. repo-metadata: git info (branch, commit, remote, fingerprint)
 * 2. stack-detection: languages, frameworks, build tools, test frameworks, runtimes
 * 3. topology: monorepo vs single-project, modules, entry points
 * 4. surface-detection: API, persistence, CI/CD, security surfaces
 * 5. code-surface-analysis: bounded heuristic endpoint/auth/data/integration signals
 * 6. domain-signals: domain keywords, glossary sources
 *
 * Plus validation hints derived from stack + topology.
 *
 * Persisted to: discovery/discovery.json (workspace-level)
 * Snapshot to: sessions/{id}/discovery-snapshot.json (immutable per-session copy)
 */
export const DiscoveryResultSchema = z.object({
  schemaVersion: z.literal(DISCOVERY_SCHEMA_VERSION),
  collectedAt: z.string().datetime(),
  /** Per-collector execution status. */
  collectors: z.record(z.string(), CollectorStatusSchema),
  repoMetadata: RepoMetadataSchema,
  stack: StackInfoSchema,
  topology: TopologyInfoSchema,
  surfaces: SurfacesInfoSchema,
  codeSurfaces: CodeSurfacesInfoSchema.optional(),
  domainSignals: DomainSignalsSchema,
  validationHints: ValidationHintsSchema,
});
export type DiscoveryResult = z.infer<typeof DiscoveryResultSchema>;

// ─── Profile Resolution ───────────────────────────────────────────────────────

/** A profile candidate (selected or rejected). */
export const ProfileCandidateSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string()),
});
export type ProfileCandidate = z.infer<typeof ProfileCandidateSchema>;

/** A rejected profile candidate with rejection reason. */
export const RejectedCandidateSchema = z.object({
  id: z.string().min(1),
  score: z.number().min(0).max(1),
  reason: z.string(),
});
export type RejectedCandidate = z.infer<typeof RejectedCandidateSchema>;

/**
 * Profile resolution result — output of profile auto-detection.
 *
 * Contains the primary selected profile, secondary candidates,
 * and rejected candidates with reasons and scores.
 *
 * Persisted to: discovery/profile-resolution.json (workspace-level)
 * Snapshot to: sessions/{id}/profile-resolution-snapshot.json (immutable)
 */
export const ProfileResolutionSchema = z.object({
  schemaVersion: z.literal(PROFILE_RESOLUTION_SCHEMA_VERSION),
  resolvedAt: z.string().datetime(),
  /** Primary selected profile. */
  primary: ProfileCandidateSchema,
  /** Other profiles that matched with lower confidence. */
  secondary: z.array(ProfileCandidateSchema),
  /** Profiles that were evaluated but did not match. */
  rejected: z.array(RejectedCandidateSchema),
  /** Active check IDs from the selected profile. */
  activeChecks: z.array(z.string()),
});
export type ProfileResolution = z.infer<typeof ProfileResolutionSchema>;

// ─── Discovery Summary (for Session State) ────────────────────────────────────
// DiscoverySummarySchema + DiscoverySummary: re-exported from state/discovery-schemas.ts

// ─── Detected Stack (compact stack evidence for status) ───────────────────────

// DetectedStack* schemas: re-exported from state/discovery-schemas.ts

// ─── Collector Interface ──────────────────────────────────────────────────────

/**
 * Collector input — shared context passed to all collectors.
 *
 * Provides the minimal set of information each collector needs
 * without coupling them to the full orchestrator or git adapter.
 */
export interface CollectorInput {
  /** Absolute path to the git worktree root. */
  readonly worktreePath: string;
  /** Repository fingerprint (24-hex). */
  readonly fingerprint: string;
  /** All file paths relative to worktree root (from git ls-files). */
  readonly allFiles: readonly string[];
  /** Package/dependency manifest files (basenames). */
  readonly packageFiles: readonly string[];
  /** Configuration files (basenames). */
  readonly configFiles: readonly string[];
  /**
   * Optional file reader for manifest content extraction.
   * Accepts a relative path from worktree root, returns file content or undefined.
   * When absent, collectors skip content-based extraction (e.g., version detection).
   */
  readonly readFile?: (relativePath: string) => Promise<string | undefined>;
}

/**
 * Collector output — each collector returns its named section plus status.
 *
 * Generic over the data shape to allow type-safe collector implementations.
 */
export interface CollectorOutput<T> {
  readonly status: CollectorStatus;
  readonly data: T;
}

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
 *
 * @version v2
 */

import { z } from 'zod';

import { TopologyKindSchema, CodeSurfaceStatusSchema } from '../state/discovery-schemas.js';
import { SignalClass } from '../state/evidence-signal.js';

// ─── Constants ────────────────────────────────────────────────────────────────

export const DISCOVERY_SCHEMA_VERSION = 'discovery.v2' as const;
export const PROFILE_RESOLUTION_SCHEMA_VERSION = 'profile-resolution.v1' as const;

// ─── Evidence Classification ──────────────────────────────────────────────────

/**
 * Evidence classification for detected items.
 *
 * - fact: directly observed in the repository (file exists, config present)
 * - derived_signal: inferred from a combination of facts (framework detected from dependencies)
 * - hypothesis: low-confidence guess based on heuristics
 *
 * Aliased to the canonical, layer-neutral `SignalClass` (state/evidence-signal)
 * so Discovery and ProofGraph share one vocabulary instead of duplicating it.
 */
export const EvidenceClassSchema = SignalClass;
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

// ─── Collector Diagnostics ────────────────────────────────────────────────────

/**
 * Per-collector execution diagnostic — structured record of collector health.
 *
 * Makes collector-local degradation explicit and diagnosable without
 * hiding failures behind silent defaults.
 */
export const CollectorDiagnosticSchema = z
  .object({
    /** Collector name (e.g., "repo-metadata", "stack-detection"). */
    name: z.string().min(1),
    /** Final collector execution status. */
    status: CollectorStatusSchema,
    /** Wall-clock duration in milliseconds. */
    durationMs: z.number().nonnegative(),
    /** Error code when status is 'failed' (timeout message, error name, etc.). */
    errorCode: z.string().optional(),
    /** Whether the collector was terminated by timeout. */
    timedOut: z.boolean(),
    /** Human-readable reason for degraded/partial status. */
    degradedReason: z.string().optional(),
  })
  .strict();
export type CollectorDiagnostic = z.infer<typeof CollectorDiagnosticSchema>;

/** The complete, fixed set of collectors represented in a persisted discovery result. */
const DiscoveryCollectorNameSchema = z.enum([
  'repo-metadata',
  'stack-detection',
  'topology',
  'surface-detection',
  'code-surface-analysis',
  'domain-signals',
]);
type DiscoveryCollectorName = z.infer<typeof DiscoveryCollectorNameSchema>;

const DiscoveryResultDiagnosticSchema = CollectorDiagnosticSchema.extend({
  name: DiscoveryCollectorNameSchema,
}).strict();

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
export const StackInfoSchema = z
  .object({
    languages: z.array(DetectedItemSchema),
    frameworks: z.array(DetectedItemSchema),
    buildTools: z.array(DetectedItemSchema),
    testFrameworks: z.array(DetectedItemSchema),
    runtimes: z.array(DetectedItemSchema),
    /** Detected ecosystem tools (e.g., openapi-generator, flyway, liquibase). */
    tools: z.array(DetectedItemSchema),
    /** Detected quality/analysis tools (e.g., spotless, checkstyle, jacoco). */
    qualityTools: z.array(DetectedItemSchema),
    /** Detected database engines (e.g., postgresql, mysql, mongodb). */
    databases: z.array(DetectedItemSchema),
  })
  .strict();
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

// ─── Read Outcome (structured file read/parse status) ─────────────────────────

/**
 * Structured outcome of a file read/parse operation.
 *
 * Used by collectors to record per-file read results instead of silently
 * swallowing errors. Makes degradation diagnosable.
 */
export const ReadOutcomeSchema = z.enum([
  'read_ok',
  'not_found',
  'denied',
  'parse_failed',
  'too_large',
]);
export type ReadOutcome = z.infer<typeof ReadOutcomeSchema>;

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

export const SemanticExtractionStatusSchema = z.enum(['applied', 'heuristic_only', 'partial']);
export type SemanticExtractionStatus = z.infer<typeof SemanticExtractionStatusSchema>;

/** Runtime diagnostics for optional semantic code-surface extraction. */
export const SemanticExtractionInfoSchema = z.object({
  status: SemanticExtractionStatusSchema,
  appliedExtractors: z.array(z.string()),
  unsupportedReason: z.string().nullable(),
  diagnostics: z.array(z.string()),
});
export type SemanticExtractionInfo = z.infer<typeof SemanticExtractionInfoSchema>;

// CodeSurfaceStatusSchema + CodeSurfaceStatus: re-exported from state/discovery-schemas.ts

/** Collector budget stats for code-surface analysis. */
export const CodeSurfaceBudgetSchema = z
  .object({
    scannedFiles: z.number().int().nonnegative(),
    scannedBytes: z.number().int().nonnegative(),
    maxFiles: z.number().int().positive(),
    maxBytesPerFile: z.number().int().positive(),
    maxTotalBytes: z.number().int().positive(),
    timedOut: z.boolean(),
    /** Total source-file candidates before budget slice. */
    totalSourceCandidates: z.number().int().nonnegative().optional(),
    /** Whether budget exhaustion truncated the scan (true = partial due to budget). */
    budgetExhausted: z.boolean().optional(),
  })
  .strict();
export type CodeSurfaceBudget = z.infer<typeof CodeSurfaceBudgetSchema>;

/** Bounded heuristic code-surface analysis result. */
export const CodeSurfacesInfoSchema = z
  .object({
    status: CodeSurfaceStatusSchema,
    endpoints: z.array(CodeSurfaceSignalSchema),
    authBoundaries: z.array(CodeSurfaceSignalSchema),
    dataAccess: z.array(CodeSurfaceSignalSchema),
    integrations: z.array(CodeSurfaceSignalSchema),
    /** Advisory semantic test targets when framework/test patterns are detected. */
    testTargets: z.array(CodeSurfaceSignalSchema).optional(),
    budget: CodeSurfaceBudgetSchema,
    /** Optional semantic extraction diagnostics; advisory, bounded, and non-authoritative. */
    semanticExtraction: SemanticExtractionInfoSchema.optional(),
    /** Per-file read outcome diagnostics (populated when reads degrade). */
    readStatuses: z.record(z.string(), ReadOutcomeSchema).optional(),
  })
  .strict();
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
 * Persisted to: discovery/discovery.json (workspace-level)
 * Snapshot to: sessions/{id}/discovery-snapshot.json (immutable per-session copy)
 */
export const DiscoveryResultSchema = z
  .object({
    schemaVersion: z.literal(DISCOVERY_SCHEMA_VERSION),
    collectedAt: z.string().datetime(),
    /** Per-collector structured diagnostics: timing, status, error info. */
    diagnostics: z.array(DiscoveryResultDiagnosticSchema),
    repoMetadata: RepoMetadataSchema,
    stack: StackInfoSchema,
    topology: TopologyInfoSchema,
    surfaces: SurfacesInfoSchema,
    codeSurfaces: CodeSurfacesInfoSchema,
    domainSignals: DomainSignalsSchema,
  })
  .superRefine((result, ctx) => {
    const counts = new Map<DiscoveryCollectorName, number>();
    for (const diagnostic of result.diagnostics) {
      counts.set(diagnostic.name, (counts.get(diagnostic.name) ?? 0) + 1);
    }
    for (const name of DiscoveryCollectorNameSchema.options) {
      const count = counts.get(name) ?? 0;
      if (count === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['diagnostics'],
          message: `Missing diagnostic for collector '${name}'`,
        });
      } else if (count > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['diagnostics'],
          message: `Duplicate diagnostic for collector '${name}'`,
        });
      }
    }

    const codeSurfaceDiagnosticIndex = result.diagnostics.findIndex(
      (diagnostic) => diagnostic.name === 'code-surface-analysis',
    );
    if (codeSurfaceDiagnosticIndex >= 0) {
      const codeSurfaceDiagnostic = result.diagnostics[codeSurfaceDiagnosticIndex]!;
      const expectedStatus =
        result.codeSurfaces.status === 'ok' ? 'complete' : result.codeSurfaces.status;
      if (codeSurfaceDiagnostic.status !== expectedStatus) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['diagnostics', codeSurfaceDiagnosticIndex, 'status'],
          message: `code-surface-analysis diagnostic status must be '${expectedStatus}' when codeSurfaces.status is '${result.codeSurfaces.status}'`,
        });
      }
    }
  })
  .strict();
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
  /** Package/dependency manifest files (full relative paths from worktree root). */
  readonly packageFilePaths?: readonly string[];
  /** Configuration files (full relative paths from worktree root). */
  readonly configFilePaths?: readonly string[];
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

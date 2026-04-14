/**
 * @module config/profile
 * @description Governance profile — tech-stack-aware validation configuration.
 *
 * Profiles configure which validation checks run, how they run, and
 * optionally detect the right profile for a repository automatically.
 *
 * Extension point:
 * - Register custom profiles for specific tech stacks (Java, .NET, Python, etc.)
 * - Each profile defines its own CheckExecutors with real validation logic
 * - Profiles can auto-detect based on repository signals (file patterns, config)
 * - LLM instructions can be specialized per profile
 *
 * The baseline profile provides two universal checks:
 * - test_quality: Verify test coverage and quality for changed code
 * - rollback_safety: Verify the implementation can be safely rolled back
 *
 * Both baseline executors are placeholder stubs that always pass.
 * Real implementations come from tech-stack-specific profiles.
 *
 * Dependency: imports types from state/evidence (ValidationResult) and state/schema (SessionState).
 *
 * @version v1
 */

import type { SessionState } from "../state/schema";
import { profileRuleContent as javaRuleContent } from "./profiles/content/java";
import { profileRuleContent as angularRuleContent } from "./profiles/content/angular";
import { profileRuleContent as typescriptRuleContent } from "./profiles/content/typescript";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Signals from the repository for automatic profile detection.
 *
 * Profiles use these signals to determine if they match the repo:
 * - files: all file paths in the repo (relative to root)
 * - packageFiles: package manager files (package.json, pom.xml, build.gradle, etc.)
 * - configFiles: config files (.eslintrc, tsconfig.json, Dockerfile, etc.)
 */
export interface RepoSignals {
  readonly files: readonly string[];
  readonly packageFiles: readonly string[];
  readonly configFiles: readonly string[];
}

/**
 * A validation check executor.
 *
 * Runs a single validation check and returns a result.
 * The result type matches the ValidationResult evidence schema.
 *
 * Executors are async to support:
 * - File system analysis (test file scanning)
 * - Git history analysis (rollback safety)
 * - External tool integration (linters, SAST)
 */
export interface CheckExecutor {
  /** Check identifier. Must match the activeChecks entry. */
  readonly id: string;
  /** Human-readable description of what this check verifies. */
  readonly description: string;
  /**
   * Execute the check against the current session state.
   * Returns { checkId, passed, detail, executedAt }.
   */
  readonly execute: (state: SessionState) => Promise<{
    checkId: string;
    passed: boolean;
    detail: string;
    executedAt: string;
  }>;
}

/**
 * A governance profile — tech-stack-aware validation configuration.
 *
 * Profiles determine:
 * - Which checks are active for a session
 * - How each check is executed
 * - Whether the profile matches a given repository
 * - Additional LLM instructions for the tech stack
 */
export interface GovernanceProfile {
  /** Unique profile identifier (e.g., "baseline", "backend-java", "frontend-react"). */
  readonly id: string;
  /** Human-readable profile name. */
  readonly name: string;
  /** Check IDs that are active in this profile. */
  readonly activeChecks: readonly string[];
  /** Check executors, keyed by check ID. */
  readonly checks: ReadonlyMap<string, CheckExecutor>;
  /**
   * Auto-detection function.
   * Returns a confidence score (0-1) for how well this profile matches the repo.
   * 0 = no match, 1 = perfect match.
   * If omitted, the profile can only be selected explicitly.
   */
  readonly detect?: (signals: RepoSignals) => number;
  /**
   * Additional LLM instructions injected when this profile is active.
   * Appended to the base governance instructions.
   */
  readonly instructions?: string;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

/**
 * Profile registry.
 *
 * Central catalog of all available governance profiles.
 * Supports registration, lookup, and auto-detection.
 */
export class ProfileRegistry {
  private readonly profiles = new Map<string, GovernanceProfile>();

  /** Register a profile. Overwrites existing entries with the same ID. */
  register(profile: GovernanceProfile): void {
    this.profiles.set(profile.id, profile);
  }

  /** Look up a profile by ID. Returns undefined if not registered. */
  get(id: string): GovernanceProfile | undefined {
    return this.profiles.get(id);
  }

  /**
   * Auto-detect the best matching profile for a repository.
   *
   * Evaluates all profiles with a `detect` function and returns
   * the one with the highest confidence score (> 0).
   * Returns undefined if no profile matches.
   */
  detect(signals: RepoSignals): GovernanceProfile | undefined {
    let best: GovernanceProfile | undefined;
    let bestScore = 0;

    for (const profile of this.profiles.values()) {
      if (profile.detect) {
        const score = profile.detect(signals);
        if (score > bestScore) {
          bestScore = score;
          best = profile;
        }
      }
    }

    return bestScore > 0 ? best : undefined;
  }

  /** All registered profile IDs. */
  ids(): string[] {
    return Array.from(this.profiles.keys());
  }

  /** Number of registered profiles. */
  get size(): number {
    return this.profiles.size;
  }
}

// ─── Baseline Checks (shared across all built-in profiles) ───────────────────

/**
 * Baseline check: test_quality.
 *
 * Placeholder executor — always passes with a guidance message.
 * Real implementations override this with actual test analysis:
 * - Test coverage for changed files
 * - Test naming conventions
 * - Missing test cases for edge cases
 */
const baselineTestQuality: CheckExecutor = {
  id: "test_quality",
  description: "Verify test coverage and quality for changed code",
  execute: async (_state) => ({
    checkId: "test_quality",
    passed: true,
    detail:
      "Baseline test quality check (stub). " +
      "Override with a profile-specific executor for real test analysis.",
    executedAt: new Date().toISOString(),
  }),
};

/**
 * Baseline check: rollback_safety.
 *
 * Placeholder executor — always passes with a guidance message.
 * Real implementations override this with actual rollback analysis:
 * - Database migration reversibility
 * - API backward compatibility
 * - Feature flag coverage
 */
const baselineRollbackSafety: CheckExecutor = {
  id: "rollback_safety",
  description: "Verify rollback safety for the implementation",
  execute: async (_state) => ({
    checkId: "rollback_safety",
    passed: true,
    detail:
      "Baseline rollback safety check (stub). " +
      "Override with a profile-specific executor for real rollback analysis.",
    executedAt: new Date().toISOString(),
  }),
};

/**
 * Shared baseline active check IDs.
 * All built-in profiles use these two checks by default.
 * Tech-specific profiles may extend this list with additional checks.
 */
const BASELINE_ACTIVE_CHECKS: readonly string[] = ["test_quality", "rollback_safety"];

/**
 * Shared baseline check executor map.
 * ReadonlyMap — safe to share across profiles (no mutation possible).
 */
const BASELINE_CHECKS: ReadonlyMap<string, CheckExecutor> = new Map<string, CheckExecutor>([
  ["test_quality", baselineTestQuality],
  ["rollback_safety", baselineRollbackSafety],
]);

// ─── Baseline Profile ─────────────────────────────────────────────────────────

/**
 * The baseline governance profile.
 *
 * Universal profile that works for any tech stack.
 * Provides two placeholder checks that always pass.
 * Intended as a starting point — real profiles extend or replace this.
 *
 * Auto-detection: always returns 0.1 (lowest priority).
 * Any tech-specific profile will score higher and take precedence.
 */
export const baselineProfile: GovernanceProfile = {
  id: "baseline",
  name: "Baseline Governance",
  activeChecks: BASELINE_ACTIVE_CHECKS,
  checks: BASELINE_CHECKS,
  detect: (_signals) => 0.1,
};

// ─── Java Profile ─────────────────────────────────────────────────────────────

/**
 * Java (Spring Boot) governance profile.
 *
 * Detection signals (confidence = 0.8):
 * - pom.xml in packageFiles → Maven-based Java project
 * - build.gradle / build.gradle.kts in packageFiles → Gradle-based Java project
 *
 * Provides the same two baseline checks (stubs) — real implementations
 * can be registered separately. The value is in the instructions (profile rules)
 * that guide the LLM on Java-specific conventions.
 */
export const javaProfile: GovernanceProfile = {
  id: "backend-java",
  name: "Java / Spring Boot",
  activeChecks: BASELINE_ACTIVE_CHECKS,
  checks: BASELINE_CHECKS,
  detect: (signals: RepoSignals): number => {
    const hasJavaBuild = signals.packageFiles.some(
      (f) =>
        f === "pom.xml" ||
        f === "build.gradle" ||
        f === "build.gradle.kts",
    );
    return hasJavaBuild ? 0.8 : 0;
  },
  instructions: javaRuleContent,
};

// ─── Angular Profile ──────────────────────────────────────────────────────────

/**
 * Angular (+ Nx) governance profile.
 *
 * Detection signals (confidence = 0.85):
 * - angular.json in configFiles → Angular CLI project
 * - nx.json in configFiles → Nx workspace (often Angular)
 *
 * Scores slightly higher than TypeScript (0.85 > 0.7) because Angular
 * projects always have TypeScript but not vice versa.
 */
export const angularProfile: GovernanceProfile = {
  id: "frontend-angular",
  name: "Angular / Nx",
  activeChecks: BASELINE_ACTIVE_CHECKS,
  checks: BASELINE_CHECKS,
  detect: (signals: RepoSignals): number => {
    const hasAngular = signals.configFiles.some(
      (f) => f === "angular.json" || f === "nx.json",
    );
    return hasAngular ? 0.85 : 0;
  },
  instructions: angularRuleContent,
};

// ─── TypeScript Profile ───────────────────────────────────────────────────────

/**
 * TypeScript (Node.js / general) governance profile.
 *
 * Detection signals (confidence = 0.7):
 * - tsconfig.json in configFiles → TypeScript project
 *
 * Lower confidence than Angular (0.7 < 0.85) so that Angular projects
 * with tsconfig.json get the Angular profile, not this one.
 * Higher than baseline (0.7 > 0.1) so any TS repo gets TS rules.
 */
export const typescriptProfile: GovernanceProfile = {
  id: "typescript",
  name: "TypeScript / Node.js",
  activeChecks: BASELINE_ACTIVE_CHECKS,
  checks: BASELINE_CHECKS,
  detect: (signals: RepoSignals): number => {
    const hasTs = signals.configFiles.some(
      (f) => f === "tsconfig.json",
    );
    return hasTs ? 0.7 : 0;
  },
  instructions: typescriptRuleContent,
};

// ─── Default Registry ─────────────────────────────────────────────────────────

/**
 * The default profile registry, pre-seeded with all built-in profiles.
 *
 * Registration order does not matter — detection uses highest confidence score.
 * Confidence hierarchy: Angular (0.85) > Java (0.8) > TypeScript (0.7) > Baseline (0.1).
 */
export const defaultProfileRegistry = new ProfileRegistry();
defaultProfileRegistry.register(baselineProfile);
defaultProfileRegistry.register(javaProfile);
defaultProfileRegistry.register(angularProfile);
defaultProfileRegistry.register(typescriptProfile);

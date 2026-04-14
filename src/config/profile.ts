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
 * Both baseline executors analyze session state evidence (plan body,
 * implementation changedFiles) for quality and safety signals.
 * Tech-stack-specific profiles may override these with deeper analysis.
 *
 * Dependency: imports types from state/evidence (ValidationResult) and state/schema (SessionState).
 *
 * @version v1
 */

import type { SessionState } from "../state/schema";
import type { Phase } from "../state/schema";
import { profileRuleContent as javaRuleContent } from "./profiles/content/java";
import { profileRuleContent as angularRuleContent } from "./profiles/content/angular";
import { profileRuleContent as typescriptRuleContent } from "./profiles/content/typescript";
import { profileRuleContent as baselineRuleContent } from "./profiles/content/baseline";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Phase-aware profile instructions.
 *
 * Static declarative object — configuration, not behavior.
 * - `base`: Always-injected instructions (present in every phase).
 * - `byPhase`: Optional phase-specific overrides/additions.
 *   When present, the phase-specific text is appended to the base.
 *
 * Profiles that don't need phase differentiation simply provide a plain string
 * for `instructions` (backward compatible).
 */
export interface PhaseInstructions {
  /** Base instructions — always injected regardless of phase. */
  readonly base: string;
  /**
   * Phase-specific additional instructions.
   * Keyed by Phase value (e.g., "PLAN", "IMPLEMENTATION").
   * Text is appended to `base` when the session is in that phase.
   */
  readonly byPhase?: Partial<Record<Phase, string>>;
}

/**
 * Resolve effective instructions for a given phase.
 *
 * - Plain string → returned as-is (backward compatible).
 * - PhaseInstructions → base + byPhase[phase] if present.
 * - Undefined → empty string.
 *
 * Pure function, no side effects.
 */
export function resolveProfileInstructions(
  instructions: string | PhaseInstructions | undefined,
  phase: Phase,
): string {
  if (instructions === undefined) return "";
  if (typeof instructions === "string") return instructions;
  const phaseExtra = instructions.byPhase?.[phase];
  if (!phaseExtra) return instructions.base;
  return instructions.base + "\n\n" + phaseExtra;
}

/**
 * Extract the base instructions string from a profile's instructions field.
 *
 * - Plain string → returned as-is.
 * - PhaseInstructions → returns `base`.
 * - Undefined → empty string.
 */
export function extractBaseInstructions(
  instructions: string | PhaseInstructions | undefined,
): string {
  if (instructions === undefined) return "";
  if (typeof instructions === "string") return instructions;
  return instructions.base;
}

/**
 * Extract the byPhase map from a profile's instructions field.
 *
 * - Plain string → undefined (no phase-specific content).
 * - PhaseInstructions → returns `byPhase` (may be undefined).
 * - Undefined → undefined.
 */
export function extractByPhaseInstructions(
  instructions: string | PhaseInstructions | undefined,
): Partial<Record<Phase, string>> | undefined {
  if (instructions === undefined) return undefined;
  if (typeof instructions === "string") return undefined;
  return instructions.byPhase;
}

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
   *
   * Accepts either:
   * - A plain string (backward compatible — same instructions for all phases).
   * - A PhaseInstructions object with `base` + optional `byPhase` overrides.
   *
   * Use `resolveProfileInstructions(profile.instructions, phase)` to resolve
   * the effective instructions for a given phase.
   */
  readonly instructions?: string | PhaseInstructions;
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
 * Test-quality signal patterns.
 * Used by the test_quality executor to scan plan and implementation evidence.
 * Lowercase for case-insensitive matching.
 */
const TEST_QUALITY_SIGNALS = [
  "test", "testing", "test plan", "test coverage", "unit test",
  "integration test", "test case", "assertion", "spec",
] as const;

/**
 * Rollback-safety signal patterns.
 * Used by the rollback_safety executor to scan plan evidence.
 */
const ROLLBACK_SIGNALS = [
  "rollback", "backward compat", "backwards compat",
  "feature flag", "revert", "undo", "reversible",
] as const;

/**
 * High-risk signal patterns.
 * When these appear in the plan but no rollback signals are found,
 * rollback_safety fails.
 */
const HIGH_RISK_SIGNALS = [
  "database", "schema", "migration", "auth", "security",
  "payment", "messaging", "async", "queue",
] as const;

/**
 * Check if text contains any of the given signal patterns (case-insensitive).
 */
function containsSignal(text: string, signals: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return signals.some(s => lower.includes(s));
}

/**
 * Baseline check: test_quality.
 *
 * Analyzes session state evidence for test quality signals:
 * - Plan body must address testing (mentions test-related keywords).
 * - If implementation evidence exists, checks for test file presence
 *   in changedFiles (files containing "test" or "spec" in the path).
 *
 * Fails when the plan has no test-related content — the plan must
 * demonstrate that test quality was considered before implementation.
 */
const baselineTestQuality: CheckExecutor = {
  id: "test_quality",
  description: "Verify test coverage and quality for changed code",
  execute: async (state) => {
    const now = new Date().toISOString();
    const planBody = state.plan?.current?.body ?? "";

    // Check 1: Plan addresses testing
    if (!containsSignal(planBody, [...TEST_QUALITY_SIGNALS])) {
      return {
        checkId: "test_quality",
        passed: false,
        detail:
          "Plan does not address test quality. " +
          "The plan body should describe the test strategy, expected test types, " +
          "or specific test cases for the changed behavior.",
        executedAt: now,
      };
    }

    // Check 2: If implementation exists, verify test files are included
    if (state.implementation) {
      const changedFiles = state.implementation.changedFiles ?? [];
      const hasTestFiles = changedFiles.some(
        f => /test|spec/i.test(f),
      );
      if (changedFiles.length > 0 && !hasTestFiles) {
        return {
          checkId: "test_quality",
          passed: false,
          detail:
            `Implementation has ${changedFiles.length} changed files but none appear to be test files. ` +
            "Changed files should include test files (paths containing 'test' or 'spec').",
          executedAt: now,
        };
      }
    }

    return {
      checkId: "test_quality",
      passed: true,
      detail: "Plan addresses test quality" +
        (state.implementation ? " and implementation includes test files." : "."),
      executedAt: now,
    };
  },
};

/**
 * Baseline check: rollback_safety.
 *
 * Analyzes session state evidence for rollback safety:
 * - If the plan contains high-risk signals (database, auth, migration, etc.),
 *   the plan must also address rollback/revert/backward compatibility.
 * - Low-risk plans (no high-risk signals) pass automatically.
 *
 * Fails when high-risk changes are planned without rollback consideration.
 */
const baselineRollbackSafety: CheckExecutor = {
  id: "rollback_safety",
  description: "Verify rollback safety for the implementation",
  execute: async (state) => {
    const now = new Date().toISOString();
    const planBody = state.plan?.current?.body ?? "";

    const hasHighRisk = containsSignal(planBody, [...HIGH_RISK_SIGNALS]);
    const hasRollback = containsSignal(planBody, [...ROLLBACK_SIGNALS]);

    if (hasHighRisk && !hasRollback) {
      return {
        checkId: "rollback_safety",
        passed: false,
        detail:
          "Plan contains high-risk signals (database, auth, migration, etc.) " +
          "but does not address rollback safety. " +
          "Add a rollback plan, backward compatibility analysis, or feature flag strategy.",
        executedAt: now,
      };
    }

    return {
      checkId: "rollback_safety",
      passed: true,
      detail: hasHighRisk
        ? "Plan addresses rollback safety for high-risk changes."
        : "No high-risk signals detected; rollback safety is acceptable.",
      executedAt: now,
    };
  },
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
 * Provides two state-based validation checks (test_quality, rollback_safety)
 * that analyze plan and implementation evidence for quality signals.
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
  instructions: baselineRuleContent,
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

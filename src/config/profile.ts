/**
 * @module config/profile
 * @description FlowGuard profile — tech-stack-aware check configuration.
 *
 * Profiles declare which validation checks are active (activeChecks) and
 * optionally detect the right profile for a repository automatically.
 *
 * P10a: No heuristic check executors. FlowGuard does not execute validation.
 * The activeChecks list tells the agent WHAT to validate. Agents must run
 * real tooling (CLI commands, manual review, CI verification) and submit
 * actual results. FlowGuard gates the evidence — it does not pretend to
 * execute validation.
 *
 * Extension point:
 * - Register custom profiles for specific tech stacks (Java, .NET, Python, etc.)
 * - Profiles can auto-detect based on repository signals (file patterns, config)
 * - LLM instructions can be specialized per profile
 *
 * The baseline profile provides two universal check IDs:
 * - test_quality: Verify test coverage and quality for changed code
 * - rollback_safety: Verify the implementation can be safely rolled back
 *
 * @version v1
 */

import type { Phase } from '../state/schema.js';
import type { DiscoveryResult } from '../discovery/types.js';
import { profileRuleContent as javaRuleContent } from './profiles/content/java.js';
import { profileRuleContent as angularRuleContent } from './profiles/content/angular.js';
import { profileRuleContent as typescriptRuleContent } from './profiles/content/typescript.js';
import { profileRuleContent as baselineRuleContent } from './profiles/content/baseline.js';

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
  if (instructions === undefined) return '';
  if (typeof instructions === 'string') return instructions;
  const phaseExtra = instructions.byPhase?.[phase];
  if (!phaseExtra) return instructions.base;
  return instructions.base + '\n\n' + phaseExtra;
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
  if (instructions === undefined) return '';
  if (typeof instructions === 'string') return instructions;
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
  if (typeof instructions === 'string') return undefined;
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
 * Input struct for profile auto-detection.
 *
 * Wraps RepoSignals (always available) and optionally DiscoveryResult
 * (available after Phase 5 discovery). Profiles can use either or both.
 *
 * This struct is evolvable: new fields can be added without changing
 * the detect() function signature on FlowGuardProfile or ProfileRegistry.
 */
export interface ProfileDetectionInput {
  readonly repoSignals: RepoSignals;
  readonly discovery?: DiscoveryResult;
}

/**
 * A FlowGuard profile — tech-stack-aware validation configuration.
 *
 * Profiles determine:
 * - Which checks are active for a session (activeChecks)
 * - Whether the profile matches a given repository (detect)
 * - Additional LLM instructions for the tech stack (instructions)
 *
 * P10a: No heuristic executors. The agent must run real tooling.
 */
export interface FlowGuardProfile {
  /** Unique profile identifier (e.g., "baseline", "backend-java", "frontend-react"). */
  readonly id: string;
  /** Human-readable profile name. */
  readonly name: string;
  /** Check IDs that are active in this profile. P10a: no heuristic executors — agent must run real validation. */
  readonly activeChecks: readonly string[];
  /**
   * Auto-detection function.
   * Returns a confidence score (0-1) for how well this profile matches the repo.
   * 0 = no match, 1 = perfect match.
   * If omitted, the profile can only be selected explicitly.
   */
  readonly detect?: (input: ProfileDetectionInput) => number;
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
 * Central catalog of all available FlowGuard profiles.
 * Supports registration, lookup, and auto-detection.
 */
export class ProfileRegistry {
  private readonly profiles = new Map<string, FlowGuardProfile>();

  /** Register a profile. Overwrites existing entries with the same ID. */
  register(profile: FlowGuardProfile): void {
    this.profiles.set(profile.id, profile);
  }

  /** Look up a profile by ID. Returns undefined if not registered. */
  get(id: string): FlowGuardProfile | undefined {
    return this.profiles.get(id);
  }

  /**
   * Auto-detect the best matching profile for a repository.
   *
   * Evaluates all profiles with a `detect` function and returns
   * the one with the highest confidence score (> 0).
   * Returns undefined if no profile matches.
   */
  detect(input: ProfileDetectionInput): FlowGuardProfile | undefined {
    let best: FlowGuardProfile | undefined;
    let bestScore = 0;

    for (const profile of this.profiles.values()) {
      if (profile.detect) {
        const score = profile.detect(input);
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

// ─── Active Checks (shared across all built-in profiles) ────────────────────

/**
 * Shared baseline active check IDs.
 * All built-in profiles use these two checks by default.
 * Tech-specific profiles may extend this list with additional checks.
 *
 * P10a: No heuristic executors. The activeChecks list tells the agent WHAT to
 * validate. The agent must run real tooling (CLI commands, manual review, CI
 * verification) and submit actual ValidationResults. FlowGuard gates the
 * evidence — it does not pretend to execute validation.
 */
const BASELINE_ACTIVE_CHECKS: readonly string[] = ['test_quality', 'rollback_safety'];

// ─── Baseline Profile ─────────────────────────────────────────────────────────

/**
 * The baseline FlowGuard profile.
 *
 * Universal profile that works for any tech stack.
 * Defines active validation checks (test_quality, rollback_safety) the agent
 * must execute with real tooling. P10a: no heuristic executors.
 *
 * Auto-detection: always returns 0.1 (lowest priority).
 * Any tech-specific profile will score higher and take precedence.
 */
export const baselineProfile: FlowGuardProfile = {
  id: 'baseline',
  name: 'Baseline FlowGuard',
  activeChecks: BASELINE_ACTIVE_CHECKS,
  detect: (_input) => 0.1,
  instructions: baselineRuleContent,
};

// ─── Java Profile ─────────────────────────────────────────────────────────────

/**
 * Java (Spring Boot) FlowGuard profile.
 *
 * Detection signals (confidence = 0.8):
 * - pom.xml in packageFiles → Maven-based Java project
 * - build.gradle / build.gradle.kts in packageFiles → Gradle-based Java project
 *
 * Uses the same baseline active checks (test_quality, rollback_safety).
 */
export const javaProfile: FlowGuardProfile = {
  id: 'backend-java',
  name: 'Java / Spring Boot',
  activeChecks: BASELINE_ACTIVE_CHECKS,
  detect: (input: ProfileDetectionInput): number => {
    const hasJavaBuild = input.repoSignals.packageFiles.some(
      (f) => f === 'pom.xml' || f === 'build.gradle' || f === 'build.gradle.kts',
    );
    return hasJavaBuild ? 0.8 : 0;
  },
  instructions: javaRuleContent,
};

// ─── Angular Profile ──────────────────────────────────────────────────────────

/**
 * Angular (+ Nx) FlowGuard profile.
 *
 * Detection signals (confidence = 0.85):
 * - angular.json in configFiles → Angular CLI project
 * - nx.json in configFiles → Nx workspace (often Angular)
 *
 * Scores slightly higher than TypeScript (0.85 > 0.7) because Angular
 * projects always have TypeScript but not vice versa.
 */
export const angularProfile: FlowGuardProfile = {
  id: 'frontend-angular',
  name: 'Angular / Nx',
  activeChecks: BASELINE_ACTIVE_CHECKS,
  detect: (input: ProfileDetectionInput): number => {
    const hasAngular = input.repoSignals.configFiles.some(
      (f) => f === 'angular.json' || f === 'nx.json',
    );
    return hasAngular ? 0.85 : 0;
  },
  instructions: angularRuleContent,
};

// ─── TypeScript Profile ───────────────────────────────────────────────────────

/**
 * TypeScript (Node.js / general) FlowGuard profile.
 *
 * Detection signals (confidence = 0.7):
 * - tsconfig.json in configFiles → TypeScript project
 *
 * Lower confidence than Angular (0.7 < 0.85) so that Angular projects
 * with tsconfig.json get the Angular profile, not this one.
 * Higher than baseline (0.7 > 0.1) so any TS repo gets TS rules.
 */
export const typescriptProfile: FlowGuardProfile = {
  id: 'typescript',
  name: 'TypeScript / Node.js',
  activeChecks: BASELINE_ACTIVE_CHECKS,
  detect: (input: ProfileDetectionInput): number => {
    const hasTs = input.repoSignals.configFiles.some((f) => f === 'tsconfig.json');
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

/**
 * @module config/flowguard-config
 * @description FlowGuard per-worktree configuration schema and defaults.
 *
 * Configuration file: {workspaceDir}/config.json
 *
 * Priority chain (highest → lowest):
 *   Tool arguments > Config file > Policy preset > Built-in defaults
 *
 * Design:
 * - Zod schema with .default() on every nested object — readConfig() always
 *   returns a fully normalized object, even when the file is missing.
 * - schemaVersion is a literal "v1" for forward-compatible parsing.
 * - No YAML, no env-var overrides, no global config in v1.
 *
 * @version v1
 */

import { z } from "zod";

// ─── Schema ──────────────────────────────────────────────────────────────────

export const FlowGuardConfigSchema = z.object({
  /** Schema version for forward compatibility. Always "v1". */
  schemaVersion: z.literal("v1"),

  /** Logging configuration. */
  logging: z
    .object({
      /** Minimum log level. Messages below this level are suppressed. */
      level: z
        .enum(["debug", "info", "warn", "error", "silent"])
        .default("info"),
    })
    .default({}),

  /** Policy override configuration. Merged field-wise with the resolved preset. */
  policy: z
    .object({
      /** Default policy mode when /hydrate is called without an explicit mode. */
      defaultMode: z.enum(["solo", "team", "regulated"]).optional(),
      /** Override max self-review iterations (PLAN phase). */
      maxSelfReviewIterations: z.number().int().min(1).max(10).optional(),
      /** Override max impl-review iterations (IMPL_REVIEW phase). */
      maxImplReviewIterations: z.number().int().min(1).max(10).optional(),
    })
    .default({}),

  /** Profile configuration. */
  profile: z
    .object({
      /** Default profile ID when /hydrate is called without an explicit profile. */
      defaultId: z.string().optional(),
      /** Override the set of active validation checks. */
      activeChecks: z.array(z.string()).optional(),
    })
    .default({}),
});

// ─── Types ───────────────────────────────────────────────────────────────────

/** Fully resolved FlowGuard configuration (all defaults applied). */
export type FlowGuardConfig = z.infer<typeof FlowGuardConfigSchema>;

/** Log level union type. */
export type LogLevel = FlowGuardConfig["logging"]["level"];

// ─── Defaults ────────────────────────────────────────────────────────────────

/**
 * The default configuration — what readConfig() returns when no config file exists.
 * Zod's .default() on every nested object guarantees all fields are present.
 */
export const DEFAULT_CONFIG: FlowGuardConfig = FlowGuardConfigSchema.parse({
  schemaVersion: "v1",
});

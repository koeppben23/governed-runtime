/**
 * @module config/flowguard-config
 * @description FlowGuard configuration schema and defaults.
 *
 * Configuration locations:
 *   Global: ~/.config/opencode/flowguard.json
 *   Repo:   {worktree}/.opencode/flowguard.json
 *   Runtime workspace state: ~/.config/opencode/workspaces/{fingerprint}/...
 *
 * Named flowguard.json to avoid collision with OpenCode's config.json.
 *
 * Priority chain (highest → lowest):
 *   Tool arguments > Repo config > Global config > Policy preset > Built-in defaults
 *
 * Design:
 * - Zod schema with .default() on every nested object — readConfig() always
 *   returns a fully normalized object, even when the file is missing.
 * - schemaVersion is a literal "v1" for forward-compatible parsing.
 *
 * @version v1
 */

import { z } from 'zod';
import { IdpConfigSchema, IdentityProviderModeSchema } from '../identity/index.js';

// ─── Schema ──────────────────────────────────────────────────────────────────

export const FlowGuardConfigSchema = z.object({
  /** Schema version for forward compatibility. Always "v1". */
  schemaVersion: z.literal('v1'),

  /** Logging configuration. */
  logging: z
    .object({
      /** Logging output mode. */
      mode: z.enum(['file', 'ui', 'both']).default('file'),
      /** Minimum log level. Messages below this level are suppressed. */
      level: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
      /** Number of days to retain log files. */
      retentionDays: z.number().int().min(1).max(90).default(7),
    })
    .default({ mode: 'file', level: 'info', retentionDays: 7 }),

  /** Policy override configuration. Merged field-wise with the resolved preset. */
  policy: z
    .object({
      /** Default policy mode when /hydrate is called without an explicit mode. */
      defaultMode: z.enum(['solo', 'team', 'team-ci', 'regulated']).optional(),
      /** Override max self-review iterations (PLAN phase). */
      maxSelfReviewIterations: z.number().int().min(1).max(10).optional(),
      /** Override max impl-review iterations (IMPL_REVIEW phase). */
      maxImplReviewIterations: z.number().int().min(1).max(10).optional(),
      /** P33/P34: Require verified actor identity for regulated approvals.
       * Superseded by minimumActorAssuranceForApproval when set. */
      requireVerifiedActorsForApproval: z.boolean().optional(),
      /** P34: Minimum assurance level required for approval.
       * 'best_effort' | 'claim_validated' | 'idp_verified' */
      minimumActorAssuranceForApproval: z
        .enum(['best_effort', 'claim_validated', 'idp_verified'])
        .optional(),
      /** P35a/P35b1/P35b2: IdP configuration for static keys or JWKS (path/URI). */
      identityProvider: IdpConfigSchema.optional(),
      /** P35a: IdP verification mode ('optional' or 'required'). */
      identityProviderMode: IdentityProviderModeSchema.optional(),
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

  /** Archive configuration. Fields reserved — logic implemented in later phases. */
  archive: z
    .object({
      /** Number of days to retain archived sessions. Null = no auto-cleanup. */
      retentionDays: z.number().int().min(1).optional(),
      /** Whether to auto-cleanup old sessions on workspace init. */
      autoCleanupSessions: z.boolean().optional(),
      /** Custom export path for archived sessions. Null = default location. */
      exportPath: z.string().optional(),
      /** Export redaction policy for archive artifacts. */
      redaction: z
        .object({
          /** Redaction mode for export artifacts. */
          mode: z.enum(['none', 'basic', 'strict']).default('basic'),
          /** Include raw artifacts in archive alongside redacted artifacts. */
          includeRaw: z.boolean().default(false),
        })
        .default({ mode: 'basic', includeRaw: false }),
    })
    .default({ redaction: { mode: 'basic', includeRaw: false } }),
});

// ─── Types ───────────────────────────────────────────────────────────────────

/** Fully resolved FlowGuard configuration (all defaults applied). */
export type FlowGuardConfig = z.infer<typeof FlowGuardConfigSchema>;

/** Log level union type. */
export type LogLevel = FlowGuardConfig['logging']['level'];

/** Logging mode union type. */
export type LogMode = FlowGuardConfig['logging']['mode'];

// ─── Defaults ────────────────────────────────────────────────────────────────

/**
 * The default configuration — what readConfig() returns when no config file exists.
 * Zod's .default() on every nested object guarantees all fields are present.
 */
export const DEFAULT_CONFIG: FlowGuardConfig = FlowGuardConfigSchema.parse({
  schemaVersion: 'v1',
});

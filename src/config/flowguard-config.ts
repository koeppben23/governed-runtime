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

import { z } from 'zod';
import {
  IdentitySource,
  ActorRole,
  DataClassification,
  TargetEnvironment,
  PolicyMode,
} from '../state/evidence';

// ─── Schema ──────────────────────────────────────────────────────────────────

export const FlowGuardConfigSchema = z
  .object({
    /** Schema version for forward compatibility. Always "v1". */
    schemaVersion: z.literal('v1'),

    /** Logging configuration. */
    logging: z
      .object({
        /** Minimum log level. Messages below this level are suppressed. */
        level: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
      })
      .strict()
      .default({}),

    /** Policy override configuration. Merged field-wise with the resolved preset. */
    policy: z
      .object({
        /** Default policy mode when /hydrate is called without an explicit mode. */
        defaultMode: z.enum(['solo', 'team', 'team-ci', 'regulated']).optional(),
        /** Override max self-review iterations (PLAN phase). */
        maxSelfReviewIterations: z.number().int().min(1).max(10).optional(),
        /** Override max impl-review iterations (IMPL_REVIEW phase). */
        maxImplReviewIterations: z.number().int().min(1).max(10).optional(),
      })
      .strict()
      .default({}),

    /** Profile configuration. */
    profile: z
      .object({
        /** Default profile ID when /hydrate is called without an explicit profile. */
        defaultId: z.string().optional(),
        /** Override the set of active validation checks. */
        activeChecks: z.array(z.string()).optional(),
      })
      .strict()
      .default({}),

    /** Identity assertion validation and source policy configuration. */
    identity: z
      .object({
        /** Allowed OIDC issuers for host assertions. */
        allowedIssuers: z.array(z.string().min(1)).default([]),
        /** Maximum assertion age (seconds) before stale fail-closed. */
        assertionMaxAgeSeconds: z.number().int().min(1).max(3600).default(300),
        /** Require assertion sessionBindingId to match current session context. */
        requireSessionBinding: z.boolean().default(true),
        /** Modes where local identity fallback is allowed. */
        allowLocalFallbackModes: z.array(PolicyMode).default(['solo', 'team']),
      })
      .strict()
      .default({}),

    /** Role binding configuration for approval and governance role resolution. */
    rbac: z
      .object({
        roleBindings: z
          .array(
            z
              .object({
                subjectMatcher: z
                  .object({
                    subjectId: z.string().min(1).optional(),
                    email: z.string().email().optional(),
                    group: z.string().min(1).optional(),
                  })
                  .strict()
                  .superRefine((value, ctx) => {
                    if (!value.subjectId && !value.email && !value.group) {
                      ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        message: 'subjectMatcher requires subjectId, email, or group',
                      });
                    }
                  }),
                roles: z.array(ActorRole).min(1),
                conditions: z
                  .object({
                    identitySource: z.array(IdentitySource).min(1).optional(),
                    minAssuranceLevel: z.enum(['basic', 'strong']).optional(),
                  })
                  .strict()
                  .optional(),
              })
              .strict(),
          )
          .default([]),
      })
      .strict()
      .default({}),

    /** Risk policy matrix configuration (deterministic first-match, deny-default). */
    risk: z
      .object({
        rules: z
          .array(
            z
              .object({
                id: z.string().min(1),
                priority: z.number().int(),
                match: z
                  .object({
                    actionType: z.array(z.string().min(1)).min(1).optional(),
                    dataClassification: z.array(DataClassification).min(1).optional(),
                    targetEnvironment: z.array(TargetEnvironment).min(1).optional(),
                    systemOfRecord: z.array(z.string().min(1)).min(1).optional(),
                    changeWindow: z.array(z.string().min(1)).min(1).optional(),
                    exceptionPolicy: z.array(z.string().min(1)).min(1).optional(),
                  })
                  .strict(),
                effect: z.enum(['allow', 'allow_with_approval', 'deny']),
                obligations: z
                  .object({
                    justificationRequired: z.boolean().optional(),
                    ticketRequired: z.boolean().optional(),
                    dualApprovalRequired: z.boolean().optional(),
                    requiredApproverRole: z.array(ActorRole).min(1).optional(),
                    minAssuranceLevel: z.enum(['basic', 'strong']).optional(),
                  })
                  .strict()
                  .optional(),
              })
              .strict(),
          )
          .default([]),
        /** Explicit no-match behavior (deny-default for 1.2.0 contracts). */
        noMatchDecision: z.literal('deny').default('deny'),
      })
      .strict()
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
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
  })
  .strict();

// ─── Types ───────────────────────────────────────────────────────────────────

/** Fully resolved FlowGuard configuration (all defaults applied). */
export type FlowGuardConfig = z.infer<typeof FlowGuardConfigSchema>;

/** Log level union type. */
export type LogLevel = FlowGuardConfig['logging']['level'];

// ─── Defaults ────────────────────────────────────────────────────────────────

/**
 * The default configuration — what readConfig() returns when no config file exists.
 * Zod's .default() on every nested object guarantees all fields are present.
 */
export const DEFAULT_CONFIG: FlowGuardConfig = FlowGuardConfigSchema.parse({
  schemaVersion: 'v1',
});

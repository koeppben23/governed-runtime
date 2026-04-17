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

const IdentitySourceSchema = z.enum(['local', 'oidc', 'scim', 'service']);
const ActorRoleSchema = z.enum(['operator', 'approver', 'policy_owner', 'auditor', 'service']);
const DataClassificationSchema = z.enum(['public', 'internal', 'confidential', 'restricted']);
const TargetEnvironmentSchema = z.enum(['dev', 'test', 'staging', 'prod']);

// ─── Schema ──────────────────────────────────────────────────────────────────

export const FlowGuardConfigSchema = z.object({
  /** Schema version for forward compatibility. Always "v1". */
  schemaVersion: z.literal('v1'),

  /** Logging configuration. */
  logging: z
    .object({
      /** Minimum log level. Messages below this level are suppressed. */
      level: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
    })
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
      allowLocalFallbackModes: z.array(z.enum(['solo', 'team'])).default(['solo', 'team']),
    })
    .default({}),

  /** Role binding configuration for approval and governance role resolution. */
  rbac: z
    .object({
      roleBindings: z
        .array(
          z.object({
            subjectMatcher: z
              .object({
                subjectId: z.string().min(1).optional(),
                email: z.string().email().optional(),
                group: z.string().min(1).optional(),
              })
              .superRefine((value, ctx) => {
                if (!value.subjectId && !value.email && !value.group) {
                  ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: 'subjectMatcher requires subjectId, email, or group',
                  });
                }
              }),
            roles: z.array(ActorRoleSchema).min(1),
            conditions: z
              .object({
                identitySource: z.array(IdentitySourceSchema).min(1).optional(),
                minAssuranceLevel: z.enum(['basic', 'strong']).optional(),
              })
              .optional(),
          }),
        )
        .default([]),
    })
    .default({}),

  /** Risk policy matrix configuration (deterministic first-match, deny-default). */
  risk: z
    .object({
      rules: z
        .array(
          z.object({
            id: z.string().min(1),
            priority: z.number().int(),
            match: z.object({
              actionType: z.array(z.string().min(1)).min(1).optional(),
              dataClassification: z.array(DataClassificationSchema).min(1).optional(),
              targetEnvironment: z.array(TargetEnvironmentSchema).min(1).optional(),
              systemOfRecord: z.array(z.string().min(1)).min(1).optional(),
            }),
            effect: z.enum(['allow', 'allow_with_approval', 'deny']),
            obligations: z
              .object({
                justificationRequired: z.boolean().optional(),
                ticketRequired: z.boolean().optional(),
                dualApprovalRequired: z.boolean().optional(),
                requiredApproverRole: z.array(ActorRoleSchema).min(1).optional(),
                minAssuranceLevel: z.enum(['basic', 'strong']).optional(),
              })
              .optional(),
          }),
        )
        .default([]),
      /** Optional explicit mode to resolve when no rule matches. */
      noMatchDecision: z.enum(['deny', 'defer_to_mode']).default('deny'),
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
        .default({}),
    })
    .default({}),
});

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

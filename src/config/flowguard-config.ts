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
import { RiskTriggerPathsSchema } from '../state/risk-trigger-paths.js';
import { ActorAssuranceSchema } from '../shared/actor-assurance.js';
import { IdpConfigSchema, IdentityProviderModeSchema } from '../identity/index.js';
import { PolicyModeSchema } from '../state/policy-mode.js';
import { HOST_IDS } from '../shared/hosts.js';
import {
  LogLevelSchema,
  ConsoleFormatSchema,
  MaxFileSizeMbSchema,
  RateLimitMaxPerSecondSchema,
  DynamicLogLevelEnabledSchema,
  OtlpEnabledSchema,
  OtlpEndpointSchema,
  OtlpAllowInsecureSchema,
} from './logging-config.js';

// ─── Schema ──────────────────────────────────────────────────────────────────

/** Default maximum output tokens requested from the independent reviewer. */
export const REVIEWER_OUTPUT_TOKEN_MAX_DEFAULT = 65_536;
/** Default maximum duration of one reviewer tool call. */
const REVIEWER_TOOL_TIMEOUT_MS_DEFAULT = 30_000;
/** Default review-phase budget. Tool time is nested inside this budget. */
const REVIEWER_REVIEW_TIMEOUT_MS_DEFAULT = 480_000;
/** Default serialization budget, including one optional format correction. */
const REVIEWER_SERIALIZATION_TIMEOUT_MS_DEFAULT = 60_000;
/** Absolute reviewer execution deadline from dispatch authorization. */
const REVIEWER_EXECUTION_TIMEOUT_MS_DEFAULT = 600_000;

export const FlowGuardConfigSchema = z.object({
  /** Schema version for forward compatibility. Always "v1". */
  schemaVersion: z.literal('v1'),

  /** Logging configuration. */
  logging: z
    .object({
      /** Logging output mode. */
      mode: z.enum(['file', 'ui', 'both', 'console', 'file+console']).default('file'),
      /** Minimum log level. Messages below this level are suppressed. */
      level: LogLevelSchema.default('info'),
      /** Number of days to retain log files. */
      retentionDays: z.number().int().min(1).max(90).default(7),
      /** Console output format. 'text' for readable, 'json' for structured (container aggregators). */
      consoleFormat: ConsoleFormatSchema,
      /** Maximum log file size in megabytes before rotation. */
      maxFileSizeMb: MaxFileSizeMbSchema,
      /** Rate limiting configuration. Disabled by default — enable in production. */
      rateLimit: z
        .object({
          /** Enable rate limiting. Default: false (opt-in). */
          enabled: z.boolean().default(false),
          /** Max entries per second per (service, level) key. */
          maxPerSecond: RateLimitMaxPerSecondSchema,
          /** Levels exempt from rate limiting. Default: ['error']. */
          exemptLevels: z.array(LogLevelSchema).default(['error']),
          /** Interval in ms between rate-limit summary reports on stderr. */
          summaryIntervalMs: z.number().int().min(10000).max(600000).default(60000),
        })
        .default({
          enabled: false,
          maxPerSecond: 100,
          exemptLevels: ['error'],
          summaryIntervalMs: 60000,
        })
        // `error` is ALWAYS exempt — error logs surface failures and must never be
        // silently dropped by rate limiting. Applied at the OBJECT level so it
        // also covers the object-level / outer-logging .default() paths, which
        // bypass a field-level transform in Zod. This transform is the single
        // guard of the invariant, not the hand-written literals above.
        .transform((rl) =>
          rl.exemptLevels.includes('error')
            ? rl
            : { ...rl, exemptLevels: [...rl.exemptLevels, 'error' as const] },
        ),
      /** Enable SIGUSR1 for runtime log level changes. Default: false. */
      enableDynamicLevel: DynamicLogLevelEnabledSchema,
      /** OTLP log export (OpenTelemetry Logs). Disabled by default. */
      otlp: z
        .object({
          /** Enable OTLP log export. Default: false. */
          enabled: OtlpEnabledSchema,
          /** OTLP endpoint override. Falls back to OTEL_EXPORTER_OTLP_ENDPOINT env var. */
          endpoint: OtlpEndpointSchema,
          /** Allow a cleartext http:// endpoint. Default: false (HTTPS required). */
          allowInsecure: OtlpAllowInsecureSchema,
        })
        .superRefine((val, ctx) => {
          if (
            val.endpoint &&
            !val.allowInsecure &&
            !val.endpoint.toLowerCase().startsWith('https://')
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['endpoint'],
              message:
                'OTLP endpoint must use https:// (set logging.otlp.allowInsecure to opt into cleartext http://)',
            });
          }
        })
        .default({ enabled: false, allowInsecure: false }),
    })
    .default({
      mode: 'file',
      level: 'info',
      retentionDays: 7,
      consoleFormat: 'text',
      maxFileSizeMb: 10,
      rateLimit: {
        enabled: false,
        maxPerSecond: 100,
        exemptLevels: ['error'],
        summaryIntervalMs: 60000,
      },
      enableDynamicLevel: false,
      otlp: { enabled: false, allowInsecure: false },
    }),

  /** Human Projection UX telemetry — optional, non-authoritative, disabled by default. */
  humanProjectionTelemetry: z
    .object({
      /** Enable structured UX observation events. Default: false (opt-in). */
      enabled: z.boolean().default(false),
    })
    .default({ enabled: false }),

  /** Policy override configuration. Merged field-wise with the resolved preset. */
  policy: z
    .object({
      /** Default policy mode when /hydrate is called without an explicit mode. */
      defaultMode: PolicyModeSchema.optional(),
      /** Field-wise review-loop budget overrides. */
      reviewBudget: z
        .object({
          plan: z.number().int().min(1).max(10).optional(),
          architecture: z.number().int().min(1).max(10).optional(),
          implementation: z.number().int().min(1).max(10).optional(),
        })
        .optional(),
      /** Override retries after accept findings contain blocking issues (F12). */
      maxIncoherentReviewerCaptureRetries: z.number().int().min(0).max(5).optional(),
      /** Override obligation-level reviewer-attempt budget (output repairs and
       * task re-arms). */
      maxReviewerAttempts: z.number().int().min(0).max(5).optional(),
      /** P34: Minimum assurance level required for approval. */
      minimumActorAssuranceForApproval: ActorAssuranceSchema.optional(),
      /** P35a/P35b1/P35b2: IdP configuration for static keys or JWKS (path/URI). */
      identityProvider: IdpConfigSchema.optional(),
      /** P35a: IdP verification mode ('optional' or 'required'). */
      identityProviderMode: IdentityProviderModeSchema.optional(),
      /** Enforce machine-checked runtime risk classification. */
      enforceRiskClassification: z.boolean().optional(),
      riskTriggerPaths: RiskTriggerPathsSchema.optional(),
      /** Permit structured risk-downgrade overrides. Initial presets keep this false. */
      /** Permit policy-gated reduced ceremony for runtime-verified TRIVIAL tasks. */
      allowReducedCeremony: z.boolean().optional(),
      /**
       * Policy-gated Discovery health enforcement (#399). Field-wise merged onto
       * the resolved preset. Omitted fields fall back to the preset default.
       */
      discoveryHealth: z
        .object({
          enforcement: z.enum(['off', 'advisory', 'required']).optional(),
          onDegraded: z.enum(['allow', 'warn', 'block']).optional(),
          onDrift: z.enum(['allow', 'warn', 'block']).optional(),
        })
        .optional(),
      /**
       * Policy-gated validation-evidence enforcement (#400). Field-wise merged
       * onto the resolved preset. Omitted fields fall back to the preset default.
       * `allowNoCommands` is the only sanctioned opt-out from the fail-closed
       * `required` posture.
       */
      validationEvidence: z
        .object({
          enforcement: z.enum(['off', 'advisory', 'required']).optional(),
          allowNoCommands: z.boolean().optional(),
        })
        .optional(),
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
    .default({}),

  /** Transient presentation preferences; never workflow or audit authority. */
  presentation: z
    .object({
      /** OpenCode-only transient Markdown preferences. */
      opencode: z
        .object({
          /** Glyph vocabulary for host-visible Markdown responses. */
          glyphProfile: z.enum(['unicode', 'ascii']).default('unicode'),
        })
        .default({ glyphProfile: 'unicode' }),
    })
    .default({ opencode: { glyphProfile: 'unicode' } }),

  /** Host execution configuration. Does not affect governance authority. */
  host: z
    .object({
      /** Default host for flowguard run/serve when no CLI --host is provided. */
      defaultHost: z.enum(HOST_IDS).optional(),
    })
    .default({}),

  /** Independent-reviewer transport configuration. */
  reviewer: z
    .object({
      /**
       * Output-token ceiling applied to the OpenCode flowguard-reviewer agent.
       * The host's model must support at least this value; the plugin fails
       * closed instead of silently lowering the cap.
       */
      outputTokenMax: z
        .number()
        .int()
        .min(1)
        .max(1_000_000)
        .default(REVIEWER_OUTPUT_TOKEN_MAX_DEFAULT),
      /** Maximum duration of one reviewer tool call. Must fit inside the review budget. */
      toolTimeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(480_000)
        .default(REVIEWER_TOOL_TIMEOUT_MS_DEFAULT),
      /** Maximum duration of the reviewer's substantive review phase. */
      reviewTimeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(600_000)
        .default(REVIEWER_REVIEW_TIMEOUT_MS_DEFAULT),
      /** Serialization budget, including at most one bounded format correction. */
      serializationTimeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(480_000)
        .default(REVIEWER_SERIALIZATION_TIMEOUT_MS_DEFAULT),
      /** Absolute deadline from reviewer dispatch authorization through binding. */
      executionTimeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(1_800_000)
        .default(REVIEWER_EXECUTION_TIMEOUT_MS_DEFAULT),
    })
    .superRefine((reviewer, ctx) => {
      if (reviewer.toolTimeoutMs > reviewer.reviewTimeoutMs) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['toolTimeoutMs'],
          message: 'toolTimeoutMs must not exceed reviewTimeoutMs',
        });
      }
      if (reviewer.reviewTimeoutMs > reviewer.executionTimeoutMs) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['reviewTimeoutMs'],
          message: 'reviewTimeoutMs must not exceed executionTimeoutMs',
        });
      }
      if (reviewer.serializationTimeoutMs > reviewer.executionTimeoutMs) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['serializationTimeoutMs'],
          message: 'serializationTimeoutMs must not exceed executionTimeoutMs',
        });
      }
    })
    .default({
      outputTokenMax: REVIEWER_OUTPUT_TOKEN_MAX_DEFAULT,
      toolTimeoutMs: REVIEWER_TOOL_TIMEOUT_MS_DEFAULT,
      reviewTimeoutMs: REVIEWER_REVIEW_TIMEOUT_MS_DEFAULT,
      serializationTimeoutMs: REVIEWER_SERIALIZATION_TIMEOUT_MS_DEFAULT,
      executionTimeoutMs: REVIEWER_EXECUTION_TIMEOUT_MS_DEFAULT,
    }),

  /** Archive configuration. */
  archive: z
    .object({
      /** Export redaction constraints for archive artifacts. */
      redaction: z
        .object({
          /** Allowed redaction modes. Must contain at least one. */
          allowedModes: z
            .array(z.enum(['none', 'basic', 'pseudonymous']))
            .min(1)
            .default(['none', 'basic', 'pseudonymous']),
          /** Whether raw (unredacted) evidence export is permitted. Default: false (secure). */
          allowRawExport: z.boolean().default(false),
          /** Maximum audit events processed during redaction. Exceeding this fails the archive. */
          maxAuditEvents: z.number().int().min(1).max(100_000).default(10_000),
        })
        .default({
          allowedModes: ['none', 'basic', 'pseudonymous'],
          allowRawExport: false,
          maxAuditEvents: 10_000,
        }),
    })
    .default({
      redaction: {
        allowedModes: ['none', 'basic', 'pseudonymous'],
        allowRawExport: false,
        maxAuditEvents: 10_000,
      },
    }),
});

// ─── Types ───────────────────────────────────────────────────────────────────

/** Fully resolved FlowGuard configuration (all defaults applied). */
export type FlowGuardConfig = z.infer<typeof FlowGuardConfigSchema>;

export type { LogLevel, ConsoleFormat, MaxFileSizeMb } from './logging-config.js';

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

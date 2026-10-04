import { z } from 'zod';

// ── Path validation ───────────────────────────────────────────────────

const pathSchema = z
  .string()
  .min(1)
  .refine(
    (p) => {
      const normalized = p.replace(/\\/g, '/');
      return (
        !normalized.startsWith('/') &&
        !/^[A-Za-z]:\//u.test(normalized) &&
        !normalized.split('/').includes('..')
      );
    },
    { message: 'must be a repository-relative path without traversal' },
  );

const idSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be a lowercase slug without path separators');

const SyntheticSecretNameSchema = z
  .string()
  .regex(/^FG_EVAL_[A-Z0-9_]+$/, 'synthetic eval secret names must use the FG_EVAL_ namespace');

// ── Severity ──────────────────────────────────────────────────────────

const SeveritySchema = z.enum(['hard', 'advisory']);

/** Keeps customer product prompt evaluation separate from contributor guidance. */
export const InstructionSurfaceSchema = z.enum(['repository_contributor', 'flowguard_product']);
export type InstructionSurface = z.infer<typeof InstructionSurfaceSchema>;

/** Host transport used to materialize FlowGuard product instructions. */
export const InstructionHostSchema = z.enum(['opencode', 'claude-code', 'codex']);
export type InstructionHost = z.infer<typeof InstructionHostSchema>;

/** Whether a runner is deterministic plumbing or an actual host/provider invocation. */
export const RunnerKindSchema = z.enum(['synthetic', 'live-host']);
export type RunnerKind = z.infer<typeof RunnerKindSchema>;

/** Explicit semantic classifications used by assurance metrics. */
export const AssuranceTagSchema = z.enum([
  'not_verified_handling',
  'governance',
  'critical_governance',
]);
export type AssuranceTag = z.infer<typeof AssuranceTagSchema>;

// ── Stream channel ────────────────────────────────────────────────────

const StreamSchema = z.enum(['stdout', 'stderr', 'combined']);

// ── Output assertions ─────────────────────────────────────────────────

const OutputAssertionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('output_contains'),
    value: z.string().min(1),
    stream: StreamSchema.default('combined'),
    severity: SeveritySchema.default('hard'),
    description: z.string().min(1),
  }),
  z.object({
    type: z.literal('output_matches'),
    pattern: z.string().min(1),
    flags: z.string().optional(),
    stream: StreamSchema.default('combined'),
    severity: SeveritySchema.default('hard'),
    description: z.string().min(1),
  }),
  z.object({
    type: z.literal('output_not_contains'),
    value: z.string().min(1),
    stream: StreamSchema.default('combined'),
    severity: SeveritySchema.default('hard'),
    description: z.string().min(1),
  }),
  z.object({
    type: z.literal('output_not_matches'),
    pattern: z.string().min(1),
    flags: z.string().optional(),
    stream: StreamSchema.default('combined'),
    severity: SeveritySchema.default('hard'),
    description: z.string().min(1),
  }),
  z.object({
    type: z.literal('exit_code'),
    value: z.number().int(),
    severity: SeveritySchema.default('hard'),
    description: z.string().min(1),
  }),
]);

// ── File assertions ───────────────────────────────────────────────────

const FileAssertionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('file_exists'),
    path: pathSchema,
    severity: SeveritySchema.default('hard'),
    description: z.string().min(1),
  }),
  z.object({
    type: z.literal('file_changed'),
    path: pathSchema,
    severity: SeveritySchema.default('hard'),
    description: z.string().min(1),
  }),
  z.object({
    type: z.literal('file_not_changed'),
    path: pathSchema,
    severity: SeveritySchema.default('hard'),
    description: z.string().min(1),
  }),
  z.object({
    type: z.literal('file_contains'),
    path: pathSchema,
    value: z.string().min(1),
    severity: SeveritySchema.default('hard'),
    description: z.string().min(1),
  }),
  z.object({
    type: z.literal('file_not_contains'),
    path: pathSchema,
    value: z.string().min(1),
    severity: SeveritySchema.default('hard'),
    description: z.string().min(1),
  }),
]);

// ── Combined assertions ───────────────────────────────────────────────

export const AssertionSchema = z.union([OutputAssertionSchema, FileAssertionSchema]);

export type Assertion = z.infer<typeof AssertionSchema>;
export type OutputAssertion = z.infer<typeof OutputAssertionSchema>;
export type FileAssertion = z.infer<typeof FileAssertionSchema>;

// ── Case schemas ──────────────────────────────────────────────────────

const CaseBase = {
  id: idSchema,
  description: z.string().min(1),
  instructionSurface: InstructionSurfaceSchema,
  instructionHost: InstructionHostSchema.optional(),
  /** Assurance classifications are explicit data; case IDs carry no metric semantics. */
  assuranceTags: AssuranceTagSchema.array().default([]),
  task: z.string().min(1),
  /**
   * Synthetic, non-production secret values available only to the eval child.
   * Values are automatically added to report redaction. This is intentionally
   * separate from provider credentials supplied through RunnerConfig.
   */
  syntheticSecrets: z.record(SyntheticSecretNameSchema, z.string().min(16)).default({}),
  assertions: AssertionSchema.array().min(1),
};

export const EvalCaseSchema = z
  .discriminatedUnion('mode', [
    z.object({
      ...CaseBase,
      mode: z.literal('workspace'),
      workspace: z.object({ mode: z.literal('fixture') }),
    }),
    z.object({
      ...CaseBase,
      mode: z.literal('output-only'),
      workspace: z.object({ mode: z.literal('empty') }).default({ mode: 'empty' }),
    }),
  ])
  .superRefine((evalCase, ctx) => {
    if (
      evalCase.instructionSurface === 'flowguard_product' &&
      evalCase.instructionHost === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['instructionHost'],
        message: 'flowguard_product cases require an explicit instructionHost',
      });
    }
    if (
      evalCase.instructionSurface === 'repository_contributor' &&
      evalCase.instructionHost !== undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['instructionHost'],
        message: 'repository_contributor cases must not declare a product instructionHost',
      });
    }
    evalCase.assertions.forEach((assertion, index) => {
      if (assertion.type !== 'output_matches' && assertion.type !== 'output_not_matches') return;
      try {
        new RegExp(assertion.pattern, assertion.flags);
      } catch (error) {
        ctx.addIssue({
          code: 'custom',
          path: ['assertions', index, 'pattern'],
          message: `invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    });
  });

export type EvalCase = z.infer<typeof EvalCaseSchema>;

// ── Runner config ─────────────────────────────────────────────────────

const RunnerBase = {
  name: z.string().min(1),
  command: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  modelVersion: z.string().min(1),
  runnerVersion: z.string().min(1),
  /** Requested sampling seed; this does not itself prove provider-effective seeding. */
  seed: z.string().min(1).optional(),
  runnerKind: RunnerKindSchema.optional(),
  instructionHost: InstructionHostSchema.optional(),
  staticEnv: z.record(z.string(), z.string()).default({}),
  secretEnvNames: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).default([]),
  timeoutMs: z.number().int().positive().default(600_000),
};

const InnerRunnerConfigSchema = z.discriminatedUnion('promptTransport', [
  z.object({
    ...RunnerBase,
    promptTransport: z.literal('stdin'),
    args: z.array(z.string()).default([]),
  }),
  z
    .object({
      ...RunnerBase,
      promptTransport: z.literal('argument'),
      args: z.array(z.string()).default([]),
    })
    .superRefine((c, ctx) => {
      const count = c.args.reduce((t, a) => t + a.split('{prompt}').length - 1, 0);
      if (count !== 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['args'],
          message: 'exactly one {prompt} placeholder required',
        });
      }
    }),
]);

const RunnerConfigValidatedSchema = InnerRunnerConfigSchema.superRefine((config, ctx) => {
  if (config.runnerKind === 'live-host' && config.instructionHost === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['instructionHost'],
      message: 'live-host runners require an explicit instructionHost',
    });
  }
  const secretLikeKey = /(SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL)/i;
  for (const key of Object.keys(config.staticEnv)) {
    if (secretLikeKey.test(key)) {
      ctx.addIssue({
        code: 'custom',
        path: ['staticEnv', key],
        message: 'secret-like environment keys must be supplied via secretEnvNames, not staticEnv',
      });
    }
  }
});

export const RunnerConfigSchema = z.preprocess((input) => {
  if (typeof input === 'object' && input !== null && !('promptTransport' in input)) {
    return { ...(input as Record<string, unknown>), promptTransport: 'stdin' };
  }
  return input;
}, RunnerConfigValidatedSchema);

export type RunnerConfig = z.infer<typeof InnerRunnerConfigSchema>;

// ── Result schemas ────────────────────────────────────────────────────

export const AssertionResultSchema = z.object({
  description: z.string(),
  type: z.string(),
  severity: z.enum(['hard', 'advisory']),
  passed: z.boolean(),
  expected: z.string().optional(),
  received: z.string().optional(),
});

export type AssertionResult = z.infer<typeof AssertionResultSchema>;

export const EvalCaseResultSchema = z.object({
  caseId: idSchema,
  instructionSurface: InstructionSurfaceSchema,
  instructionHost: InstructionHostSchema.optional(),
  assuranceTags: AssuranceTagSchema.array().default([]),
  verdict: z.enum(['PASS', 'FAIL', 'RUNNER_ERROR']),
  durationMs: z.number(),
  assertionResults: AssertionResultSchema.array(),
  runnerError: z.string().optional(),
  snapshotSummary: z
    .object({
      beforeFiles: z.number(),
      afterFiles: z.number(),
      changed: z.string().array(),
    })
    .optional(),
});

export type EvalCaseResult = z.infer<typeof EvalCaseResultSchema>;

export const EvalRunnerProvenanceSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()),
  promptTransport: z.enum(['stdin', 'argument']),
  provider: z.string().min(1),
  model: z.string().min(1),
  modelVersion: z.string().min(1),
  runnerVersion: z.string().min(1),
  seed: z.string().min(1).optional(),
  runnerKind: RunnerKindSchema.optional(),
  instructionHost: InstructionHostSchema.optional(),
  timeoutMs: z.number().int().positive(),
  configDigest: z.string().regex(/^[0-9a-f]{64}$/),
  secretEnvNames: z.array(z.string()),
});

export type EvalRunnerProvenance = z.infer<typeof EvalRunnerProvenanceSchema>;

export const RepositoryProvenanceSchema = z.object({
  gitCommit: z.string().regex(/^[0-9a-f]{40}$/),
  gitDirty: z.boolean(),
  flowguardVersion: z.string().min(1),
  mandateDigest: z.string().regex(/^[0-9a-f]{64}$/),
  caseCorpusDigest: z.string().regex(/^[0-9a-f]{64}$/),
});

export type RepositoryProvenance = z.infer<typeof RepositoryProvenanceSchema>;

const VerdictCountsSchema = z.object({
  passed: z.number(),
  failed: z.number(),
  runnerErrors: z.number(),
});

export const EvalSummarySchema = z.object({
  schemaVersion: z.literal(3),
  runner: EvalRunnerProvenanceSchema,
  repository: RepositoryProvenanceSchema,
  byInstructionSurface: z.object({
    repository_contributor: VerdictCountsSchema,
    flowguard_product: VerdictCountsSchema,
  }),
  byInstructionHost: z.object({
    opencode: VerdictCountsSchema,
    'claude-code': VerdictCountsSchema,
    codex: VerdictCountsSchema,
  }),
  cases: EvalCaseResultSchema.array(),
});

export type EvalSummary = z.infer<typeof EvalSummarySchema>;

// ── Internal execution types ──────────────────────────────────────────

import type { RunnerOutcome } from './runners/process-runner.js';

export interface ExecutedEvalCase {
  evalCase: EvalCase;
  result: EvalCaseResult;
  outcome: RunnerOutcome;
}

export interface ExecutedRun {
  runner: string;
  cases: ExecutedEvalCase[];
}

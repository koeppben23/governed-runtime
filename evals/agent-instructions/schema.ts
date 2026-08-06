import { z } from 'zod';

// ── Path validation ───────────────────────────────────────────────────

const pathSchema = z
  .string()
  .min(1)
  .refine(
    (p) => {
      const normalized = p.replace(/\\/g, '/');
      return !normalized.startsWith('/') && !normalized.split('/').includes('..');
    },
    { message: 'must be a repository-relative path without traversal' },
  );

// ── Severity ──────────────────────────────────────────────────────────

const SeveritySchema = z.enum(['hard', 'advisory']);

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

export const AssertionSchema = z.union([
  OutputAssertionSchema,
  FileAssertionSchema,
]);

export type Assertion = z.infer<typeof AssertionSchema>;
export type OutputAssertion = z.infer<typeof OutputAssertionSchema>;
export type FileAssertion = z.infer<typeof FileAssertionSchema>;

// ── Case schemas ──────────────────────────────────────────────────────

export const EvalCaseSchema = z.discriminatedUnion('mode', [
  z.object({
    id: z.string().min(1),
    description: z.string().min(1),
    task: z.string().min(1),
    mode: z.literal('workspace'),
    workspace: z.object({
      mode: z.literal('fixture'),
    }),
    assertions: AssertionSchema.array().min(1),
  }),
  z.object({
    id: z.string().min(1),
    description: z.string().min(1),
    task: z.string().min(1),
    mode: z.literal('output-only'),
    workspace: z
      .object({
        mode: z.literal('empty'),
      })
      .default({ mode: 'empty' }),
    assertions: AssertionSchema.array().min(1),
  }),
]);

export type EvalCase = z.infer<typeof EvalCaseSchema>;

// ── Runner config ─────────────────────────────────────────────────────

const RunnerBase = {
  name: z.string().min(1),
  command: z.string().min(1),
  staticEnv: z.record(z.string(), z.string()).default({}),
  secretEnvNames: z
    .array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/))
    .default([]),
  timeoutMs: z.number().int().positive().default(600_000),
};

export const RunnerConfigSchema = z.discriminatedUnion('promptTransport', [
  z.object({
    ...RunnerBase,
    promptTransport: z.literal('stdin'),
    args: z.array(z.string()).default([]),
  }),
  z.object({
    ...RunnerBase,
    promptTransport: z.literal('argument'),
    args: z.array(z.string()).default([]),
  }).superRefine((c, ctx) => {
    const count = c.args.reduce(
      (t, a) => t + a.split('{prompt}').length - 1,
      0,
    );
    if (count !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['args'],
        message: 'exactly one {prompt} placeholder required',
      });
    }
  }),
]);

export type RunnerConfig = z.infer<typeof RunnerConfigSchema>;

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
  caseId: z.string(),
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

export const EvalSummarySchema = z.object({
  schemaVersion: z.literal(1),
  runner: z.string(),
  passed: z.number(),
  failed: z.number(),
  runnerErrors: z.number(),
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

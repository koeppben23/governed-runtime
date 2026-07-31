/**
 * @module integration/tools/record-mutation-evidence
 * @description flowguard_record_mutation_evidence — record an observed mutation report.
 *
 * This is the canonical producer of `MutationAttempt` records. An agent that has
 * just completed a mutation run calls this tool to create an immutable,
 * audit-bound evidence record in session state. The tool:
 *
 * 1. Derives `implementationDigest` from the current session state — never from
 *    caller input.
 * 2. Loads the mutation report from disk and validates it.
 * 3. Computes both `artifactDigest` (SHA-256 of the raw file) and
 *    `projectionDigest` (SHA-256 of the canonical consumer subset).
 * 4. Persists the `MutationAttempt` in session state.
 *
 * Scope of the resulting claim — deliberately precise:
 *
 *   FlowGuard OBSERVED a report at a point in time, hashed it, and bound it to
 *   the current implementation digest.
 *
 * NOT:
 *
 *   FlowGuard executed this command with this exit code in this time window.
 *
 * `command`, `startedAt`, `completedAt`, and `exitCode` are CALLER-SUPPLIED run
 * metadata; FlowGuard neither executes nor observes the process. Only the two
 * digests and the implementation binding are FlowGuard-computed. A future
 * executor could upgrade these fields to genuinely attested execution evidence.
 *
 * Without a recorded `MutationAttempt`, a raw report on disk yields
 * `unavailable` / NOT_VERIFIED, never a pass-by-fallback.
 *
 * @version v1
 */

import { z } from 'zod';

import type { SessionState } from '../../state/schema.js';
import { MutationAttempt } from '../../state/evidence-mutation.js';
import { buildMutationAttempt, loadReportRaw } from '../proofgraph/mutation-provider.js';
import type { ToolDefinition } from './helpers.js';
import {
  appendNextAction,
  formatBlocked,
  formatError,
  getWorktree,
  withMutableSessionTransaction,
  writeStateWithArtifacts,
} from './helpers.js';

/** Phases in which recording mutation evidence is admissible. */
const RECORD_MUTATION_PHASES: ReadonlySet<SessionState['phase']> = new Set([
  'IMPL_VALIDATION',
  'IMPL_REVIEW',
  'EVIDENCE_REVIEW',
  'COMPLETE',
]);

function validatePreconditions(state: SessionState):
  | { readonly kind: 'ok'; readonly implementationDigest: string }
  | {
      readonly kind: 'blocked';
      readonly code: string;
      readonly reason: string;
      readonly recovery: string;
    } {
  if (!RECORD_MUTATION_PHASES.has(state.phase)) {
    return {
      kind: 'blocked',
      code: 'PROOFGRAPH_MUTATION_PHASE_INELIGIBLE',
      reason: 'mutation evidence can only be recorded after implementation is complete',
      recovery: 'complete /implement first',
    };
  }
  const implementation = state.implementation;
  if (implementation === null) {
    return {
      kind: 'blocked',
      code: 'PROOFGRAPH_MUTATION_NO_IMPLEMENTATION',
      reason: 'no implementation evidence exists; cannot bind mutation evidence to a revision',
      recovery: 'call /implement first',
    };
  }
  return { kind: 'ok', implementationDigest: implementation.digest };
}

export const record_mutation_evidence: ToolDefinition = {
  description:
    'Record a completed mutation run as immutable evidence. ' +
    'Call this AFTER the mutation command completes. Without it, ' +
    'mutation profiles in ProofGraph claims remain NOT_VERIFIED. ' +
    'The implementation digest is bound from session state, never from caller input.',
  args: {
    command: z.string().min(1).describe('Exact command that produced the mutation report.'),
    startedAt: z.string().datetime().describe('ISO-8601 timestamp when the mutation run started.'),
    completedAt: z
      .string()
      .datetime()
      .describe('ISO-8601 timestamp when the mutation run completed.'),
    exitCode: z.number().int().describe('Exit code of the mutation command.'),
    reportPath: z
      .string()
      .min(1)
      .default('reports/mutation/mutation.json')
      .describe('Repository-relative path to the saved mutation report.'),
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async execute(args: any, context: any) {
    try {
      return await withMutableSessionTransaction(context, async ({ sessDir, state }) => {
        const params = z
          .object({
            command: z.string().min(1),
            startedAt: z.string().datetime(),
            completedAt: z.string().datetime(),
            exitCode: z.number().int(),
            reportPath: z.string().min(1).default('reports/mutation/mutation.json'),
          })
          .parse(args);

        const preCheck = validatePreconditions(state);
        if (preCheck.kind === 'blocked') {
          return formatBlocked(preCheck.code, {
            phase: state.phase,
            reason: preCheck.reason,
            recovery: preCheck.recovery,
          });
        }

        const worktree = getWorktree(context);
        const rawReport = await loadReportRaw(worktree, params.reportPath);
        if (rawReport === null) {
          return formatBlocked('PROOFGRAPH_MUTATION_REPORT_MISSING', {
            reportPath: params.reportPath,
            reason: `mutation report not found at ${params.reportPath}`,
            recovery: 'run the mutation command first (default: npm run mutation)',
          });
        }

        const built = buildMutationAttempt(
          rawReport,
          preCheck.implementationDigest,
          {
            command: params.command,
            startedAt: params.startedAt,
            completedAt: params.completedAt,
            exitCode: params.exitCode,
          },
          params.reportPath,
        );

        if (built.kind === 'error') {
          return formatBlocked('PROOFGRAPH_MUTATION_REPORT_INVALID', {
            reason: built.message,
            recovery: 'ensure the report is a valid mutation-testing-elements JSON output',
          });
        }

        const attempt = built.attempt;
        try {
          MutationAttempt.parse(attempt);
        } catch {
          return formatError('Internal error: produced MutationAttempt failed schema validation.');
        }

        const existing = state.mutationAttempts ?? [];
        const nextState: SessionState = {
          ...state,
          mutationAttempts: [...existing, attempt],
        };
        await writeStateWithArtifacts(sessDir, nextState);
        return appendNextAction(
          JSON.stringify({
            phase: nextState.phase,
            status: `Mutation evidence recorded for attempt ${attempt.attemptId}`,
            attempt,
          }),
          nextState,
        );
      });
    } catch (error) {
      return formatError(error);
    }
  },
};

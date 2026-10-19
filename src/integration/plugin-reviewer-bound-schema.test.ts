/**
 * @module integration/plugin-reviewer-bound-schema.test
 * @description Success proof for the obligation-bound structured-output schema.
 *
 * The fake host behaves like OpenCode's `format: json_schema` with
 * `retryCount: 1`: it validates the model output against the schema FlowGuard
 * sent and, on a violation, asks the same child once more. The reviewer's first
 * draft carries a wrong `iteration` (an exact-equality attestation fact).
 *
 * - Static schema (previous behavior): the draft is schema-valid, passes the
 *   host, and the capture gate rejects it as terminal SUBAGENT_MANDATE_MISMATCH.
 * - Obligation-bound schema: the host rejects the draft, the same child's
 *   corrected serialization binds - no fresh reviewer attempt.
 *
 * @test-policy HAPPY, BAD
 */
import { Ajv } from 'ajv';
import * as crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FlowGuardAuditPlugin } from './plugin.js';
import { createBootableHostClient, createTestWorkspace } from './test-helpers.js';
import { readState } from '../adapters/persistence.js';
import { _resetAgentResolutionCache } from './review/dispatch/agent-resolution.js';
import {
  resolveReviewDispatchAuthority,
  reviewObligationResponseFields,
} from './review/dispatch/dispatch-authority.js';
import { seedStrictPlanSession } from './plugin-host-task-diagnostics-test-helpers.js';
import { REVIEW_FINDINGS_JSON_SCHEMA } from './review/evidence/findings-schema.js';
import { prepareReviewerFindingsForValidation } from './review/enforcement/prepare-findings.js';
import { validateCapturedFindings } from './review/dispatch/native-task-review-bindings.js';

const ajv = new Ajv({ strict: false, allErrors: true });
const CHILD_SESSION_ID = 'child-session-bound-schema';

function findings(obligationId: string, iteration: number): Record<string, unknown> {
  return {
    iteration,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: 'accept',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    challenges: [],
    attestation: { toolObligationId: obligationId },
  };
}

/** OpenCode-like json_schema follow-up: validate, retry once in the same child. */
function schemaEnforcingHost(drafts: Record<string, unknown>[]) {
  const consumed: Record<string, unknown>[] = [];
  const prompt = vi.fn(
    async (opts: {
      body: { format?: { schema: Record<string, unknown>; retryCount?: number } };
    }) => {
      const format = opts.body.format!;
      const validate = ajv.compile(format.schema);
      for (let attempt = 0; attempt <= (format.retryCount ?? 0); attempt += 1) {
        const draft = drafts[attempt]!;
        consumed.push(draft);
        if (validate(draft)) return { data: { info: { structured: draft } } };
      }
      return { data: { info: { error: { name: 'StructuredOutputError' } } } };
    },
  );
  return { prompt, consumed };
}

async function runPlanReview(drafts: (obligationId: string) => Record<string, unknown>[]) {
  const ws = await createTestWorkspace();
  const sessionID = crypto.randomUUID();
  const { sessDir, obligationId } = await seedStrictPlanSession(ws.tmpDir, sessionID);
  const host = schemaEnforcingHost(drafts(obligationId));
  const hooks = await FlowGuardAuditPlugin({
    project: {} as unknown,
    client: {
      ...createBootableHostClient(),
      app: {
        log: async () => {},
        agents: vi.fn(async () => ({ data: [{ id: 'flowguard-reviewer' }] })),
      },
      session: {
        prompt: host.prompt,
        messages: vi.fn(async () => ({
          data: [
            { info: { role: 'user' } },
            {
              info: { role: 'assistant', finish: 'stop' },
              parts: [{ type: 'text', text: 'Verdict: accept.' }],
            },
          ],
        })),
      },
    },
    $: {} as unknown,
    directory: ws.tmpDir,
    worktree: ws.tmpDir,
    serverUrl: new URL('http://localhost:3000'),
  } as unknown as Parameters<typeof FlowGuardAuditPlugin>[0]);
  const before = (await readState(sessDir))!;
  const authority = resolveReviewDispatchAuthority(before.reviewAssurance, obligationId);
  if (authority.kind !== 'ok') throw new Error(authority.reason);
  await hooks['tool.execute.after']!(
    { tool: 'flowguard_plan', sessionID, callID: 'c1', args: {} },
    {
      title: 'plan',
      output: JSON.stringify({
        phase: 'PLAN',
        reviewMode: 'subagent',
        ...reviewObligationResponseFields(authority.authority),
        reviewDispatch: { required: true },
      }),
      metadata: {},
    },
  );
  await hooks['tool.execute.before']!(
    { tool: 'task', sessionID, callID: 'call-1' },
    { args: { subagent_type: 'flowguard-reviewer', prompt: 'agent-authored prompt' } },
  );
  const output = {
    title: 'task',
    output: 'Free-form reviewer transcript text is not findings authority.',
    metadata: { sessionId: CHILD_SESSION_ID },
  };
  await hooks['tool.execute.after']!(
    { tool: 'task', sessionID, callID: 'call-1', args: { subagent_type: 'flowguard-reviewer' } },
    output,
  );
  return {
    ws,
    obligationId,
    before,
    after: (await readState(sessDir))!,
    host,
    result: JSON.parse(String(output.output)) as Record<string, unknown>,
  };
}

describe('obligation-bound structured-output schema (same-child correction)', () => {
  beforeEach(() => {
    _resetAgentResolutionCache();
  });

  it('BAD under the static schema: the wrong-iteration draft passes the host and fails the gate terminally', async () => {
    const ws = await createTestWorkspace();
    try {
      const { sessDir, obligationId } = await seedStrictPlanSession(ws.tmpDir, crypto.randomUUID());
      const state = (await readState(sessDir))!;
      const obligation = state.reviewAssurance!.obligations[0]!;
      const draft = findings(obligationId, obligation.iteration + 1);
      expect(ajv.validate(REVIEW_FINDINGS_JSON_SCHEMA as object, draft)).toBe(true);
      const prepared = prepareReviewerFindingsForValidation({
        rawFindings: draft,
        obligationId,
        hostConstants: {
          mandateDigest: obligation.mandateDigest,
          criteriaVersion: obligation.criteriaVersion,
        },
        hostProvenance: { childSessionId: CHILD_SESSION_ID, reviewedAt: new Date().toISOString() },
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      expect(validateCapturedFindings(state, obligation, prepared.findings)).toMatchObject({
        kind: 'blocked',
        code: 'SUBAGENT_MANDATE_MISMATCH',
      });
    } finally {
      await ws.cleanup();
    }
  });

  it('HAPPY: the host rejects the draft and the same child binds the correction', async () => {
    const run = await runPlanReview((obligationId) => [
      findings(obligationId, 1),
      findings(obligationId, 0),
    ]);
    try {
      expect(run.result.reviewDispatch).toEqual({
        required: true,
        completed: true,
        verdict: 'accept',
      });
      // One follow-up prompt, two serializations inside it: no fresh attempt.
      expect(run.host.prompt).toHaveBeenCalledTimes(1);
      expect(run.host.consumed).toHaveLength(2);
      const assurance = run.after.reviewAssurance!;
      expect(assurance.attempts).toHaveLength(1);
      expect(assurance.attempts[0]?.status).toBe('bound');
      expect(assurance.obligations[0]?.status).toBe('fulfilled');
      expect(assurance.invocations).toHaveLength(1);
    } finally {
      await run.ws.cleanup();
    }
  });

  it('BAD: a persistently wrong draft still fails closed and never binds', async () => {
    const run = await runPlanReview((obligationId) => [
      findings(obligationId, 1),
      findings(obligationId, 2),
    ]);
    try {
      expect(run.result.reviewDispatch).not.toMatchObject({ completed: true });
      expect(run.after.reviewAssurance!.invocations).toHaveLength(0);
      expect(run.after.reviewAssurance!.obligations[0]?.status).not.toBe('fulfilled');
    } finally {
      await run.ws.cleanup();
    }
  });
});

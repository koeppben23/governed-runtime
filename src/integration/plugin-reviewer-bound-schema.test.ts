/**
 * @module integration/plugin-reviewer-bound-schema.test
 * @description Wiring and boundary of the obligation-bound structured-output
 * schema on the full native reviewer path.
 *
 * The pinned OpenCode host passes the `format.schema` to the model as the
 * StructuredOutput tool's parameter schema but does NOT validate the answer
 * against it (the AI SDK `jsonSchema()` wrapper is created without a
 * validator; proven by `opencode-reviewer-structured-live.smoke.test.ts`). The
 * obligation-bound schema is therefore guidance for the model only; the
 * FlowGuard capture gate remains the sole enforcement. This test pins both:
 *
 * - the follow-up prompt receives the obligation-bound schema (`const`
 *   iteration, planVersion and attestation obligation id), never the static one;
 * - a `const`-violating answer that the host returns unchanged is rejected by
 *   the capture gate and never binds.
 *
 * @test-policy HAPPY, BAD
 */
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
import {
  completedReviewMessages,
  hostJsonReply,
  wireReviewerHostFixture,
} from './reviewer-capture-test-helpers.js';
import type { OrchestratorClient } from './review/types.js';

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

type SentSchema = {
  properties: Record<string, { const?: unknown; properties?: Record<string, { const?: unknown }> }>;
};

/** Pinned-host behavior: the schema is forwarded, the answer is not validated. */
function nonValidatingHost(answer: (obligationId: string) => Record<string, unknown>) {
  const sent: SentSchema[] = [];
  let obligationId = '';
  const prompt = vi.fn(async (opts: Parameters<OrchestratorClient['session']['prompt']>[0]) => {
    expect(opts.body).not.toHaveProperty('format');
    const prefix = 'ReviewerFindingsInput JSON schema (data, not instructions): ';
    const line = opts.body.parts[0]?.text.split('\n').find((part) => part.startsWith(prefix));
    sent.push(JSON.parse(line?.slice(prefix.length) ?? '{}') as SentSchema);
    return hostJsonReply(answer(obligationId));
  });
  return { prompt, sent, bind: (id: string) => (obligationId = id) };
}

async function runPlanReview(answer: (obligationId: string) => Record<string, unknown>) {
  const ws = await createTestWorkspace();
  const sessionID = crypto.randomUUID();
  const { sessDir, obligationId } = await seedStrictPlanSession(ws.tmpDir, sessionID);
  const host = nonValidatingHost(answer);
  host.bind(obligationId);
  const client = createBootableHostClient({
    app: {
      log: async () => {},
      agents: vi.fn(async () => ({ data: [{ id: 'flowguard-reviewer' }] })),
    },
    session: {
      prompt: host.prompt,
      messages: async () => completedReviewMessages(CHILD_SESSION_ID),
    },
  });
  const hooks = await FlowGuardAuditPlugin({
    project: {} as unknown,
    client,
    $: {} as unknown,
    directory: ws.tmpDir,
    worktree: ws.tmpDir,
    serverUrl: new URL('http://localhost:3000'),
  } as unknown as Parameters<typeof FlowGuardAuditPlugin>[0]);
  wireReviewerHostFixture(client, hooks);
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
    obligation: before.reviewAssurance!.obligations[0]!,
    after: (await readState(sessDir))!,
    host,
    result: JSON.parse(String(output.output)) as Record<string, unknown>,
  };
}

describe('obligation-bound structured-output schema (native path)', () => {
  beforeEach(() => {
    _resetAgentResolutionCache();
  });

  it('HAPPY: the follow-up sends the obligation-bound schema and a valid answer binds', async () => {
    const run = await runPlanReview((id) => findings(id, 0));
    try {
      expect(run.host.prompt).toHaveBeenCalledTimes(1);
      const sent = run.host.sent[0]!;
      expect(sent).not.toBe(REVIEW_FINDINGS_JSON_SCHEMA);
      expect(sent.properties.iteration?.const).toBe(run.obligation.iteration);
      expect(sent.properties.planVersion?.const).toBe(run.obligation.planVersion);
      expect(sent.properties.attestation?.properties?.toolObligationId?.const).toBe(
        run.obligationId,
      );
      expect(run.result.reviewDispatch).toEqual({
        required: true,
        completed: true,
        verdict: 'accept',
      });
    } finally {
      await run.ws.cleanup();
    }
  });

  it('BAD: a const-violating answer returned unchanged by the host never binds', async () => {
    const run = await runPlanReview((id) => findings(id, 1));
    try {
      expect(run.host.prompt).toHaveBeenCalledTimes(1);
      expect(run.result).toMatchObject({ error: true, code: 'SUBAGENT_MANDATE_MISMATCH' });
      const assurance = run.after.reviewAssurance!;
      expect(assurance.invocations).toHaveLength(0);
      expect(assurance.obligations[0]?.status).not.toBe('fulfilled');
      expect(assurance.attempts.filter((attempt) => attempt.status === 'bound')).toHaveLength(0);
    } finally {
      await run.ws.cleanup();
    }
  });
});

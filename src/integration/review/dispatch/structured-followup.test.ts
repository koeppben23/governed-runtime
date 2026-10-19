/**
 * @module integration/review/dispatch/structured-followup.test
 * @description Diagnostic timing of the same-child structured follow-up.
 *
 * The timing observer covers ONLY the host prompt. A prompt that was never
 * invoked reports `not_invoked` (never 0 ms); a throwing prompt reports its
 * duration and rethrows the original error unchanged; a failing observer never
 * alters the follow-up result.
 *
 * @test-policy HAPPY, BAD, EDGE
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { REVIEWER_SUBAGENT_TYPE } from '../../../shared/flowguard-identifiers.js';
import { _resetAgentResolutionCache } from './agent-resolution.js';
import {
  captureStructuredFindingsFromVisibleChild,
  type StructuredFollowupTiming,
} from './structured-followup.js';
import type { OrchestratorClient } from '../types.js';
import { REVIEW_FINDINGS_JSON_SCHEMA } from '../evidence/findings-schema.js';

const INPUT = {
  childSessionId: 'ses_child_timing',
  obligationId: '44444444-4444-4444-8444-444444444444',
  schema: REVIEW_FINDINGS_JSON_SCHEMA as unknown as Record<string, unknown>,
};

function client(options: {
  readonly agents?: unknown;
  readonly prompt?: () => Promise<unknown>;
}): OrchestratorClient {
  return {
    app: {
      agents: vi.fn(async () => ({ data: options.agents ?? [{ name: REVIEWER_SUBAGENT_TYPE }] })),
    },
    session: {
      prompt: vi.fn(options.prompt ?? (async () => ({ data: { info: {} } }))),
    },
  } as unknown as OrchestratorClient;
}

function recorder(): {
  readonly timings: StructuredFollowupTiming[];
  readonly observe: (timing: StructuredFollowupTiming) => void;
} {
  const timings: StructuredFollowupTiming[] = [];
  return { timings, observe: (timing) => timings.push(timing) };
}

describe('structured follow-up diagnostic timing', () => {
  afterEach(() => {
    _resetAgentResolutionCache();
  });

  it('HAPPY: measures the responded host prompt', async () => {
    const { timings, observe } = recorder();
    const result = await captureStructuredFindingsFromVisibleChild(client({}), INPUT, observe);
    expect(result.kind).toBe('blocked');
    expect(timings).toHaveLength(1);
    expect(timings[0]).toMatchObject({ promptOutcome: 'responded' });
    expect((timings[0] as { followupPromptMs: number }).followupPromptMs).toBeGreaterThanOrEqual(0);
  });

  it('BAD: a prompt that is never invoked is not_invoked, never 0 ms', async () => {
    const { timings, observe } = recorder();
    const host = client({ agents: [] });
    const result = await captureStructuredFindingsFromVisibleChild(host, INPUT, observe);
    expect(result).toMatchObject({
      kind: 'blocked',
      code: 'STRUCTURED_REVIEW_CAPABILITY_UNAVAILABLE',
    });
    expect(host.session.prompt).not.toHaveBeenCalled();
    expect(timings).toEqual([{ followupPromptMsUnavailable: 'not_invoked' }]);
  });

  it('BAD: a throwing host prompt is timed and its original error rethrown unchanged', async () => {
    const { timings, observe } = recorder();
    const failure = new Error('host transport reset');
    await expect(
      captureStructuredFindingsFromVisibleChild(
        client({
          prompt: async () => {
            throw failure;
          },
        }),
        INPUT,
        observe,
      ),
    ).rejects.toBe(failure);
    expect(timings).toHaveLength(1);
    expect(timings[0]).toMatchObject({ promptOutcome: 'threw' });
    expect((timings[0] as { followupPromptMs: number }).followupPromptMs).toBeGreaterThanOrEqual(0);
  });

  it('EDGE: a throwing observer changes neither the result nor the failure path', async () => {
    const throwing = () => {
      throw new Error('diagnostic sink failure');
    };
    const observed = await captureStructuredFindingsFromVisibleChild(client({}), INPUT, throwing);
    _resetAgentResolutionCache();
    const reference = await captureStructuredFindingsFromVisibleChild(client({}), INPUT);
    expect(observed).toEqual(reference);

    _resetAgentResolutionCache();
    const failure = new Error('host transport reset');
    await expect(
      captureStructuredFindingsFromVisibleChild(
        client({
          prompt: async () => {
            throw failure;
          },
        }),
        INPUT,
        throwing,
      ),
    ).rejects.toBe(failure);
  });
});

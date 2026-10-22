/**
 * @module integration/review/dispatch/structured-followup.test
 * @description Diagnostic timing of the same-child structured follow-up.
 *
 * The timing observer covers ONLY the host prompt. A prompt that was never
 * invoked reports `not_invoked` (never 0 ms); a throwing prompt reports its
 * duration and rethrows the original error unchanged; a failing observer never
 * alters the follow-up result.
 *
 * Ref expansion (p42-v7): the review prose cites offered refs by number; the
 * serialization prompt expands each number to the exact offered object, and an
 * unexpanded number never passes the canonical findings contract.
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
import { classifyReviewerCaptureFailure } from './capture-retry.js';
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

function findingsWithChallengeRefs(evidenceRefs: readonly unknown[]): Record<string, unknown> {
  return {
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: 'accept',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    challenges: [
      {
        clientReference: 'c1',
        obligationId: INPUT.obligationId,
        kind: 'design_challenge',
        scenario: 'Remove the guard and run the build.',
        claim: 'The build detects the missing guard.',
        locations: ['plan § Verification'],
        outcome: 'supported',
        evidenceRefs,
      },
    ],
    attestation: { toolObligationId: INPUT.obligationId },
  };
}

describe('structured follow-up ref expansion (p42-v7)', () => {
  afterEach(() => {
    _resetAgentResolutionCache();
  });

  it('HAPPY: the serialization prompt expands cited Ref numbers to the exact offered objects', async () => {
    const host = client({});
    await captureStructuredFindingsFromVisibleChild(host, INPUT);
    const sent = vi.mocked(host.session.prompt).mock.calls[0]?.[0] as unknown as {
      body: { parts: { text: string }[] };
    };
    const text = sent.body.parts[0]!.text;
    expect(text).toContain(
      'Expand every cited offered-ref number ("Ref N") to the exact object listed as Ref N in the offered evidenceRefs of this review; never synthesize, alter, or cite a ref that was not offered.',
    );
    expect(text).toContain('This prompt is serialization only; it is not a second review.');
  });

  it('HAPPY (control): the same findings with an expanded offered ref object pass the contract', async () => {
    const expanded = {
      kind: 'plan_adr_section',
      artifactKind: 'plan',
      artifactDigest: 'a'.repeat(64),
      sectionPath: [{ headingDepth: 2, siblingIndex: 1, headingText: 'Verification' }],
      excerptDigest: 'b'.repeat(64),
    };
    const result = await captureStructuredFindingsFromVisibleChild(
      client({
        prompt: async () => ({
          data: { info: { structured: findingsWithChallengeRefs([expanded]) } },
        }),
      }),
      INPUT,
    );
    expect(result.kind).toBe('ok');
  });

  it.each([['Ref 4'], [4]])(
    'BAD: an unexpanded ref number (%j) fails the canonical contract as a retryable violation',
    async (unexpanded) => {
      const result = await captureStructuredFindingsFromVisibleChild(
        client({
          prompt: async () => ({
            data: { info: { structured: findingsWithChallengeRefs([unexpanded]) } },
          }),
        }),
        INPUT,
      );
      expect(result).toMatchObject({
        kind: 'blocked',
        code: 'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION',
      });
      expect(classifyReviewerCaptureFailure(result.kind === 'blocked' ? result.code : '')).toEqual({
        retryable: true,
        code: 'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION',
      });
    },
  );
});

describe('structured follow-up bounded format correction', () => {
  afterEach(() => {
    _resetAgentResolutionCache();
  });

  const expandedRef = {
    kind: 'plan_adr_section',
    artifactKind: 'plan',
    artifactDigest: 'a'.repeat(64),
    sectionPath: [{ headingDepth: 2, siblingIndex: 1, headingText: 'Verification' }],
    excerptDigest: 'b'.repeat(64),
  };

  function findings(): Record<string, unknown> {
    return findingsWithChallengeRefs([expandedRef]);
  }

  it('accepts exactly one correction when the semantic projection is identical', async () => {
    let calls = 0;
    const host = client({
      prompt: async () => {
        calls += 1;
        if (calls === 1) {
          return { data: { info: { structured: { ...findings(), summary: 'legacy extra' } } } };
        }
        return { data: { info: { structured: findings() } } };
      },
    });
    const result = await captureStructuredFindingsFromVisibleChild(host, INPUT);
    expect(result.kind).toBe('ok');
    expect(calls).toBe(2);
    expect(result).toMatchObject({ serializationRepair: { originalHash: expect.any(String) } });
  });

  it('propagates a repair transport failure to the execution lifecycle boundary', async () => {
    let calls = 0;
    const failure = new Error('repair transport lost while the host may still be running');
    const host = client({
      prompt: async () => {
        calls += 1;
        if (calls === 1)
          return { data: { info: { structured: { ...findings(), summary: 'extra' } } } };
        throw failure;
      },
    });
    await expect(captureStructuredFindingsFromVisibleChild(host, INPUT)).rejects.toBe(failure);
    expect(calls).toBe(2);
  });

  it('rejects a correction that changes an enum or other semantic field', async () => {
    const invalid = findings();
    const invalidBlocking = [
      {
        severity: 'major',
        category: 'claim/evidence fit',
        message: 'bad enum',
        relation: {
          subjectAnchors: [
            {
              kind: 'artifact_section',
              artifactKind: 'plan',
              artifactDigest: 'a'.repeat(64),
              sectionPath: [{ headingDepth: 2, siblingIndex: 1, headingText: 'Verification' }],
            },
          ],
          evidenceLocations: [],
        },
      },
    ];
    const repaired = findings();
    repaired.blockingIssues = [{ ...invalidBlocking[0], category: 'correctness' }];
    repaired.overallVerdict = 'changes_requested';
    let calls = 0;
    const result = await captureStructuredFindingsFromVisibleChild(
      client({
        prompt: async () => {
          calls += 1;
          return {
            data: {
              info: {
                structured:
                  calls === 1 ? { ...invalid, blockingIssues: invalidBlocking } : repaired,
              },
            },
          };
        },
      }),
      INPUT,
    );
    expect(result).toMatchObject({
      kind: 'blocked',
      code: 'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION',
    });
    expect(result.kind === 'blocked' ? result.reason : '').toContain('semantic projection');
    expect(calls).toBe(2);
  });

  it('never repairs accept plus blocking issues into a different verdict', async () => {
    const blocking = [
      {
        severity: 'major',
        category: 'correctness',
        message: 'real',
        relation: {
          subjectAnchors: [
            {
              kind: 'artifact_section',
              artifactKind: 'plan',
              artifactDigest: 'a'.repeat(64),
              sectionPath: [{ headingDepth: 2, siblingIndex: 1, headingText: 'Verification' }],
            },
          ],
          evidenceLocations: [],
        },
      },
    ];
    const invalid = { ...findings(), overallVerdict: 'accept', blockingIssues: blocking };
    const repaired = {
      ...findings(),
      overallVerdict: 'changes_requested',
      blockingIssues: blocking,
    };
    let calls = 0;
    const result = await captureStructuredFindingsFromVisibleChild(
      client({
        prompt: async () => {
          calls += 1;
          return { data: { info: { structured: calls === 1 ? invalid : repaired } } };
        },
      }),
      INPUT,
    );
    expect(result.kind).toBe('ok');
    expect(result).not.toHaveProperty('serializationRepair');
    expect(calls).toBe(1);
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  REVIEWER_AGENT_PRIMARY,
  ReviewerAgentUnavailableError,
  resolveReviewerAgent,
} from './agent-resolution.js';
import { createReviewClient } from '../../opencode-v2-test-helpers.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../../shared/flowguard-identifiers.js';

describe('session-scoped reviewer agent resolution', () => {
  it('uses the canonical reviewer identifier', () => {
    expect(REVIEWER_AGENT_PRIMARY).toBe(REVIEWER_SUBAGENT_TYPE);
  });

  it('resolves by native id in the exact child location', async () => {
    const client = createReviewClient({
      listAgents: vi.fn(async () => [{ id: REVIEWER_AGENT_PRIMARY }]),
    });
    await expect(resolveReviewerAgent(client, 'child')).resolves.toBe(REVIEWER_AGENT_PRIMARY);
    expect(client.listAgents).toHaveBeenCalledWith('child');
    expect(client.executeReviewerPrompt).not.toHaveBeenCalled();
  });

  it.each(
    [[], [{ id: 'general' }], [{ name: REVIEWER_SUBAGENT_TYPE }]].map((agents) => ({ agents })),
  )('never substitutes general or accepts a removed name alias: $agents', async ({ agents }) => {
    const client = createReviewClient({ listAgents: vi.fn().mockResolvedValue(agents) });
    await expect(resolveReviewerAgent(client, 'child')).rejects.toMatchObject({
      name: 'ReviewerAgentUnavailableError',
      code: 'REVIEWER_AGENT_UNAVAILABLE',
    });
    expect(client.executeReviewerPrompt).not.toHaveBeenCalled();
  });

  it.each([null, undefined, {}, { data: [{ id: REVIEWER_AGENT_PRIMARY }] }])(
    'rejects malformed registry results and old envelopes: %j',
    async (agents) => {
      const client = createReviewClient({ listAgents: vi.fn().mockResolvedValue(agents) });
      await expect(resolveReviewerAgent(client, 'child')).rejects.toThrow(/NOT_VERIFIED/);
    },
  );

  it('re-reads capability after reload rather than retaining process-lifetime approval', async () => {
    const listAgents = vi
      .fn()
      .mockResolvedValueOnce([{ id: REVIEWER_AGENT_PRIMARY }])
      .mockResolvedValueOnce([]);
    const client = createReviewClient({ listAgents });
    await expect(resolveReviewerAgent(client, 'child')).resolves.toBe(REVIEWER_AGENT_PRIMARY);
    await expect(resolveReviewerAgent(client, 'child')).rejects.toBeInstanceOf(
      ReviewerAgentUnavailableError,
    );
    expect(listAgents).toHaveBeenCalledTimes(2);
  });

  it('does not carry a denial or approval into another session/location/client', async () => {
    const listAgents = vi.fn(async (sessionId: string) =>
      sessionId === 'available' ? [{ id: REVIEWER_AGENT_PRIMARY }] : [],
    );
    const client = createReviewClient({ listAgents });
    await expect(resolveReviewerAgent(client, 'absent')).rejects.toBeInstanceOf(
      ReviewerAgentUnavailableError,
    );
    await expect(resolveReviewerAgent(client, 'available')).resolves.toBe(REVIEWER_AGENT_PRIMARY);
    const other = createReviewClient({ listAgents: vi.fn(async () => []) });
    await expect(resolveReviewerAgent(other, 'available')).rejects.toBeInstanceOf(
      ReviewerAgentUnavailableError,
    );
    expect(other.listAgents).toHaveBeenCalledOnce();
  });

  it('preserves the underlying host failure as cause', async () => {
    const cause = new Error('transport down');
    const client = createReviewClient({ listAgents: vi.fn().mockRejectedValue(cause) });
    const error: unknown = await resolveReviewerAgent(client, 'child').catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ReviewerAgentUnavailableError);
    expect((error as Error).cause).toBe(cause);
  });

  it('does not fabricate a cause for a missing reviewer', async () => {
    const client = createReviewClient({ listAgents: vi.fn(async () => []) });
    const error: unknown = await resolveReviewerAgent(client, 'child').catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ReviewerAgentUnavailableError);
    expect((error as Error).cause).toBeUndefined();
  });
});

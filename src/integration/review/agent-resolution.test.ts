import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetAgentResolutionCache,
  REVIEWER_AGENT_PRIMARY,
  ReviewerAgentUnavailableError,
  resolveReviewerAgent,
} from './agent-resolution.js';
import type { OrchestratorClient } from './types.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../shared/flowguard-identifiers.js';

function makeClient(opts: {
  agents?: Array<Record<string, unknown>>;
  agentsThrows?: boolean;
  agentsError?: unknown;
}): OrchestratorClient {
  return {
    app: {
      agents: vi.fn(async () => {
        if (opts.agentsThrows) throw new Error('registry unavailable');
        return { data: opts.agents, error: opts.agentsError };
      }),
    },
    session: { prompt: vi.fn() },
  };
}

describe('reviewer agent resolution', () => {
  beforeEach(() => {
    _resetAgentResolutionCache();
  });

  it('uses the canonical reviewer subagent identifier', () => {
    expect(REVIEWER_AGENT_PRIMARY).toBe(REVIEWER_SUBAGENT_TYPE);
    expect(REVIEWER_AGENT_PRIMARY).toBe('flowguard-reviewer');
  });

  it('resolves the isolated reviewer by id', async () => {
    const client = makeClient({ agents: [{ id: 'flowguard-reviewer' }] });
    await expect(resolveReviewerAgent(client)).resolves.toBe(REVIEWER_AGENT_PRIMARY);
  });

  it('resolves the isolated reviewer by name', async () => {
    const client = makeClient({ agents: [{ name: 'flowguard-reviewer' }] });
    await expect(resolveReviewerAgent(client)).resolves.toBe(REVIEWER_AGENT_PRIMARY);
  });

  it('fails closed when the isolated reviewer is missing', async () => {
    const client = makeClient({ agents: [{ id: 'general' }] });
    await expect(resolveReviewerAgent(client)).rejects.toMatchObject({
      name: 'ReviewerAgentUnavailableError',
      code: 'REVIEWER_AGENT_UNAVAILABLE',
    });
    expect(client.session.prompt).not.toHaveBeenCalled();
  });

  it('fails closed when the registry probe throws', async () => {
    const client = makeClient({ agentsThrows: true });
    await expect(resolveReviewerAgent(client)).rejects.toBeInstanceOf(
      ReviewerAgentUnavailableError,
    );
  });

  it('fails closed when the registry returns an error', async () => {
    const client = makeClient({ agentsError: { message: 'unauthorized' } });
    await expect(resolveReviewerAgent(client)).rejects.toThrow(/unable to verify/i);
  });

  it('fails closed when the registry does not return a verifiable array', async () => {
    const client: OrchestratorClient = {
      app: { agents: vi.fn().mockResolvedValue({ data: undefined }) },
      session: { prompt: vi.fn() },
    };
    await expect(resolveReviewerAgent(client)).rejects.toThrow(/not_verified/i);
  });

  it('caches a successful capability resolution for the process lifetime', async () => {
    const client = makeClient({ agents: [{ id: 'flowguard-reviewer' }] });
    await expect(resolveReviewerAgent(client)).resolves.toBe(REVIEWER_AGENT_PRIMARY);
    await expect(resolveReviewerAgent(client)).resolves.toBe(REVIEWER_AGENT_PRIMARY);
    await expect(resolveReviewerAgent(client)).resolves.toBe(REVIEWER_AGENT_PRIMARY);
    expect(client.app.agents).toHaveBeenCalledTimes(1);
  });

  it('caches an unavailable capability without silently re-probing another client', async () => {
    const unavailable = makeClient({ agents: [] });
    await expect(resolveReviewerAgent(unavailable)).rejects.toBeInstanceOf(
      ReviewerAgentUnavailableError,
    );

    const laterClient = makeClient({ agents: [{ id: 'flowguard-reviewer' }] });
    await expect(resolveReviewerAgent(laterClient)).rejects.toBeInstanceOf(
      ReviewerAgentUnavailableError,
    );
    expect(laterClient.app.agents).not.toHaveBeenCalled();
  });

  it('allows a deliberate cache reset to re-probe host capability', async () => {
    const unavailable = makeClient({ agents: [] });
    await expect(resolveReviewerAgent(unavailable)).rejects.toBeInstanceOf(
      ReviewerAgentUnavailableError,
    );

    _resetAgentResolutionCache();
    const available = makeClient({ agents: [{ id: 'flowguard-reviewer' }] });
    await expect(resolveReviewerAgent(available)).resolves.toBe(REVIEWER_AGENT_PRIMARY);
    expect(available.app.agents).toHaveBeenCalledTimes(1);
  });

  it('never substitutes general even when general is explicitly registered', async () => {
    const client = makeClient({ agents: [{ id: 'general', name: 'general' }] });
    await expect(resolveReviewerAgent(client)).rejects.toBeInstanceOf(
      ReviewerAgentUnavailableError,
    );
  });
});

describe('reviewer agent resolution error provenance', () => {
  beforeEach(() => {
    _resetAgentResolutionCache();
  });

  it('preserves the underlying cause when the registry probe throws', async () => {
    const cause = new Error('transport down');
    const client: OrchestratorClient = {
      app: { agents: vi.fn().mockRejectedValue(cause) },
      session: { prompt: vi.fn() },
    };

    const error = await resolveReviewerAgent(client).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ReviewerAgentUnavailableError);
    expect((error as Error).cause).toBe(cause);
  });

  it('does not fabricate a cause on registry error results', async () => {
    const client = makeClient({ agentsError: { message: 'unauthorized' } });

    const error = await resolveReviewerAgent(client).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ReviewerAgentUnavailableError);
    expect((error as Error).cause).toBeUndefined();
  });

  it('echoes the registry error message when one is present', async () => {
    const client = makeClient({ agentsError: { message: 'unauthorized' } });

    await expect(resolveReviewerAgent(client)).rejects.toThrow(/unauthorized/);
  });

  it('falls back to the raw registry error when it carries no message', async () => {
    const client = makeClient({ agentsError: 'denied' });

    await expect(resolveReviewerAgent(client)).rejects.toThrow(/denied/);
  });
});

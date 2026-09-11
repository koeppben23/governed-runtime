import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetAgentResolutionCache,
  REVIEWER_AGENT_PRIMARY,
  ReviewerAgentUnavailableError,
  resolveReviewerAgent,
} from './agent-resolution.js';
import { invokeReviewer, type OrchestratorClient } from './orchestrator.js';
import { REVIEWER_SUBAGENT_TYPE } from './enforcement/types.js';
import { makeClient, NO_SLEEP, PROMPT } from './orchestrator-test-helpers.js';

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
    expect(client.session.create).not.toHaveBeenCalled();
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
      session: { create: vi.fn(), prompt: vi.fn() },
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

  it('returns a structured capability blocker from invokeReviewer when isolation is unavailable', async () => {
    const client = makeClient({ agents: [] });
    const diagnostics: Array<Record<string, unknown>> = [];

    const result = await invokeReviewer(client, PROMPT, 'parent-1', {
      reviewInvocationPolicy: 'sdk_allowed',
      maxRetries: 0,
      _sleepFn: NO_SLEEP,
      _onAttemptFailed: (info) => diagnostics.push(info),
    });

    expect(result).toMatchObject({
      blocked: true,
      code: 'REVIEWER_INVOCATION_EXHAUSTED',
      reviewInvocation: {
        status: 'blocked_capability_mismatch',
        reviewerSubagentType: 'flowguard-reviewer',
        invocationMode: 'sdk_session',
      },
    });
    expect(result && result.blocked ? result.reason : '').toMatch(/isolated reviewer capability/i);
    expect(diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ step: 'agent_probe', attempt: 0 })]),
    );
    expect(client.session.create).not.toHaveBeenCalled();
    expect(client.session.prompt).not.toHaveBeenCalled();
  });

  it('never substitutes general even when general is explicitly registered', async () => {
    const client = makeClient({ agents: [{ id: 'general', name: 'general' }] });
    const result = await invokeReviewer(client, PROMPT, 'parent-1', {
      reviewInvocationPolicy: 'sdk_allowed',
      maxRetries: 0,
      _sleepFn: NO_SLEEP,
    });

    expect(result).toMatchObject({ blocked: true, code: 'REVIEWER_INVOCATION_EXHAUSTED' });
    expect(client.session.prompt).not.toHaveBeenCalled();
  });
});

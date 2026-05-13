/**
 * @module review-orchestrator-test-helpers
 * @description Shared test fixtures for the review orchestrator test suite.
 */

import { vi } from 'vitest';
import type { OrchestratorClient } from './types.js';

export function validFindings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: 'approve',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId: 'child-session-1' },
    reviewedAt: '2026-05-07T12:00:00.000Z',
    attestation: {
      mandateDigest: 'test-mandate-digest',
      criteriaVersion: 'p35-v1',
      toolObligationId: '11111111-1111-4111-8111-111111111111',
      iteration: 0,
      planVersion: 1,
      reviewedBy: 'flowguard-reviewer',
    },
    ...overrides,
  };
}

export const NO_SLEEP = async () => {};
export const TEXT_COMPAT_OPTIONS = { reviewOutputPolicy: 'text_compat_allowed' as const };

export function makeClient(opts: {
  agents?: Array<Record<string, unknown>>;
  agentsError?: unknown;
  agentsThrows?: boolean;
  createResult?: { data?: { id: string }; error?: unknown };
  promptResult?: {
    data?: {
      parts?: Array<{ type?: string; text?: string }>;
      info?: {
        structured?: unknown;
        structured_output?: unknown;
        error?: { name: string; message?: string; data?: { message?: string; retries?: number } };
      };
    };
    error?: unknown;
  };
}): OrchestratorClient {
  const agentsFn = opts.agentsThrows
    ? vi.fn().mockRejectedValue(new Error('network failure'))
    : vi
        .fn()
        .mockResolvedValue(
          opts.agentsError
            ? { error: opts.agentsError }
            : { data: opts.agents ?? [{ id: 'flowguard-reviewer', name: 'flowguard-reviewer' }] },
        );

  return {
    app: { agents: agentsFn },
    session: {
      create: vi
        .fn()
        .mockResolvedValue(
          opts.createResult ?? { data: { id: 'child-session-1' }, error: undefined },
        ),
      prompt: vi.fn().mockResolvedValue(
        opts.promptResult ?? {
          data: {
            parts: [{ type: 'text', text: JSON.stringify(validFindings()) }],
            info: { structured: validFindings() },
          },
          error: undefined,
        },
      ),
    },
  };
}

export const PROMPT = 'Review this plan...';

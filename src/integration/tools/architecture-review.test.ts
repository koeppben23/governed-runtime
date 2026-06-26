/**
 * @module integration/tools/architecture-review.test
 * @description Contract tests for the handleAdrReview() public API.
 *
 * Tests the blocked-path validation gates (wrong phase, missing architecture,
 * missing selfReview, missing findings). The full success path requires a
 * complete MutableSession fixture with persisted state and is intentionally
 * left to integration-level tests.
 *
 * @test-policy HAPPY, BAD, CORNER
 */

import { describe, it, expect } from 'vitest';
import { handleAdrReview } from './architecture-review.js';
import type { ArchitectureArgs } from './architecture-shared.js';
import type { ArchitectureSession } from './architecture-shared.js';
import type { ToolContext } from './helpers.js';

function parseJSON(s: string): Record<string, unknown> {
  return JSON.parse(s);
}

function baseArgs(overrides: Partial<ArchitectureArgs> = {}): ArchitectureArgs {
  return { reviewVerdict: 'accept', ...overrides };
}

function baseSession(stateOverrides: Record<string, unknown> = {}): ArchitectureSession {
  return {
    worktree: '/tmp',
    fingerprint: 'abc',
    sessDir: '/tmp/sess',
    wsDir: '/tmp/ws',
    state: {
      phase: 'ARCHITECTURE',
      architecture: { digest: 'd1', adrText: '## Context\nold text' },
      selfReview: { iteration: 1 },
      ...stateOverrides,
    },
    policy: {
      selfReview: { strictEnforcement: false },
      reviewInvocationPolicy: 'host_task_preferred',
      maxSelfReviewIterations: 3,
    },
    ctx: {},
  } as ArchitectureSession;
}

const baseContext = { sessionID: 'test-session' } as ToolContext;

describe('handleAdrReview', () => {
  it('blocks when phase is not ARCHITECTURE', async () => {
    const session = baseSession({ phase: 'PLAN' });
    const result = parseJSON(await handleAdrReview(baseArgs(), baseContext, session));
    expect(result.error).toBe(true);
    expect(result.code).toBe('COMMAND_NOT_ALLOWED');
  });

  it('blocks when no architecture on state', async () => {
    const session = baseSession({ architecture: null });
    const result = parseJSON(await handleAdrReview(baseArgs(), baseContext, session));
    expect(result.error).toBe(true);
    expect(result.code).toBe('NO_ARCHITECTURE');
  });

  it('blocks when no selfReview on state', async () => {
    const session = baseSession({ selfReview: null });
    const result = parseJSON(await handleAdrReview(baseArgs(), baseContext, session));
    expect(result.error).toBe(true);
    expect(result.code).toBe('ARCHITECTURE_REVIEW_LOOP_REQUIRED');
  });

  it('blocks changes_requested without findings', async () => {
    const session = baseSession();
    const result = parseJSON(
      await handleAdrReview(
        baseArgs({ reviewVerdict: 'changes_requested', adrText: '' }),
        baseContext,
        session,
      ),
    );
    expect(result.error).toBe(true);
    expect(result.code).toBe('REVIEW_FINDINGS_REQUIRED');
  });
});

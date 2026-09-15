/**
 * @module integration/review-dispatch-replay-guard.test
 * @description Blocker 3: an attempt whose durable dispatch outcome is still
 * unresolved must never be released to the host a second time. The pipeline
 * fails closed BEFORE any session.create/session.prompt.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../adapters/persistence.js', () => ({
  readState: vi.fn(),
  writeState: vi.fn(),
}));

vi.mock('./review/audit-events.js', () => ({
  appendReviewAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

import { readState } from '../adapters/persistence.js';
import { makeState } from '../fixtures.js';
import { runReviewOrchestration } from './plugin-orchestrator.js';
import type { OrchestratorDeps } from './plugin-orchestrator.js';
import { createTestAdapter } from './test-adapter-helper.js';
import { TOOL_FLOWGUARD_PLAN } from './tool-names.js';
import {
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
  artifactReviewSubjectScope,
  createAttemptForExistingObligation,
  createReviewObligation,
  ensureReviewAssurance,
  freezeReviewMaterial,
} from './review/assurance.js';
import { appendReviewDispatch } from '../state/review-dispatch.js';
import type { OrchestratorClient } from './review/types.js';
import type { SessionState } from '../state/schema.js';

const PARENT_SESSION_ID = 'parent-session-replay-guard';
const SESS_DIR = '/tmp/fg-replay-guard-test';
const NOW = '2026-05-10T12:00:00.000Z';

function reviewRequiredOutput(obligationId: string): string {
  return JSON.stringify({
    phase: 'PLAN',
    next: 'INDEPENDENT_REVIEW_REQUIRED: reviewer evidence is required',
    reviewObligation: {
      obligationId,
      iteration: 1,
      planVersion: 1,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      mandateDigest: REVIEW_MANDATE_DIGEST,
    },
  });
}

function buildInterruptedState(): SessionState {
  const obligation = createReviewObligation({
    obligationType: 'plan',
    iteration: 1,
    planVersion: 1,
    now: NOW,
    subjectDigest: 'subject-digest-replay',
    reviewMaterial: freezeReviewMaterial('frozen review material', 'subject-digest-replay'),
    reviewSubjectScope: artifactReviewSubjectScope('plan', '# Plan\nBody', 'subject-digest-replay'),
    repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
  });
  const withObligation = {
    ...ensureReviewAssurance(undefined),
    obligations: [obligation],
  };
  const minted = createAttemptForExistingObligation(withObligation, obligation, undefined, NOW, {
    origin: { kind: 'initial' },
    repositoryDiscovery: { kind: 'not_applicable' },
  });
  const assurance = appendReviewDispatch(minted.assurance, {
    dispatchId: '00000000-0000-4000-8000-0000000000d1',
    attemptId: minted.attempt.attemptId,
    obligationId: obligation.obligationId,
    hostCallId: 'child-session-interrupted',
    canonicalPromptDigest: 'c'.repeat(64),
    dispatchAuthorizedAt: NOW,
    dispatchStatus: 'authorized',
  });
  return makeState('PLAN', { reviewAssurance: assurance });
}

function buildDeps(client: OrchestratorClient): OrchestratorDeps {
  return {
    resolveFingerprint: vi.fn().mockResolvedValue('fingerprint-replay'),
    getSessionDir: vi.fn().mockReturnValue(SESS_DIR),
    updateReviewAssurance: vi.fn().mockResolvedValue(undefined),
    blockReviewOutcome: vi.fn().mockResolvedValue(undefined),
    getEnforcementState: vi.fn().mockReturnValue({ pendingReviews: new Map() }),
    log: { info: vi.fn(), warn: vi.fn() },
    client,
    adapter: createTestAdapter(client),
  };
}

describe('interrupted reviewer dispatch replay guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('BAD: refuses to release an attempt whose dispatch outcome is unresolved', async () => {
    const state = buildInterruptedState();
    vi.mocked(readState).mockResolvedValue(state);
    const client = {
      app: { agents: vi.fn().mockResolvedValue({ data: [{ id: 'flowguard-reviewer' }] }) },
      session: {
        create: vi.fn(),
        prompt: vi.fn(),
      },
    } as unknown as OrchestratorClient;
    const deps = buildDeps(client);
    const output = {
      output: reviewRequiredOutput(state.reviewAssurance!.obligations[0]!.obligationId),
    };

    await runReviewOrchestration(deps, {
      toolName: TOOL_FLOWGUARD_PLAN,
      input: {},
      output,
      sessionId: PARENT_SESSION_ID,
      now: NOW,
    });

    expect(client.session.create).not.toHaveBeenCalled();
    expect(client.session.prompt).not.toHaveBeenCalled();
    const parsed = JSON.parse(output.output) as { error?: boolean; code?: string };
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe('REVIEW_ATTEMPT_UNAVAILABLE');
  });
});

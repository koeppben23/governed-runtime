import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveNativeAttestation } from './invocation.js';
import {
  appendReviewerCapture,
  reviewerCapturePath,
} from '../../../adapters/persistence-reviewer-capture.js';
import type { ReviewerSubagentCapture } from '../../../state/evidence-reviewer-capture.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const OBLIGATION_A = '11111111-1111-4111-8111-111111111111';
const OBLIGATION_B = '22222222-2222-4222-8222-222222222222';
const PARENT_SESSION_ID = 'ses_parent';

function postToolUseCapture(
  overrides: Partial<ReviewerSubagentCapture> = {},
): ReviewerSubagentCapture {
  return {
    capturedAt: new Date().toISOString(),
    source: 'post_tool_use_hook',
    sessionId: PARENT_SESSION_ID,
    agentId: 'agent_abc123',
    agentType: 'flowguard-reviewer',
    toolName: 'mcp__flowguard__flowguard_review',
    reviewToolInvoked: true,
    obligationId: OBLIGATION_A,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// resolveNativeAttestation — the obligation-binding fold (manual -> native upgrade)
// ═══════════════════════════════════════════════════════════════════════════════

describe('resolveNativeAttestation', () => {
  let sessDir: string;

  beforeEach(async () => {
    sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-native-fold-'));
  });

  afterEach(async () => {
    await fs.rm(sessDir, { recursive: true, force: true });
  });

  function resolve(obligationId = OBLIGATION_A) {
    return resolveNativeAttestation({
      sessDir,
      obligationId,
      sessionId: PARENT_SESSION_ID,
    });
  }

  it('upgrades to native_subagent_attested when an obligation-bound reviewer capture exists', async () => {
    await appendReviewerCapture(sessDir, postToolUseCapture());

    const result = await resolve();

    expect(result.invocationMode).toBe('native_subagent_attested');
    expect(result.hostCapturedAgentId).toBe('agent_abc123');
    expect(result.hostCapturedAgentType).toBe('flowguard-reviewer');
    expect(result.hostCaptureSource).toBe('post_tool_use_hook');
    expect(result.rejection).toBeUndefined();
  });

  it('stays manual_attested when the capture is bound to a DIFFERENT obligation', async () => {
    await appendReviewerCapture(sessDir, postToolUseCapture({ obligationId: OBLIGATION_B }));

    const result = await resolve();

    expect(result.invocationMode).toBe('manual_attested');
    expect(result.hostCapturedAgentId).toBeUndefined();
    expect(result.rejection).toEqual({ reason: 'capture_unbound', obligationId: OBLIGATION_A });
  });

  it('stays manual_attested when no captures exist', async () => {
    const result = await resolve();

    expect(result.invocationMode).toBe('manual_attested');
    expect(result.rejection).toEqual({ reason: 'capture_missing', obligationId: OBLIGATION_A });
  });

  it('stays manual_attested for a SubagentStop-only capture (no obligation binding)', async () => {
    await appendReviewerCapture(sessDir, {
      capturedAt: new Date().toISOString(),
      source: 'subagent_stop_hook',
      sessionId: PARENT_SESSION_ID,
      agentId: 'agent_abc123',
      agentType: 'flowguard-reviewer',
      reviewToolInvoked: false,
    });

    const result = await resolve();

    expect(result.invocationMode).toBe('manual_attested');
    expect(result.rejection).toEqual({ reason: 'capture_unbound', obligationId: OBLIGATION_A });
  });

  it('stays manual_attested when reviewToolInvoked is false on a bound capture', async () => {
    // Persisted via raw write to bypass the writer's invariant; exercises the read-side guard.
    const line =
      JSON.stringify({
        capturedAt: new Date().toISOString(),
        source: 'post_tool_use_hook',
        sessionId: PARENT_SESSION_ID,
        agentId: 'agent_abc123',
        agentType: 'flowguard-reviewer',
        reviewToolInvoked: false,
        obligationId: OBLIGATION_A,
      }) + '\n';
    await fs.writeFile(reviewerCapturePath(sessDir), line, 'utf-8');

    const result = await resolve();

    expect(result.invocationMode).toBe('manual_attested');
    expect(result.rejection).toEqual({ reason: 'capture_unbound', obligationId: OBLIGATION_A });
  });

  it('ignores a forged non-reviewer agentType line (schema rejects it on read)', async () => {
    // A capture claiming a non-reviewer agent_type must never grant the upgrade. The
    // capture schema pins agentType to the reviewer literal, so such a line is dropped.
    const line =
      JSON.stringify({
        capturedAt: new Date().toISOString(),
        source: 'post_tool_use_hook',
        sessionId: PARENT_SESSION_ID,
        agentId: 'agent_forged',
        agentType: 'general-purpose',
        reviewToolInvoked: true,
        obligationId: OBLIGATION_A,
      }) + '\n';
    await fs.writeFile(reviewerCapturePath(sessDir), line, 'utf-8');

    const result = await resolve();

    expect(result.invocationMode).toBe('manual_attested');
    expect(result.rejection).toEqual({
      reason: 'capture_lines_skipped',
      obligationId: OBLIGATION_A,
    });
  });

  it('stays manual_attested when any capture line is skipped', async () => {
    await appendReviewerCapture(sessDir, postToolUseCapture());
    await fs.appendFile(reviewerCapturePath(sessDir), '{not-json}\n', 'utf-8');

    const result = await resolve();

    expect(result.invocationMode).toBe('manual_attested');
    expect(result.hostCapturedAgentId).toBeUndefined();
    expect(result.rejection).toEqual({
      reason: 'capture_lines_skipped',
      obligationId: OBLIGATION_A,
    });
  });

  it('stays manual_attested when bound capture belongs to a different sessionId', async () => {
    await appendReviewerCapture(sessDir, postToolUseCapture({ sessionId: 'ses_other' }));

    const result = await resolve();

    expect(result.invocationMode).toBe('manual_attested');
    expect(result.hostCapturedAgentId).toBeUndefined();
    expect(result.rejection).toEqual({
      reason: 'capture_session_mismatch',
      obligationId: OBLIGATION_A,
    });
  });

  it('upgrades when a bound reviewer capture is present among unrelated captures', async () => {
    await appendReviewerCapture(sessDir, postToolUseCapture({ obligationId: OBLIGATION_B }));
    await appendReviewerCapture(sessDir, postToolUseCapture({ obligationId: OBLIGATION_A }));

    const result = await resolve();

    expect(result.invocationMode).toBe('native_subagent_attested');
  });
});

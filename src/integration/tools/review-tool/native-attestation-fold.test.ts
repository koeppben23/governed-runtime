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

function postToolUseCapture(
  overrides: Partial<ReviewerSubagentCapture> = {},
): ReviewerSubagentCapture {
  return {
    capturedAt: new Date().toISOString(),
    source: 'post_tool_use_hook',
    sessionId: 'ses_parent',
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

  it('upgrades to native_subagent_attested when an obligation-bound reviewer capture exists', async () => {
    await appendReviewerCapture(sessDir, postToolUseCapture());

    const result = await resolveNativeAttestation({ sessDir, obligationId: OBLIGATION_A });

    expect(result.invocationMode).toBe('native_subagent_attested');
    expect(result.hostCapturedAgentId).toBe('agent_abc123');
    expect(result.hostCapturedAgentType).toBe('flowguard-reviewer');
    expect(result.hostCaptureSource).toBe('post_tool_use_hook');
  });

  it('stays manual_attested when the capture is bound to a DIFFERENT obligation', async () => {
    await appendReviewerCapture(sessDir, postToolUseCapture({ obligationId: OBLIGATION_B }));

    const result = await resolveNativeAttestation({ sessDir, obligationId: OBLIGATION_A });

    expect(result.invocationMode).toBe('manual_attested');
    expect(result.hostCapturedAgentId).toBeUndefined();
  });

  it('stays manual_attested when no captures exist', async () => {
    const result = await resolveNativeAttestation({ sessDir, obligationId: OBLIGATION_A });

    expect(result.invocationMode).toBe('manual_attested');
  });

  it('stays manual_attested for a SubagentStop-only capture (no obligation binding)', async () => {
    await appendReviewerCapture(sessDir, {
      capturedAt: new Date().toISOString(),
      source: 'subagent_stop_hook',
      sessionId: 'ses_parent',
      agentId: 'agent_abc123',
      agentType: 'flowguard-reviewer',
      reviewToolInvoked: false,
    });

    const result = await resolveNativeAttestation({ sessDir, obligationId: OBLIGATION_A });

    expect(result.invocationMode).toBe('manual_attested');
  });

  it('stays manual_attested when reviewToolInvoked is false on a bound capture', async () => {
    // Persisted via raw write to bypass the writer's invariant; exercises the read-side guard.
    const line =
      JSON.stringify({
        capturedAt: new Date().toISOString(),
        source: 'post_tool_use_hook',
        sessionId: 'ses_parent',
        agentId: 'agent_abc123',
        agentType: 'flowguard-reviewer',
        reviewToolInvoked: false,
        obligationId: OBLIGATION_A,
      }) + '\n';
    await fs.writeFile(reviewerCapturePath(sessDir), line, 'utf-8');

    const result = await resolveNativeAttestation({ sessDir, obligationId: OBLIGATION_A });

    expect(result.invocationMode).toBe('manual_attested');
  });

  it('ignores a forged non-reviewer agentType line (schema rejects it on read)', async () => {
    // A capture claiming a non-reviewer agent_type must never grant the upgrade. The
    // capture schema pins agentType to the reviewer literal, so such a line is dropped.
    const line =
      JSON.stringify({
        capturedAt: new Date().toISOString(),
        source: 'post_tool_use_hook',
        sessionId: 'ses_parent',
        agentId: 'agent_forged',
        agentType: 'general-purpose',
        reviewToolInvoked: true,
        obligationId: OBLIGATION_A,
      }) + '\n';
    await fs.writeFile(reviewerCapturePath(sessDir), line, 'utf-8');

    const result = await resolveNativeAttestation({ sessDir, obligationId: OBLIGATION_A });

    expect(result.invocationMode).toBe('manual_attested');
  });

  it('upgrades when a bound reviewer capture is present among unrelated captures', async () => {
    await appendReviewerCapture(sessDir, postToolUseCapture({ obligationId: OBLIGATION_B }));
    await appendReviewerCapture(sessDir, postToolUseCapture({ obligationId: OBLIGATION_A }));

    const result = await resolveNativeAttestation({ sessDir, obligationId: OBLIGATION_A });

    expect(result.invocationMode).toBe('native_subagent_attested');
  });
});

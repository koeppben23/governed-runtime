import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeReviewerCapture } from './shared/reviewer-capture-writer.js';
import { appendReviewerCapture } from '../adapters/persistence-reviewer-capture.js';

vi.mock('../adapters/persistence-reviewer-capture.js', () => ({
  appendReviewerCapture: vi.fn(),
}));

describe('reviewer-capture-writer', () => {
  beforeEach(() => {
    vi.mocked(appendReviewerCapture).mockReset();
  });

  it('surfaces stable hook-boundary diagnostics on capture write failure', async () => {
    vi.mocked(appendReviewerCapture).mockRejectedValueOnce(new Error('disk full'));
    const logs: string[] = [];

    const result = await writeReviewerCapture(
      '/workspace/session',
      {
        source: 'post_tool_use_hook',
        sessionId: 'ses_parent',
        agentId: 'agent_secret_should_not_log',
        agentType: 'flowguard-reviewer',
        toolName: 'mcp__flowguard__flowguard_review',
        reviewToolInvoked: true,
        obligationId: '11111111-1111-4111-8111-111111111111',
      },
      (msg) => logs.push(msg),
    );

    expect(result).toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('reviewer capture write failed');
    expect(logs[0]).toContain('"reason":"capture_write_failed"');
    expect(logs[0]).toContain('"source":"post_tool_use_hook"');
    expect(logs[0]).toContain('"obligationId":"11111111-1111-4111-8111-111111111111"');
    expect(logs[0]).not.toContain('agent_secret_should_not_log');
    expect(logs[0]).not.toContain('mcp__flowguard__flowguard_review');
  });
});

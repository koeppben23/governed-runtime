import { describe, expect, it, vi } from 'vitest';

const { recordAssuranceWithAudit } = vi.hoisted(() => ({ recordAssuranceWithAudit: vi.fn() }));

vi.mock('./review/shared-helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./review/shared-helpers.js')>()),
  recordAssuranceWithAudit,
}));

import { PluginWorkspaceImpl } from './plugin-workspace.js';

describe('PluginWorkspaceImpl blocked review output', () => {
  it('reports an audit persistence failure only when the assurance writer blocks the outcome', async () => {
    recordAssuranceWithAudit.mockResolvedValue({
      auditOk: false,
      block: true,
      reason: 'outbox unavailable',
    });
    const workspace = new PluginWorkspaceImpl({ auditWorktree: undefined });
    const output = { output: '' };

    await workspace.blockReviewOutcome(
      { sessDir: '/session', sessionId: 'session', phase: 'PLAN' },
      'obligation',
      'SUBAGENT_REVIEW_NOT_INVOKED',
      { reason: 'review was not started' },
      output,
    );

    expect(output.output).toContain('AUDIT_PERSISTENCE_FAILED');
    expect(output.output).toContain('outbox unavailable');
  });

  it('preserves the review block when an audit failure is not itself blocking', async () => {
    recordAssuranceWithAudit.mockResolvedValue({ auditOk: false, block: false });
    const workspace = new PluginWorkspaceImpl({ auditWorktree: undefined });
    const output = { output: '' };

    await workspace.blockReviewOutcome(
      { sessDir: '/session', sessionId: 'session', phase: 'PLAN' },
      'obligation',
      'SUBAGENT_REVIEW_NOT_INVOKED',
      { reason: 'review was not started' },
      output,
    );

    expect(output.output).toContain('SUBAGENT_REVIEW_NOT_INVOKED');
    expect(output.output).not.toContain('AUDIT_PERSISTENCE_FAILED');
  });
});

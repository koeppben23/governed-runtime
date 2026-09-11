import { describe, expect, it } from 'vitest';
import { defaultReasonRegistry } from './reasons.js';

describe('host-task schema rejection recovery', () => {
  it('requires a fresh FlowGuard-authorized repair attempt before re-running the reviewer Task', () => {
    const formatted = defaultReasonRegistry.format('ENVELOPE_SCHEMA_INVALID', {
      message: 'schema_invalid',
    });

    expect(formatted.reason).toContain('reviewer Task completed');
    expect(formatted.reason).toContain('canonical ReviewFindings schema validation');
    expect(formatted.recovery[0]).toContain('Re-run the originating FlowGuard command');
    expect(formatted.recovery[0]).toContain('fresh output-repair attempt');
    expect(formatted.recovery[1]).toContain('Only after that command returns INDEPENDENT_REVIEW_REQUIRED');
    expect(formatted.recovery[2]).toContain('Do not hand-edit');
  });
});

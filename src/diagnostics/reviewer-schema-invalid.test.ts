import { describe, expect, it } from 'vitest';
import { buildBlockedDiagnostics } from './builders.js';

describe('reviewer schema-invalid diagnostics', () => {
  it('does not misreport an executed reviewer Task as missing host-task evidence', () => {
    const diagnostic = buildBlockedDiagnostics('ENVELOPE_SCHEMA_INVALID', {
      policyMode: 'host_task_required',
      bindOutcome: 'schema_invalid',
      reviewerSubagentType: 'flowguard-reviewer',
      schemaErrors: 'nonBlockingIssues.designChallenges: unrecognized_keys',
    });

    expect(diagnostic).not.toBeNull();
    expect(diagnostic?.diagnosticCode).toBe('REVIEW_HOST_TASK_FINDINGS_SCHEMA_INVALID');
    expect(diagnostic?.diagnosticCode).not.toBe('REVIEW_HOST_TASK_EVIDENCE_MISSING');
    expect(diagnostic?.missingEvidence).toEqual(['schema_valid_review_findings']);
    expect(diagnostic?.safeNextActions[0]).toContain('Re-run the originating FlowGuard command');
  });
});

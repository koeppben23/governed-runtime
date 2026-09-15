import { describe, expect, it } from 'vitest';
import { buildBlockedDiagnostics } from './builders.js';

describe('reviewer schema-invalid diagnostics', () => {
  it('reports invalid reviewer output', () => {
    const diagnostic = buildBlockedDiagnostics('ENVELOPE_SCHEMA_INVALID', {
      policyMode: 'team',
      bindOutcome: 'schema_invalid',
      reviewerSubagentType: 'flowguard-reviewer',
      schemaErrors: 'nonBlockingIssues.designChallenges: unrecognized_keys',
    });

    expect(diagnostic).not.toBeNull();
    expect(diagnostic?.diagnosticCode).toBe('REVIEWER_FINDINGS_SCHEMA_INVALID');
    expect(diagnostic?.missingEvidence).toEqual(['schema_valid_review_findings']);
    expect(diagnostic?.safeNextActions[0]).toContain('Re-run the originating FlowGuard command');
  });
});

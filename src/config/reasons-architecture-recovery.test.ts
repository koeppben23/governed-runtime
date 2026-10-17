/**
 * @module config/reasons-architecture-recovery.test
 * @description The architecture ADR recovery guidance must name the exact call
 * forms that pass the call-shape gate. A live review loop showed that split
 * guidance (verdict alone vs body alone) cost three rejected calls per
 * revision: revisions require the verdict TOGETHER with the revised body and
 * claims, and never `title`.
 */
import { describe, expect, it } from 'vitest';
import { defaultReasonRegistry } from './reasons.js';

const INITIAL_FORM = 'flowguard_architecture({ title, adrText, claims })';
const REVISION_FORM =
  'flowguard_architecture({ reviewVerdict: "changes_requested", adrText, claims })';
const APPROVAL_FORM = 'flowguard_architecture({ reviewVerdict: "accept" })';

function stepsOf(code: string): string {
  const reason = defaultReasonRegistry.get(code);
  expect(reason, code).toBeDefined();
  return (reason?.recoverySteps ?? []).join('\n');
}

describe('architecture ADR recovery guidance names the working call forms', () => {
  it('ADR_SUBMISSION_MIXED_INPUTS names initial, revision and approval forms', () => {
    const steps = stepsOf('ADR_SUBMISSION_MIXED_INPUTS');
    expect(steps).toContain(INITIAL_FORM);
    expect(steps).toContain(REVISION_FORM);
    expect(steps).toContain('WITHOUT title');
    expect(steps).toContain(APPROVAL_FORM);
  });

  it('ADR_SUBMISSION_MIXED_INPUTS prohibits title+verdict, never body+verdict', () => {
    const reason = defaultReasonRegistry.get('ADR_SUBMISSION_MIXED_INPUTS');
    expect(reason?.messageTemplate).toContain('title');
    expect(reason?.messageTemplate).toContain('verdict');
    expect(reason?.messageTemplate?.toLowerCase()).not.toContain(
      'submission and verdict are separate calls',
    );
  });

  it('ADR_REVIEW_IN_PROGRESS names the revision and approval forms', () => {
    const steps = stepsOf('ADR_REVIEW_IN_PROGRESS');
    expect(steps).toContain(REVISION_FORM);
    expect(steps).toContain('WITHOUT title');
    expect(steps).toContain(APPROVAL_FORM);
  });

  it('EMPTY_ADR_TEXT names the revision call with the revised body', () => {
    const steps = stepsOf('EMPTY_ADR_TEXT');
    expect(steps).toContain(REVISION_FORM);
    expect(steps).toContain('WITHOUT title');
  });
});

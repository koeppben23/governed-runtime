/**
 * @module config/reasons-validation-observation.test
 * @description Registry contract for observation revision rejections: a
 * revision outside the obligation's offer is distinct from an obligation
 * without any frozen repository authority, and its recovery names the offered
 * revision(s) instead of declaring repository evidence unavailable.
 */

import { describe, expect, it } from 'vitest';

import { defaultReasonRegistry } from './reasons.js';

describe('REVIEW_OBSERVATION_REVISION_NOT_OFFERED', () => {
  const formatted = defaultReasonRegistry.format('REVIEW_OBSERVATION_REVISION_NOT_OFFERED', {
    revision: 'base',
    obligationId: 'obl_ctx',
    offeredRevisions: '"head"',
  });

  it('names the rejected and the offered revisions with no unresolved placeholder', () => {
    expect(formatted.code).toBe('REVIEW_OBSERVATION_REVISION_NOT_OFFERED');
    expect(formatted.reason).toBe(
      'Revision base is not offered for repository observation by obligation obl_ctx; offered revision(s): "head".',
    );
    for (const step of formatted.recovery) expect(step).not.toContain('{');
    expect(formatted.recovery[0]).toContain('offered revision ("head")');
  });

  it('never declares repository evidence unavailable for the offered revisions', () => {
    const text = [formatted.reason, ...formatted.recovery].join('\n');
    expect(text).toContain('it is not evidence that the offered revision(s) are unavailable');
    expect(text).not.toContain('carries no frozen repository authority');
  });

  it('keeps AUTHORITY_UNAVAILABLE for obligations without any authority', () => {
    const unavailable = defaultReasonRegistry.format('REVIEW_OBSERVATION_AUTHORITY_UNAVAILABLE', {
      revision: 'head',
      obligationId: 'obl_none',
    });
    expect(unavailable.recovery[0]).toContain('carries no frozen repository authority');
  });
});

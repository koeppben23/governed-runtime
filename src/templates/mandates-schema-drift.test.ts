/**
 * @module templates/mandates-schema-drift.test
 * @description Build-time guard: REVIEWER_AGENT template schema MUST require the
 * same attestation fields as the runtime ReviewAttestation Zod schema.
 *
 * Prevents B1-class regressions: a template that omits attestation fields
 * causes guaranteed SUBAGENT_MANDATE_MISSING failures on the strict path.
 */

import { describe, expect, it } from 'vitest';

import { REVIEWER_AGENT } from './mandates.js';

const REQUIRED_ATTESTATION_FIELDS = [
  'mandateDigest',
  'criteriaVersion',
  'toolObligationId',
  'iteration',
  'planVersion',
  'reviewedBy',
] as const;

describe('REVIEWER_AGENT template: schema integrity (B1)', () => {
  it('contains an attestation block in the output schema', () => {
    expect(REVIEWER_AGENT).toContain('"attestation"');
  });

  for (const field of REQUIRED_ATTESTATION_FIELDS) {
    it(`attestation block instructs the reviewer to set ${field}`, () => {
      // The template schema must mention every attestation field that
      // ReviewAttestation (state/evidence.ts) declares as required.
      expect(REVIEWER_AGENT).toMatch(new RegExp(`"${field}"`));
    });
  }

  it('binds attestation.reviewedBy to the literal "flowguard-reviewer"', () => {
    expect(REVIEWER_AGENT).toMatch(/"reviewedBy":\s*"flowguard-reviewer"/);
  });

  it('does not instruct the subagent to use the literal "subagent" as sessionId (B3)', () => {
    expect(REVIEWER_AGENT).not.toMatch(/otherwise\s+'subagent'/);
  });
});

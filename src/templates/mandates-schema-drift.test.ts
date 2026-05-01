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

  it('output-schema overallVerdict enum lists all three LoopVerdict values (P1.3 slice 3)', () => {
    // Drift guard: the JSON shape in REVIEWER_AGENT must list the same
    // three values that LoopVerdict (src/state/evidence.ts:72) and the
    // SDK structured-output JSON-Schema (src/integration/review-orchestrator.ts:47)
    // accept. If a future edit drops one, the reviewer subagent and the
    // runtime would disagree on what verdicts are emittable.
    expect(REVIEWER_AGENT).toMatch(
      /"overallVerdict":\s*"approve"\s*\|\s*"changes_requested"\s*\|\s*"unable_to_review"/,
    );
  });

  it('documents the unable_to_review validity-conditions whitelist (P1.3 slice 3)', () => {
    // The mandate must spell out the validity conditions, not just allow
    // the value. Without these conditions the third verdict becomes an
    // evasion route for substantive findings.
    expect(REVIEWER_AGENT).toMatch(/When You Cannot Review/);
    expect(REVIEWER_AGENT).toMatch(/empty or unparseable/i);
    expect(REVIEWER_AGENT).toMatch(/required context is missing/i);
    expect(REVIEWER_AGENT).toMatch(/structured-output schema/i);
    expect(REVIEWER_AGENT).toMatch(/mandate digest/i);
    expect(REVIEWER_AGENT).toMatch(/NOT an evasion route/);
  });

  it('Rules section forbids using unable_to_review for substantive findings (P1.3 slice 3)', () => {
    // Anti-fabrication rail. The Rules section must explicitly forbid
    // using the third verdict to dodge producing changes_requested.
    expect(REVIEWER_AGENT).toMatch(
      /Do NOT use "unable_to_review" to avoid producing substantive findings/,
    );
  });
});

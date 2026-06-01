/**
 * @module templates/commands/discovery-review-parity.test
 * @description Item 2 guard: the plan, implement, and architecture review
 * command templates MUST instruct Discovery-context capture (health/drift/
 * detectedStack/verificationCandidates), pass that context to the reviewer
 * subagent, and require NOT_VERIFIED correlation — parity with /review.
 *
 * Discovery context is advisory falsification evidence, NEVER review verdict
 * authority.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 */

import { describe, expect, it } from 'vitest';
import { PLAN_COMMAND } from './plan.js';
import { IMPLEMENT_COMMAND } from './implement.js';
import { ARCHITECTURE_COMMAND } from './architecture.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../shared/flowguard-identifiers.js';

const TEMPLATES: ReadonlyArray<readonly [string, string]> = [
  ['plan', PLAN_COMMAND],
  ['implement', IMPLEMENT_COMMAND],
  ['architecture', ARCHITECTURE_COMMAND],
];

describe('templates/commands Discovery review parity (Item 2)', () => {
  for (const [name, template] of TEMPLATES) {
    describe(`${name} template`, () => {
      // HAPPY — Discovery context is captured as required review evidence.
      it('captures compact Discovery context from flowguard_status', () => {
        expect(template).toContain('Capture the compact Discovery context');
        expect(template).toContain('verificationCandidates');
        expect(template).toContain('detectedStack');
      });

      // HAPPY — Discovery context is passed to the reviewer subagent.
      it('passes Discovery context to the reviewer subagent', () => {
        expect(template).toContain(REVIEWER_SUBAGENT_TYPE);
        expect(template).toMatch(/Pass the compact Discovery context captured in Phase 1/);
      });

      // BAD — unverifiable Discovery yields NOT_VERIFIED, never invented truth.
      it('marks Discovery-dependent claims NOT_VERIFIED and forbids inventing truth', () => {
        expect(template).toContain('NOT_VERIFIED');
        expect(template).toContain('do not invent repository truth');
      });

      // CORNER — subagent must check Discovery BEFORE repo-dependent claims.
      it('instructs the subagent to check health/drift before repo-dependent claims', () => {
        expect(template).toMatch(
          /check Discovery health and drift BEFORE any repo-dependent quality claim/,
        );
        expect(template).toMatch(
          /cannot be correlated to local repository Discovery/,
        );
      });

      // EDGE — Discovery is evidence, not verdict authority.
      it('states Discovery context is advisory, NOT review verdict authority', () => {
        expect(template).toMatch(/advisory[\s\S]*NOT review verdict[\s\S]*authority/);
        expect(template).toContain('ReviewFindings');
      });

      // EDGE — Done-when enforces the Discovery checks.
      it('Done-when requires Discovery health/drift and correlation checks', () => {
        expect(template).toContain(
          'Discovery health and drift checked before repo-dependent quality claims',
        );
        expect(template).toMatch(
          /marked NOT_VERIFIED when they could not be correlated to local Discovery/,
        );
      });
    });
  }
});

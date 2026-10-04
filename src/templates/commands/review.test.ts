/**
 * @module templates/commands/review.test
 * @description #401 guard: standalone /review command template MUST require
 * Discovery context (health + drift) and NOT_VERIFIED correlation for PR/content
 * review. Discovery context is advisory evidence, never review verdict authority.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 */

import { describe, expect, it } from 'vitest';
import { REVIEW_COMMAND } from './review.js';

describe('templates/commands/review (#401 Discovery context)', () => {
  // HAPPY — Discovery context is required review evidence
  describe('HAPPY — requires Discovery context', () => {
    it('captures compact Discovery context from flowguard_status', () => {
      expect(REVIEW_COMMAND).toContain('Capture the compact Discovery context');
      expect(REVIEW_COMMAND).toContain('verificationCandidates');
      expect(REVIEW_COMMAND).toContain('detectedStack');
    });

    it('requires checking Discovery health AND drift before repo-dependent claims', () => {
      expect(REVIEW_COMMAND).toMatch(/Discovery health.*drift/);
      expect(REVIEW_COMMAND).toContain('repo-dependent quality claim');
    });

    it('requires the native Task transport and keeps findings bound by FlowGuard', () => {
      expect(REVIEW_COMMAND).toContain('reviewInvocation.action === "call_task"');
      expect(REVIEW_COMMAND).toContain('subagent_type: "flowguard-reviewer"');
      expect(REVIEW_COMMAND).toContain('Do not submit, copy, or alter `reviewFindings`');
    });
  });

  // BAD — NOT_VERIFIED when content cannot be correlated to local Discovery
  describe('BAD — NOT_VERIFIED correlation rule', () => {
    it('marks Discovery-dependent claims NOT_VERIFIED when correlation fails', () => {
      expect(REVIEW_COMMAND).toContain('NOT_VERIFIED');
      expect(REVIEW_COMMAND).toMatch(/could not be\s+correlated to local Discovery/);
    });

    it('does not invent repository truth when Discovery is unavailable/degraded/drifted', () => {
      expect(REVIEW_COMMAND).toContain('do not invent repository truth');
      expect(REVIEW_COMMAND).toMatch(/unavailable, degraded, drifted/);
    });
  });

  // CORNER — generic verification suggestions are a defect when candidates exist
  describe('CORNER — generic-vs-repo-native verification', () => {
    it('flags generic commands when repo-native candidates exist', () => {
      expect(REVIEW_COMMAND).toContain(
        'Were generic commands suggested despite specific repo-native candidates existing?',
      );
      expect(REVIEW_COMMAND).toMatch(/flag this as a defect/);
    });

    it('flags repo-dependent claims made without checking Discovery health/drift', () => {
      expect(REVIEW_COMMAND).toMatch(
        /repo-dependent claims are made without checking Discovery health\/drift/,
      );
    });
  });

  // EDGE — Discovery context is evidence, not verdict authority
  describe('EDGE — evidence, not verdict authority', () => {
    it('states Discovery context is advisory evidence, not verdict authority', () => {
      expect(REVIEW_COMMAND).toMatch(/advisory[\s\S]*NOT review verdict[\s\S]*authority/);
      expect(REVIEW_COMMAND).toContain('host-observed structured reviewer invocation evidence');
      expect(REVIEW_COMMAND).not.toMatch(/attestation remain the review authority/);
    });

    it('Done-when requires Discovery health/drift and correlation checks', () => {
      expect(REVIEW_COMMAND).toContain(
        'Discovery health and drift checked before repo-dependent quality claims.',
      );
      expect(REVIEW_COMMAND).toMatch(
        /marked NOT_VERIFIED when content could not be correlated to local Discovery/,
      );
    });
  });

  describe('HAPPY — review continuation', () => {
    it('keeps branch materialization inside FlowGuard', () => {
      expect(REVIEW_COMMAND).toContain('never run `git diff`');
      expect(REVIEW_COMMAND).not.toContain('git diff <base>...<branch>');
    });

    it('requires obligation-id completion after FlowGuard binds evidence', () => {
      expect(REVIEW_COMMAND).toContain('Do not submit, copy, or alter `reviewFindings`');
      expect(REVIEW_COMMAND).toContain('flowguard_review({ reviewObligationId })');
      expect(REVIEW_COMMAND).not.toContain('reviewVerdict');
    });
  });
});

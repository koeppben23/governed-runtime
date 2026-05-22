/**
 * @file plugin-host-task-diagnostics-helpers.test.ts
 * @description Unit tests for plugin-host-task-diagnostics-helpers.ts factories.
 *
 * Covers modeAResponse, validPrompt, taskResultWithAttestation, pendingObligation,
 * setupFullCycle. All functions are pure builders — no mocking needed.
 *
 * @version v1
 */

import { describe, it, expect } from 'vitest';
import {
  modeAResponse,
  validPrompt,
  taskResultWithAttestation,
  pendingObligation,
  setupFullCycle,
  NOW,
  SESSION_ID,
  CHILD_SESSION_ID,
} from './plugin-host-task-diagnostics-helpers.js';
import { REVIEWER_SUBAGENT_TYPE } from './review/enforcement/types.js';

// ═══════════════════════════════════════════════════════════════════════════════

describe('modeAResponse', () => {
  describe('GOOD', () => {
    it('produces valid JSON with correct iteration and planVersion', () => {
      const json = modeAResponse(2, 3);
      const parsed = JSON.parse(json);

      expect(parsed.phase).toBe('PLAN');
      expect(parsed.selfReviewIteration).toBe(2);
      expect(parsed.reviewMode).toBe('subagent');
      expect(parsed.next).toContain('iteration=2');
      expect(parsed.next).toContain('planVersion=3');
      expect(parsed.next).toContain('flowguard-reviewer');
    });

    it('defaults to iteration=0 and planVersion=1', () => {
      const parsed = JSON.parse(modeAResponse());
      expect(parsed.selfReviewIteration).toBe(0);
      expect(parsed.next).toContain('planVersion=1');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════

describe('validPrompt', () => {
  describe('GOOD', () => {
    it('meets minimum length requirement', () => {
      const prompt = validPrompt(1, 2);
      expect(prompt.length).toBeGreaterThan(100);
    });

    it('includes iteration and planVersion in prompt text', () => {
      const prompt = validPrompt(3, 5);
      expect(prompt).toContain('iteration=3');
      expect(prompt).toContain('planVersion=5');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════

describe('taskResultWithAttestation', () => {
  describe('GOOD', () => {
    it('returns valid JSON with correct obligationId in attestation', () => {
      const json = taskResultWithAttestation('obl-42');
      const parsed = JSON.parse(json);

      expect(parsed.overallVerdict).toBe('approve');
      expect(parsed.reviewMode).toBe('subagent');
      expect(parsed.attestation.toolObligationId).toBe('obl-42');
      expect(parsed.attestation.reviewedBy).toBe(REVIEWER_SUBAGENT_TYPE);
      expect(parsed.reviewedBy.sessionId).toBe(CHILD_SESSION_ID);
      expect(parsed.iteration).toBe(0);
      expect(parsed.planVersion).toBe(1);
    });
  });

  describe('CORNER', () => {
    it('accepts verdict override for changes_requested', () => {
      const json = taskResultWithAttestation('obl-1', { verdict: 'changes_requested' });
      const parsed = JSON.parse(json);
      expect(parsed.overallVerdict).toBe('changes_requested');
    });

    it('accepts custom childSessionId override', () => {
      const json = taskResultWithAttestation('obl-1', { childSessionId: 'custom-child' });
      const parsed = JSON.parse(json);
      expect(parsed.reviewedBy.sessionId).toBe('custom-child');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════

describe('pendingObligation', () => {
  describe('GOOD', () => {
    it('creates plan obligation with default iteration and planVersion', () => {
      const obl = pendingObligation();
      expect(obl.obligationType).toBe('plan');
      expect(obl.iteration).toBe(0);
      expect(obl.planVersion).toBe(1);
      expect(obl.obligationId).toBeDefined();
    });
  });

  describe('CORNER', () => {
    it('accepts partial overrides while preserving defaults', () => {
      const obl = pendingObligation({ iteration: 3 });
      expect(obl.iteration).toBe(3);
      expect(obl.planVersion).toBe(1);
      expect(obl.obligationType).toBe('plan');
    });

    it('accepts full overrides', () => {
      const obl = pendingObligation({ iteration: 5, planVersion: 10, obligationId: 'custom-id' });
      expect(obl.iteration).toBe(5);
      expect(obl.planVersion).toBe(10);
      expect(obl.obligationId).toBe('custom-id');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════

describe('setupFullCycle', () => {
  describe('GOOD', () => {
    it('produces enforcement state with invocations', () => {
      const { state, obligation } = setupFullCycle();

      expect(obligation.obligationType).toBe('plan');
      expect(state).toBeDefined();
    });

    it('respects custom obligationId override', () => {
      const { obligation } = setupFullCycle({ obligationId: 'my-custom-obl' });
      expect(obligation.obligationId).toBe('my-custom-obl');
    });
  });

  describe('CORNER', () => {
    it('passes iteration and planVersion through to obligation and task result', () => {
      const { obligation } = setupFullCycle({ iteration: 2, planVersion: 4 });
      expect(obligation.iteration).toBe(2);
      expect(obligation.planVersion).toBe(4);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════

describe('constants', () => {
  it('NOW is an ISO timestamp string', () => {
    expect(NOW).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('SESSION_ID and CHILD_SESSION_ID are distinct', () => {
    expect(SESSION_ID).not.toBe(CHILD_SESSION_ID);
  });
});

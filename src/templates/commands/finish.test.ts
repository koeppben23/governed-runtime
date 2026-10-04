/**
 * @module templates/commands/finish.test
 * @description #520 guard: the /finish command template MUST call
 * flowguard_status with { finish: true }, render read-only, and make the
 * non-approval / non-mutation guarantees explicit. It must never approve,
 * trigger /export, or render an exit option (abandon) as forbidden.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 */

import { describe, expect, it } from 'vitest';
import { FINISH_COMMAND } from './finish.js';

describe('templates/commands/finish (#520 Finish Card)', () => {
  // HAPPY — calls the read-only status tool with the finish projection
  describe('HAPPY — read-only status aggregation', () => {
    it('calls flowguard_status with { finish: true }', () => {
      expect(FINISH_COMMAND).toContain('flowguard_status');
      expect(FINISH_COMMAND).toContain('{ finish: true }');
    });

    it('declares itself read-only and a status aggregator, not approval', () => {
      expect(FINISH_COMMAND).toContain('read-only');
      expect(FINISH_COMMAND).toMatch(/status aggregator/i);
    });

    it('has canonical command structure (Goal / Governance rules / Done-when)', () => {
      expect(FINISH_COMMAND).toContain('## Goal');
      expect(FINISH_COMMAND).toContain('## Governance rules');
      expect(FINISH_COMMAND).toContain('## Done-when');
    });
  });

  // BAD — must never approve, mutate, or trigger export
  describe('BAD — non-approval / non-mutation guarantees', () => {
    it('forbids approval, obligation consumption, and triggering export', () => {
      expect(FINISH_COMMAND).toMatch(/[Nn]ever approve/);
      expect(FINISH_COMMAND).toMatch(/never consume obligations/);
      expect(FINISH_COMMAND).toMatch(/never trigger \/export/i);
    });

    it('states action guidance labels are presentation-only, not permission', () => {
      expect(FINISH_COMMAND).toMatch(/presentation-only/i);
      expect(FINISH_COMMAND).toMatch(/NOT approvals/i);
    });
  });

  // CORNER — no-session path
  describe('CORNER — no session', () => {
    it('recommends /hydrate when no session exists', () => {
      expect(FINISH_COMMAND).toContain('/hydrate');
    });
  });

  // EDGE — exit options are never forbidden
  describe('EDGE — exit options', () => {
    it('never renders an exit option (abandon) as forbidden', () => {
      expect(FINISH_COMMAND).toMatch(/[Nn]ever render an exit option/);
    });
  });
});

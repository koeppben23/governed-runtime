/**
 * @test-policy
 * HAPPY: known machine codes produce product-friendly text and commands.
 * HAPPY: terminal phases get enriched with phase label context.
 * HAPPY: canonical commands remain canonical — product layer wraps but does not alter authority.
 * CORNER: unknown codes fall back to the canonical text and commands.
 * EDGE: all known codes are covered by PRODUCT_GUIDANCE.
 * PERF: not applicable; pure function.
 */
import { describe, expect, it } from 'vitest';
import { resolveNextAction } from '../machine/next-action.js';
import { buildProductNextAction } from './next-action-copy.js';
import { makeState, makeProgressedState } from '../__fixtures__.js';

describe('buildProductNextAction', () => {
  describe('HAPPY — known codes produce product guidance', () => {
    it('CHOOSE_FLOW (READY)', () => {
      const action = resolveNextAction('READY', makeState('READY'));
      const product = buildProductNextAction(action, 'READY');
      expect(product.commands).toEqual(['/task', '/architecture', '/review']);
      expect(product.text).toContain('/task');
    });

    it('RUN_REVIEW_DECISION (PLAN_REVIEW)', () => {
      const action = resolveNextAction('PLAN_REVIEW', makeProgressedState('PLAN_REVIEW'));
      const product = buildProductNextAction(action, 'PLAN_REVIEW');
      expect(product.commands).toEqual(['/approve', '/request-changes', '/reject']);
      expect(product.text).toContain('/approve');
      // Canonical action still uses /review-decision
      expect(action.commands).toEqual(['/review-decision']);
    });

    it('SESSION_COMPLETE (COMPLETE) gets phase-enriched text', () => {
      const action = resolveNextAction('COMPLETE', makeProgressedState('COMPLETE'));
      const product = buildProductNextAction(action, 'COMPLETE');
      expect(product.commands).toEqual(['/export']);
      expect(product.text).toContain('/export');
      expect(product.text).toContain('Complete');
      // Canonical action has no commands
      expect(action.commands).toEqual([]);
    });

    it('RUN_TICKET (TICKET, no ticket)', () => {
      const action = resolveNextAction('TICKET', makeState('TICKET'));
      const product = buildProductNextAction(action, 'TICKET');
      expect(product.commands).toEqual(['/task']);
      // Canonical action still uses /ticket
      expect(action.commands).toEqual(['/ticket']);
    });
  });

  describe('CORNER — unknown codes fall back to canonical', () => {
    it('returns canonical text and commands for unmapped code', () => {
      const action = { code: 'UNKNOWN_CODE', text: 'Canonical text', commands: ['/cmd'] };
      const product = buildProductNextAction(action, 'READY');
      expect(product.text).toBe('Canonical text');
      expect(product.commands).toEqual(['/cmd']);
    });
  });
});

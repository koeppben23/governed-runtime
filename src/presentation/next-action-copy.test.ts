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
import { makeState, makeProgressedState } from '../fixtures.js';

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

    it('SESSION_COMPLETE aborted → redirects to executable read-only /status', () => {
      const action = resolveNextAction('COMPLETE', makeProgressedState('COMPLETE'));
      const product = buildProductNextAction(action, 'COMPLETE', true);
      // An aborted session must not be guided toward /export as a verifiable
      // audit package — it is not a clean completion.
      expect(product.commands).toEqual(['/status']);
      expect(product.text.toLowerCase()).toContain('aborted');
      expect(product.text).toContain('/status');
      expect(product.text).not.toContain('/export');
      expect(product.text).not.toContain('/finish');
      expect(product.text).not.toContain('/review');
    });

    it('SESSION_COMPLETE non-aborted default is unchanged (clean completion)', () => {
      const action = resolveNextAction('COMPLETE', makeProgressedState('COMPLETE'));
      // Explicit aborted=false behaves exactly like the 2-arg call.
      expect(buildProductNextAction(action, 'COMPLETE', false)).toEqual(
        buildProductNextAction(action, 'COMPLETE'),
      );
    });

    it('SESSION_COMPLETE verified archive does not recommend exporting again', () => {
      const action = resolveNextAction('REVIEW_COMPLETE', makeProgressedState('REVIEW_COMPLETE'));
      const product = buildProductNextAction(action, 'REVIEW_COMPLETE', false, 'verified');
      expect(product.commands).toEqual(['/status']);
      expect(product.text).toContain('verified');
      expect(product.text).not.toContain('/export');
    });

    it('SESSION_COMPLETE failed archive surfaces recovery', () => {
      const action = resolveNextAction('COMPLETE', makeProgressedState('COMPLETE'));
      const product = buildProductNextAction(action, 'COMPLETE', false, 'failed');
      expect(product.commands).toEqual(['/status', '/export']);
      expect(product.text).toContain('failed');
    });

    it('RUN_TICKET (TICKET, no ticket)', () => {
      const action = resolveNextAction('TICKET', makeState('TICKET'));
      const product = buildProductNextAction(action, 'TICKET');
      expect(product.commands).toEqual(['/task']);
      // Canonical action still uses /ticket
      expect(action.commands).toEqual(['/ticket']);
    });

    it('RUN_PLAN (TICKET, ticket captured)', () => {
      const state = makeState('TICKET', {
        ticket: {
          text: 'Fix bug',
          digest: 'ticket-digest',
          source: 'user',
          createdAt: new Date().toISOString(),
        },
      });
      const action = resolveNextAction('TICKET', state);
      const product = buildProductNextAction(action, 'TICKET');
      expect(product.commands).toEqual(['/plan']);
    });

    it('SESSION_COMPLETE (ARCH_COMPLETE) gets phase-enriched text', () => {
      const action = resolveNextAction('ARCH_COMPLETE', makeProgressedState('ARCH_COMPLETE'));
      const product = buildProductNextAction(action, 'ARCH_COMPLETE');
      expect(product.commands).toEqual(['/export']);
      expect(product.text).toContain('Architecture complete');
    });

    it('SESSION_COMPLETE (REVIEW_COMPLETE) gets phase-enriched text', () => {
      const action = resolveNextAction('REVIEW_COMPLETE', makeProgressedState('REVIEW_COMPLETE'));
      const product = buildProductNextAction(action, 'REVIEW_COMPLETE');
      expect(product.commands).toEqual(['/export']);
      expect(product.text).toContain('Review complete');
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

  describe('MUTATION_KILL — exact PRODUCT_GUIDANCE values', () => {
    it('CHOOSE_FLOW text and commands are exact', () => {
      const action = { code: 'CHOOSE_FLOW', text: '', commands: [] as string[] };
      const product = buildProductNextAction(action, 'READY');
      expect(product.text).toBe(
        'Choose your workflow: /task (development), /architecture (ADR), /review (compliance).',
      );
      expect(product.commands).toEqual(['/task', '/architecture', '/review']);
    });

    it('RUN_TICKET text and commands are exact', () => {
      const action = { code: 'RUN_TICKET', text: '', commands: [] as string[] };
      const product = buildProductNextAction(action, 'TICKET');
      expect(product.text).toBe('Describe your governed task with /task');
      expect(product.commands).toEqual(['/task']);
    });

    it('RUN_PLAN text and commands are exact', () => {
      const action = { code: 'RUN_PLAN', text: '', commands: [] as string[] };
      const product = buildProductNextAction(action, 'PLAN');
      expect(product.text).toBe('Task captured. Generate an implementation plan with /plan');
      expect(product.commands).toEqual(['/plan']);
    });

    it('RUN_REVIEW_DECISION text and commands are exact', () => {
      const action = { code: 'RUN_REVIEW_DECISION', text: '', commands: [] as string[] };
      const product = buildProductNextAction(action, 'PLAN_REVIEW');
      expect(product.text).toBe(
        'Review gate active. Run /approve to accept, /request-changes to revise, or /reject to discard.',
      );
      expect(product.commands).toEqual(['/approve', '/request-changes', '/reject']);
    });

    it('RUN_VALIDATE text and commands are exact', () => {
      const action = { code: 'RUN_VALIDATE', text: '', commands: [] as string[] };
      const product = buildProductNextAction(action, 'VALIDATION');
      expect(product.text).toBe('Run validation checks with /check');
      expect(product.commands).toEqual(['/check']);
    });

    it('RUN_CONTINUE text and commands are exact', () => {
      const action = { code: 'RUN_CONTINUE', text: '', commands: [] as string[] };
      const product = buildProductNextAction(action, 'PLAN');
      expect(product.text).toBe('Run /continue to proceed');
      expect(product.commands).toEqual(['/continue']);
    });

    it('RUN_IMPLEMENT text and commands are exact', () => {
      const action = { code: 'RUN_IMPLEMENT', text: '', commands: [] as string[] };
      const product = buildProductNextAction(action, 'IMPLEMENTATION');
      expect(product.text).toBe('Execute the approved plan with /implement');
      expect(product.commands).toEqual(['/implement']);
    });

    it('SESSION_COMPLETE text enriched with phase label', () => {
      const action = { code: 'SESSION_COMPLETE', text: '', commands: [] as string[] };
      const product = buildProductNextAction(action, 'COMPLETE');
      expect(product.text).toContain('Complete.');
      expect(product.text).toContain('/export');
      expect(product.text).toContain('redactionMode');
      expect(product.text).toContain('includeRaw');
      expect(product.commands).toEqual(['/export']);
    });

    it('RUN_ARCHITECTURE text and commands are exact', () => {
      const action = { code: 'RUN_ARCHITECTURE', text: '', commands: [] as string[] };
      const product = buildProductNextAction(action, 'ARCHITECTURE');
      expect(product.text).toBe('Submit your Architecture Decision Record with /architecture');
      expect(product.commands).toEqual(['/architecture']);
    });
  });
});

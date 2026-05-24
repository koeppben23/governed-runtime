/**
 * @module evidence-ticket.test
 * @description Tests for evidence-ticket module.
 * Extracted from evidence-split.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { TicketEvidence } from './evidence-ticket.js';
import { FIXED_TIME } from './evidence-test-constants.js';

describe('evidence-ticket', () => {
  describe('HAPPY', () => {
    it('TicketEvidence parses minimal ticket', () => {
      const ticket = {
        text: 'Fix the auth bug',
        digest: 'abc123',
        source: 'user',
        createdAt: FIXED_TIME,
      };
      expect(TicketEvidence.parse(ticket)).toEqual(ticket);
    });

    it('TicketEvidence parses ticket with references', () => {
      const ticket = {
        text: 'Implement feature X',
        digest: 'def456',
        source: 'external' as const,
        createdAt: FIXED_TIME,
        inputOrigin: 'external_reference' as const,
        references: [{ ref: 'https://github.com/org/repo/issues/1' }],
      };
      expect(TicketEvidence.parse(ticket)).toEqual(ticket);
    });
  });

  describe('BAD', () => {
    it('TicketEvidence rejects empty text', () => {
      expect(() =>
        TicketEvidence.parse({
          text: '',
          digest: 'abc',
          source: 'user',
          createdAt: FIXED_TIME,
        }),
      ).toThrow();
    });

    it('TicketEvidence rejects invalid source', () => {
      expect(() =>
        TicketEvidence.parse({
          text: 'Fix bug',
          digest: 'abc',
          source: 'unknown',
          createdAt: FIXED_TIME,
        }),
      ).toThrow();
    });
  });

  describe('CORNER', () => {
    it('TicketEvidence source must be user or external', () => {
      const ticket = { text: 'Test', digest: 'abc', source: 'user', createdAt: FIXED_TIME };
      expect(() => TicketEvidence.parse({ ...ticket, source: 'user' })).not.toThrow();
      expect(() => TicketEvidence.parse({ ...ticket, source: 'external' })).not.toThrow();
    });
  });
});

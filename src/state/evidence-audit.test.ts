/**
 * @module evidence-audit.test
 * @description Tests for evidence-audit module.
 * Extracted from evidence-split.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { AuditEvent } from './evidence-audit.js';
import { FIXED_TIME, FIXED_UUID } from './evidence-test-constants.js';

describe('evidence-audit', () => {
  describe('HAPPY', () => {
    it('AuditEvent parses valid event', () => {
      const event = {
        id: FIXED_UUID,
        sessionId: 'ses_test123',
        phase: 'TICKET',
        event: 'tool_call:flowguard_ticket',
        timestamp: FIXED_TIME,
        actor: 'human',
        detail: { tool: 'flowguard_ticket' },
      };
      expect(AuditEvent.parse(event)).toEqual(event);
    });

    it('AuditEvent parses event with actorInfo', () => {
      const event = {
        id: FIXED_UUID,
        sessionId: 'ses_test123',
        phase: 'PLAN_REVIEW',
        event: 'decision:approve',
        timestamp: FIXED_TIME,
        actor: 'human',
        detail: { verdict: 'approve' },
        actorInfo: {
          id: 'user-1',
          email: 'user@example.com',
          source: 'env' as const,
        },
      };
      const parsed = AuditEvent.parse(event);
      expect(parsed.actor).toBe('human');
      expect(parsed.actorInfo?.id).toBe('user-1');
      expect(parsed.actorInfo?.email).toBe('user@example.com');
      expect(parsed.actorInfo?.assurance).toBe('best_effort');
    });

    it('AuditEvent parses event with hash chain fields', () => {
      const event = {
        id: FIXED_UUID,
        sessionId: 'ses_test123',
        phase: 'TICKET',
        event: 'lifecycle:session_created',
        timestamp: FIXED_TIME,
        actor: 'system',
        detail: {},
        prevHash: 'genesis',
        chainHash: 'sha256-chain',
      };
      expect(AuditEvent.parse(event)).toEqual(event);
    });
  });

  describe('BAD', () => {
    it('AuditEvent rejects unsafe session IDs', () => {
      expect(() =>
        AuditEvent.parse({
          id: FIXED_UUID,
          sessionId: 'bad/session',
          phase: 'TICKET',
          event: 'test',
          timestamp: FIXED_TIME,
          actor: 'system',
          detail: {},
        }),
      ).toThrow();
    });

    it('AuditEvent rejects missing id', () => {
      expect(() =>
        AuditEvent.parse({
          sessionId: 'ses_test',
          phase: 'TICKET',
          event: 'test',
          timestamp: FIXED_TIME,
          actor: 'system',
          detail: {},
        }),
      ).toThrow();
    });
  });

  describe('CORNER', () => {
    it('AuditEvent hash chain fields are optional (legacy compat)', () => {
      const event = {
        id: FIXED_UUID,
        sessionId: 'ses_test',
        phase: 'TICKET',
        event: 'lifecycle:session_created',
        timestamp: FIXED_TIME,
        actor: 'system',
        detail: {},
      };
      expect(AuditEvent.parse(event)).toEqual(event);
    });

    it('AuditEvent actorInfo is optional', () => {
      const event = {
        id: FIXED_UUID,
        sessionId: 'ses_test',
        phase: 'IMPLEMENTATION',
        event: 'tool_call:flowguard_implement',
        timestamp: FIXED_TIME,
        actor: 'machine',
        detail: {},
      };
      expect(AuditEvent.parse(event).actorInfo).toBeUndefined();
    });
  });

  describe('EDGE', () => {
    it('AuditEvent OpenCode sessionId can be non-UUID', () => {
      const event = {
        id: FIXED_UUID,
        sessionId: 'ses_260740c65ffe77OjxRP7z40yH8',
        phase: 'READY',
        event: 'tool_call:flowguard_hydrate',
        timestamp: FIXED_TIME,
        actor: 'system',
        detail: {},
      };
      expect(AuditEvent.parse(event)).toEqual(event);
    });
  });
});

/**
 * @module evidence-audit.test
 * @description Tests for evidence-audit module.
 * Extracted from evidence-split.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { AuditEvent } from './evidence-audit.js';
import { FIXED_TIME, FIXED_UUID } from './evidence-test-constants.js';

const V3_ENVELOPE = {
  auditFormatVersion: 'audit-chain.v3' as const,
  auditSequence: 1,
  recordedAt: FIXED_TIME,
  semanticEventDigest: 'a'.repeat(64),
  prevHash: 'genesis',
  chainHash: 'b'.repeat(64),
};

describe('evidence-audit', () => {
  describe('HAPPY', () => {
    it('AuditEvent parses valid event', () => {
      const event = {
        id: FIXED_UUID,
        flowguardSessionId: FIXED_UUID,
        hostSessionId: 'ses_test123',
        phase: 'TICKET',
        event: 'tool_call:flowguard_ticket',
        occurredAt: FIXED_TIME,
        actor: 'human',
        detail: { tool: 'flowguard_ticket' },
        ...V3_ENVELOPE,
      };
      expect(AuditEvent.parse(event)).toEqual(event);
    });

    it('AuditEvent parses event with actorInfo', () => {
      const event = {
        id: FIXED_UUID,
        flowguardSessionId: FIXED_UUID,
        hostSessionId: 'ses_test123',
        phase: 'PLAN_REVIEW',
        event: 'decision:approve',
        occurredAt: FIXED_TIME,
        actor: 'human',
        detail: { verdict: 'approve' },
        actorInfo: {
          id: 'user-1',
          email: 'user@example.com',
          source: 'env' as const,
        },
        ...V3_ENVELOPE,
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
        flowguardSessionId: FIXED_UUID,
        hostSessionId: 'ses_test123',
        phase: 'TICKET',
        event: 'lifecycle:session_created',
        occurredAt: FIXED_TIME,
        actor: 'system',
        detail: {},
        ...V3_ENVELOPE,
      };
      expect(AuditEvent.parse(event)).toEqual(event);
    });
  });

  describe('BAD', () => {
    it('AuditEvent rejects unsafe session IDs', () => {
      expect(() =>
        AuditEvent.parse({
          id: FIXED_UUID,
          flowguardSessionId: 'bad/session',
          phase: 'TICKET',
          event: 'test',
          occurredAt: FIXED_TIME,
          actor: 'system',
          detail: {},
          ...V3_ENVELOPE,
        }),
      ).toThrow();
    });

    it('AuditEvent rejects missing id', () => {
      expect(() =>
        AuditEvent.parse({
          flowguardSessionId: FIXED_UUID,
          hostSessionId: 'ses_test',
          phase: 'TICKET',
          event: 'test',
          occurredAt: FIXED_TIME,
          actor: 'system',
          detail: {},
          ...V3_ENVELOPE,
        }),
      ).toThrow();
    });
  });

  describe('CORNER', () => {
    it('AuditEvent rejects records without chain fields (legacy artifacts unsupported)', () => {
      const event = {
        id: FIXED_UUID,
        flowguardSessionId: FIXED_UUID,
        hostSessionId: 'ses_test',
        phase: 'TICKET',
        event: 'lifecycle:session_created',
        occurredAt: FIXED_TIME,
        actor: 'system',
        detail: {},
      };
      expect(() => AuditEvent.parse(event)).toThrow();
    });

    it('AuditEvent rejects records without a semantic event digest', () => {
      const event = {
        id: FIXED_UUID,
        flowguardSessionId: FIXED_UUID,
        hostSessionId: 'ses_test',
        phase: 'TICKET',
        event: 'lifecycle:session_created',
        occurredAt: FIXED_TIME,
        actor: 'system',
        detail: {},
        ...V3_ENVELOPE,
        semanticEventDigest: undefined,
      };
      expect(() => AuditEvent.parse(event)).toThrow();
    });

    it('AuditEvent actorInfo is optional', () => {
      const event = {
        id: FIXED_UUID,
        flowguardSessionId: FIXED_UUID,
        hostSessionId: 'ses_test',
        phase: 'IMPLEMENTATION',
        event: 'tool_call:flowguard_implement',
        occurredAt: FIXED_TIME,
        actor: 'machine',
        detail: {},
        ...V3_ENVELOPE,
      };
      expect(AuditEvent.parse(event).actorInfo).toBeUndefined();
    });
  });

  describe('EDGE', () => {
    it('AuditEvent OpenCode sessionId can be non-UUID', () => {
      const event = {
        id: FIXED_UUID,
        flowguardSessionId: FIXED_UUID,
        hostSessionId: 'ses_260740c65ffe77OjxRP7z40yH8',
        phase: 'READY',
        event: 'tool_call:flowguard_hydrate',
        occurredAt: FIXED_TIME,
        actor: 'system',
        detail: {},
        ...V3_ENVELOPE,
      };
      expect(AuditEvent.parse(event)).toEqual(event);
    });
  });
});

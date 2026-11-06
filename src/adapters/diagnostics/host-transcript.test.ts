/**
 * @module adapters/diagnostics/host-transcript.test
 * @description Host payload validation and byte-budget contract.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 */

import { describe, expect, it } from 'vitest';
import { normalizeHostTranscript } from './host-transcript.js';

function payload(sessionId = 'ses_1'): Record<string, unknown> {
  return {
    info: { id: sessionId },
    messages: [
      {
        info: { id: 'msg_1', sessionID: sessionId, role: 'user' },
        parts: [{ id: 'part_1', sessionID: sessionId, messageID: 'msg_1', type: 'text' }],
      },
    ],
  };
}

describe('host transcript validation', () => {
  describe('HAPPY — valid payload keeps native IDs', () => {
    it('normalizes a matching session and message/part identities', () => {
      const result = normalizeHostTranscript(payload(), 'ses_1');
      expect(result).toMatchObject({
        sessionId: 'ses_1',
        messageCount: 1,
      });
      expect(result.bytes).toBeGreaterThan(0);
    });
  });

  describe('BAD — foreign or malformed identities are rejected', () => {
    it('rejects a payload for another session', () => {
      expect(() => normalizeHostTranscript(payload('ses_other'), 'ses_1')).toThrow(
        /identity mismatch/,
      );
    });

    it('rejects duplicate part ids', () => {
      const value = payload();
      const messages = value['messages'] as Array<{ parts: unknown[] }>;
      messages[0]!.parts.push({
        id: 'part_1',
        sessionID: 'ses_1',
        messageID: 'msg_1',
        type: 'text',
      });
      expect(() => normalizeHostTranscript(value, 'ses_1')).toThrow(/Duplicate host part id/);
    });
  });

  describe('CORNER — byte budget is explicit', () => {
    it('rejects a payload above the configured native capture limit', () => {
      expect(() => normalizeHostTranscript(payload(), 'ses_1', 10)).toThrow(/capture limit/);
    });
  });

  describe('EDGE — validation is bounded by optional fields without inventing lineage', () => {
    it('accepts empty messages for a crashed but identified session', () => {
      const result = normalizeHostTranscript({ info: { id: 'ses_1' }, messages: [] }, 'ses_1');
      expect(result.messageCount).toBe(0);
    });
  });
});

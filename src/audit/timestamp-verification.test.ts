import { describe, it, expect } from 'vitest';
import {
  verifyTimestampMonotonicity,
  verifyTsaMessageImprint,
  verifyTimestampEvidencePresence,
} from './timestamp-verification.js';
import { makeAuditEvent } from './audit-test-helpers.js';
import type { AuditEvent } from '../state/evidence.js';

describe('verifyTimestampMonotonicity', () => {
  it('passes for monotonically increasing timestamps', () => {
    const events = [
      makeAuditEvent({ timestamp: '2026-01-01T00:00:00.000Z' }),
      makeAuditEvent({ timestamp: '2026-01-01T00:01:00.000Z' }),
      makeAuditEvent({ timestamp: '2026-01-01T00:02:00.000Z' }),
    ];
    const result = verifyTimestampMonotonicity(events);
    expect(result.valid).toBe(true);
    expect(result.firstBreak).toBeNull();
  });

  it('passes for equal timestamps', () => {
    const events = [
      makeAuditEvent({ timestamp: '2026-01-01T00:00:00.000Z' }),
      makeAuditEvent({ timestamp: '2026-01-01T00:00:00.000Z' }),
    ];
    const result = verifyTimestampMonotonicity(events);
    expect(result.valid).toBe(true);
  });

  it('fails for decreasing timestamps', () => {
    const events = [
      makeAuditEvent({ timestamp: '2026-01-01T00:02:00.000Z' }),
      makeAuditEvent({ timestamp: '2026-01-01T00:01:00.000Z' }),
    ];
    const result = verifyTimestampMonotonicity(events);
    expect(result.valid).toBe(false);
    expect(result.firstBreak).toBe(1);
  });

  it('passes for single event', () => {
    const events = [makeAuditEvent({ timestamp: '2026-01-01T00:00:00.000Z' })];
    const result = verifyTimestampMonotonicity(events);
    expect(result.valid).toBe(true);
  });

  it('passes for empty array', () => {
    const result = verifyTimestampMonotonicity([]);
    expect(result.valid).toBe(true);
  });
});

describe('verifyTsaMessageImprint', () => {
  it('passes when no timestampEvidence is present', () => {
    const event = makeAuditEvent();
    const result = verifyTsaMessageImprint(event);
    expect(result.valid).toBe(true);
  });

  it('passes when timestampEvidence has no TSA data', () => {
    const event = {
      ...makeAuditEvent(),
      canonicalEventDigest: 'abcd1234',
      timestampEvidence: {
        status: 'local',
        source: 'local_clock',
        resolvedAt: '2026-01-01T00:00:00.000Z',
      },
    } as unknown as AuditEvent;
    const result = verifyTsaMessageImprint(event);
    expect(result.valid).toBe(true);
  });

  it('passes when tsa_failed status', () => {
    const event = {
      ...makeAuditEvent(),
      canonicalEventDigest: 'abcd1234',
      timestampEvidence: {
        status: 'tsa_failed',
        source: 'local_clock',
        resolvedAt: '2026-01-01T00:00:00.000Z',
        tsa: {
          tokenDerBase64: 'x',
          receivedAt: '2026-01-01T00:00:01.000Z',
          verificationStatus: 'unchecked',
        },
      },
    } as unknown as AuditEvent;
    const result = verifyTsaMessageImprint(event);
    expect(result.valid).toBe(true);
  });

  it('fails when TSA messageImprint does not match canonicalEventDigest', () => {
    const event = {
      ...makeAuditEvent(),
      canonicalEventDigest: 'abcd1234',
      timestampEvidence: {
        status: 'tsa_stamped',
        source: 'tsa',
        resolvedAt: '2026-01-01T00:00:00.000Z',
        tsa: {
          tokenDerBase64: 'x',
          receivedAt: '2026-01-01T00:00:01.000Z',
          verificationStatus: 'unchecked',
          messageImprint: 'different_digest',
        },
      },
    } as unknown as AuditEvent;
    const result = verifyTsaMessageImprint(event);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('messageImprint');
  });
});

describe('verifyTimestampEvidencePresence', () => {
  it('passes when critical events have timestampEvidence', () => {
    const events = [
      {
        ...makeAuditEvent({ event: 'decision:DEC-001' }),
        timestampEvidence: {
          status: 'tsa_stamped',
          source: 'tsa',
          resolvedAt: '2026-01-01T00:00:00.000Z',
        },
      } as unknown as AuditEvent,
      {
        ...makeAuditEvent({ event: 'lifecycle:session_created' }),
        timestampEvidence: {
          status: 'ntp_checked',
          source: 'ntp',
          resolvedAt: '2026-01-01T00:00:00.000Z',
        },
      } as unknown as AuditEvent,
    ];
    const result = verifyTimestampEvidencePresence(events, ['decision', 'lifecycle']);
    expect(result.valid).toBe(true);
    expect(result.missingCriticalEvents).toHaveLength(0);
  });

  it('detects missing evidence on critical events', () => {
    const events = [
      makeAuditEvent({ event: 'decision:DEC-001' }),
      makeAuditEvent({ event: 'transition:PLAN_READY' }),
    ];
    const result = verifyTimestampEvidencePresence(events, ['decision', 'lifecycle']);
    expect(result.valid).toBe(false);
    expect(result.missingCriticalEvents).toEqual([0]);
  });

  it('detects local-status evidence as missing', () => {
    const events = [
      {
        ...makeAuditEvent({ event: 'decision:DEC-001' }),
        timestampEvidence: {
          status: 'local',
          source: 'local_clock',
          resolvedAt: '2026-01-01T00:00:00.000Z',
        },
      } as unknown as AuditEvent,
    ];
    const result = verifyTimestampEvidencePresence(events, ['decision', 'lifecycle']);
    expect(result.valid).toBe(false);
    expect(result.missingCriticalEvents).toEqual([0]);
  });
});

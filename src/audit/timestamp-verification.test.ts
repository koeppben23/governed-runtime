import { describe, it, expect } from 'vitest';
import {
  canonicalDigestToUint8Array,
  verifyTimestampMonotonicity,
  verifyTsaMessageImprint,
  verifyTimestampEvidencePresence,
} from './timestamp-verification.js';
import { computeCanonicalEventDigest } from './canonical-digest.js';
import { makeAuditEvent } from './audit-test-helpers.js';
import type { AuditEvent } from '../state/evidence.js';

function makeTsaStampedEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  const event = makeAuditEvent(overrides);
  const canonicalDigest = computeCanonicalEventDigest(event as Record<string, unknown>);
  return {
    ...event,
    semanticEventDigest: canonicalDigest,
    timestampEvidence: {
      status: 'tsa_stamped',
      source: 'tsa',
      resolvedAt: '2026-01-01T00:00:00.000Z',
      tsa: {
        verificationStatus: 'unchecked',
        digestAlgorithm: 'sha256',
        messageImprint: canonicalDigest,
      },
    },
  } as unknown as AuditEvent;
}

function makeTokenTsaStampedEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  const event = makeAuditEvent(overrides);
  const canonicalDigest = computeCanonicalEventDigest(event as Record<string, unknown>);
  return {
    ...event,
    semanticEventDigest: canonicalDigest,
    timestampEvidence: {
      status: 'tsa_stamped',
      source: 'tsa',
      resolvedAt: '2026-01-01T00:00:00.000Z',
      tsa: {
        tokenDerBase64: 'real-token-base64',
        receivedAt: '2026-01-01T00:00:01.000Z',
        verificationStatus: 'unchecked',
        digestAlgorithm: 'sha256',
        messageImprint: canonicalDigest,
      },
    },
  } as unknown as AuditEvent;
}

describe('verifyTimestampMonotonicity', () => {
  it('passes for monotonically increasing record timestamps', () => {
    const events = [
      makeAuditEvent({ recordedAt: '2026-01-01T00:00:00.000Z' }),
      makeAuditEvent({ recordedAt: '2026-01-01T00:01:00.000Z' }),
      makeAuditEvent({ recordedAt: '2026-01-01T00:02:00.000Z' }),
    ];
    const result = verifyTimestampMonotonicity(events);
    expect(result.valid).toBe(true);
    expect(result.firstBreak).toBeNull();
  });

  it('passes for equal record timestamps', () => {
    const events = [
      makeAuditEvent({ recordedAt: '2026-01-01T00:00:00.000Z' }),
      makeAuditEvent({ recordedAt: '2026-01-01T00:00:00.000Z' }),
    ];
    const result = verifyTimestampMonotonicity(events);
    expect(result.valid).toBe(true);
  });

  it('fails for decreasing record timestamps', () => {
    const events = [
      makeAuditEvent({ recordedAt: '2026-01-01T00:02:00.000Z' }),
      makeAuditEvent({ recordedAt: '2026-01-01T00:01:00.000Z' }),
    ];
    const result = verifyTimestampMonotonicity(events);
    expect(result.valid).toBe(false);
    expect(result.firstBreak).toBe(1);
  });

  it('passes for single event', () => {
    const events = [makeAuditEvent({ recordedAt: '2026-01-01T00:00:00.000Z' })];
    const result = verifyTimestampMonotonicity(events);
    expect(result.valid).toBe(true);
  });

  it('AC11: orders mixed-offset ISO timestamps by parsed UTC instant, not lexically', () => {
    const events = [
      // 01:00+02:00 == 23:00Z the day before — lexically AFTER the next entry,
      // but temporally BEFORE it. Lexical comparison would flag this trail as
      // non-monotonic; parsed instants order it correctly.
      makeAuditEvent({ recordedAt: '2026-01-01T01:00:00.000+02:00' }),
      makeAuditEvent({ recordedAt: '2026-01-01T00:01:00.000Z' }),
    ];
    const result = verifyTimestampMonotonicity(events);
    expect(result.valid).toBe(true);
  });

  it('AC11: an unparseable record timestamp is never sortable — trail invalid', () => {
    const events = [
      makeAuditEvent({ recordedAt: '2026-01-01T00:00:00.000Z' }),
      makeAuditEvent({ recordedAt: 'not-a-date' }),
    ];
    const result = verifyTimestampMonotonicity(events);
    expect(result.valid).toBe(false);
    expect(result.firstBreak).toBe(1);
    expect(result.message).toContain('not a parseable UTC instant');
  });

  it('a deferred outbox event with an EARLIER occurredAt is a legitimate record (not a clock anomaly)', () => {
    // The durable audit outbox reconciles older state_write operations after
    // newer direct appends: occurredAt regresses while the record order
    // (recordedAt) is monotonic — this must NOT be classified as CLOCK_ANOMALY.
    const events = [
      makeAuditEvent({
        occurredAt: '2026-01-01T00:02:00.000Z',
        recordedAt: '2026-01-01T00:02:00.000Z',
      }),
      makeAuditEvent({
        occurredAt: '2026-01-01T00:01:00.000Z',
        recordedAt: '2026-01-01T00:03:00.000Z',
      }),
    ];
    const result = verifyTimestampMonotonicity(events);
    expect(result.valid).toBe(true);
  });

  it('passes for empty array', () => {
    const result = verifyTimestampMonotonicity([]);
    expect(result.valid).toBe(true);
  });
});

describe('verifyTsaMessageImprint', () => {
  it('canonicalDigestToUint8Array rejects odd-length hex', () => {
    expect(() => canonicalDigestToUint8Array('abc')).toThrow('odd hex length');
  });

  it('canonicalDigestToUint8Array rejects invalid hex', () => {
    expect(() => canonicalDigestToUint8Array('zzzz')).toThrow('invalid hex');
  });

  it('canonicalDigestToUint8Array round-trips hex bytes', () => {
    const bytes = canonicalDigestToUint8Array('000102ff');
    expect(Array.from(bytes)).toEqual([0, 1, 2, 255]);
  });

  it('passes when no timestampEvidence is present', () => {
    const event = makeAuditEvent();
    const result = verifyTsaMessageImprint(event);
    expect(result).toEqual({
      valid: true,
      reason: null,
      needsTokenVerification: false,
      downgraded: false,
    });
  });

  it('passes when timestampEvidence has no TSA data', () => {
    const event = {
      ...makeAuditEvent(),
      semanticEventDigest: 'abcd1234',
      timestampEvidence: {
        status: 'local',
        source: 'local_clock',
        resolvedAt: '2026-01-01T00:00:00.000Z',
      },
    } as unknown as AuditEvent;
    const result = verifyTsaMessageImprint(event);
    expect(result).toEqual({
      valid: true,
      reason: null,
      needsTokenVerification: false,
      downgraded: false,
    });
  });

  it('AC2: fails when tsa_failed status downgrades a present TSA payload', () => {
    const event = {
      ...makeAuditEvent(),
      semanticEventDigest: 'abcd1234',
      timestampEvidence: {
        status: 'tsa_failed',
        source: 'local_clock',
        resolvedAt: '2026-01-01T00:00:00.000Z',
        tsa: {
          messageImprint: 'a'.repeat(64),
          digestAlgorithm: 'sha256',
        },
      },
    } as unknown as AuditEvent;
    const result = verifyTsaMessageImprint(event);
    expect(result.valid).toBe(false);
    expect(result.downgraded).toBe(true);
    expect(result.reason).toContain('downgraded');
  });

  it('AC2: a token payload with tsa_failed status is a downgrade (never a silent pass, never a downgrade bypass)', () => {
    const event = {
      ...makeAuditEvent(),
      semanticEventDigest: 'abcd1234',
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
    expect(result.valid).toBe(false);
    expect(result.downgraded).toBe(true);
    expect(result.needsTokenVerification).toBe(false);
  });

  it('AC2: fails when a tsa payload carries a local/ntp_checked status (downgrade)', () => {
    for (const status of ['local', 'ntp_checked']) {
      const event = {
        ...makeAuditEvent(),
        semanticEventDigest: 'abcd1234',
        timestampEvidence: {
          status,
          source: 'local_clock',
          resolvedAt: '2026-01-01T00:00:00.000Z',
          tsa: {
            messageImprint: 'a'.repeat(64),
            digestAlgorithm: 'sha256',
          },
        },
      } as unknown as AuditEvent;
      const result = verifyTsaMessageImprint(event);
      expect(result.valid).toBe(false);
      expect(result.downgraded).toBe(true);
    }
  });

  it('AC2 matrix: every degraded status × {token, imprint, token+imprint} payload is a downgrade', () => {
    const payloads: Record<string, Record<string, unknown>> = {
      token: { tokenDerBase64: 'x', receivedAt: '2026-01-01T00:00:01.000Z' },
      imprint: { messageImprint: 'a'.repeat(64), digestAlgorithm: 'sha256' },
      'token+imprint': {
        tokenDerBase64: 'x',
        receivedAt: '2026-01-01T00:00:01.000Z',
        messageImprint: 'a'.repeat(64),
        digestAlgorithm: 'sha256',
      },
    };
    for (const status of ['local', 'ntp_checked', 'tsa_failed']) {
      for (const [payloadName, tsaPayload] of Object.entries(payloads)) {
        const event = {
          ...makeAuditEvent(),
          semanticEventDigest: 'abcd1234',
          timestampEvidence: {
            status,
            source: 'local_clock',
            resolvedAt: '2026-01-01T00:00:00.000Z',
            tsa: tsaPayload,
          },
        } as unknown as AuditEvent;
        const result = verifyTsaMessageImprint(event);
        expect(
          result.downgraded,
          `status=${status}, payload=${payloadName} must be a downgrade`,
        ).toBe(true);
        expect(result.valid).toBe(false);
        expect(result.needsTokenVerification).toBe(false);
      }
    }
  });

  it('passes when TSA messageImprint matches the recomputed canonical event digest', () => {
    const event = makeTsaStampedEvent();
    const result = verifyTsaMessageImprint(event);
    expect(result).toEqual({
      valid: true,
      reason: null,
      needsTokenVerification: false,
      downgraded: false,
    });
  });

  it('fails when TSA messageImprint does not match recomputed canonical event digest', () => {
    const stamped = makeTsaStampedEvent();
    const evidence = (stamped as Record<string, unknown>).timestampEvidence as Record<
      string,
      unknown
    >;
    const tsa = evidence.tsa as Record<string, unknown>;
    const event = {
      ...stamped,
      timestampEvidence: {
        ...evidence,
        tsa: {
          ...tsa,
          messageImprint: 'different_digest',
        },
      },
    } as unknown as AuditEvent;
    const result = verifyTsaMessageImprint(event);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('messageImprint');
  });

  it('fails on nested content tamper even when mutable stored digest is updated', () => {
    const stamped = makeTsaStampedEvent();
    const tampered = {
      ...stamped,
      detail: {
        ...stamped.detail,
        nested: { verdict: 'reject', depth: { changed: true } },
      },
    } as unknown as AuditEvent;
    const attackerUpdatedDigest = computeCanonicalEventDigest(tampered as Record<string, unknown>);
    const event = {
      ...tampered,
      semanticEventDigest: attackerUpdatedDigest,
    } as unknown as AuditEvent;

    const result = verifyTsaMessageImprint(event);

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('messageImprint');
  });

  it('fails closed when stored semanticEventDigest drifts from recomputed content digest', () => {
    const event = {
      ...makeTsaStampedEvent(),
      semanticEventDigest: '0'.repeat(64),
    } as unknown as AuditEvent;

    const result = verifyTsaMessageImprint(event);

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('semanticEventDigest');
  });

  it('fails-closed with needsTokenVerification when tokenDerBase64 exists and imprint is unverified', () => {
    const event = makeTokenTsaStampedEvent();
    const result = verifyTsaMessageImprint(event);

    expect(result.valid).toBe(false);
    expect(result.needsTokenVerification).toBe(true);
    expect(result.downgraded).toBe(false);
    expect(result.reason).toContain('token verification required');
  });

  it('a tsa payload whose fields are non-string values is treated as having no imprint', () => {
    const base = makeAuditEvent();
    const event = {
      ...base,
      semanticEventDigest: computeCanonicalEventDigest(base as Record<string, unknown>),
      timestampEvidence: {
        status: 'tsa_stamped',
        source: 'tsa',
        resolvedAt: '2026-01-01T00:00:00.000Z',
        tsa: {
          tokenDerBase64: 0,
          messageImprint: 42,
        },
      },
    } as unknown as AuditEvent;
    const result = verifyTsaMessageImprint(event);
    expect(result.valid).toBe(false);
    expect(result.downgraded).toBe(false);
    expect(result.needsTokenVerification).toBe(false);
    expect(result.reason).toContain('messageImprint');
  });

  it('fails-closed for coordinated edit with tokenDerBase64 — cannot trust mutable messageImprint', () => {
    const stamped = makeTokenTsaStampedEvent();
    const tampered = {
      ...stamped,
      detail: {
        ...stamped.detail,
        nested: { verdict: 'reject', depth: { changed: true } },
      },
    } as unknown as AuditEvent;
    const attackerUpdatedDigest = computeCanonicalEventDigest(tampered as Record<string, unknown>);
    const evidence = (tampered as Record<string, unknown>).timestampEvidence as Record<
      string,
      unknown
    >;
    const tsa = evidence.tsa as Record<string, unknown>;
    const coordinatedLocalEdit = {
      ...tampered,
      semanticEventDigest: attackerUpdatedDigest,
      timestampEvidence: {
        ...evidence,
        tsa: {
          ...tsa,
          messageImprint: attackerUpdatedDigest,
        },
      },
    } as unknown as AuditEvent;

    const result = verifyTsaMessageImprint(coordinatedLocalEdit);

    expect(result.valid).toBe(false);
    expect(result.needsTokenVerification).toBe(true);
    expect(result.reason).toContain('token verification required');
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

  it('classifies every event-kind prefix through extractEventKind', () => {
    const kinds = ['decision', 'lifecycle', 'transition', 'tool_call', 'error'];
    const events = kinds.map((kind) => makeAuditEvent({ event: `${kind}:EVT-001` }));
    const result = verifyTimestampEvidencePresence(events, kinds);
    // All kinds are critical here, so every un-stamped event is missing.
    expect(result.missingCriticalEvents).toEqual([0, 1, 2, 3, 4]);
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

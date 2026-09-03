import { describe, it, expect } from 'vitest';
import { verifyChain } from './integrity.js';
import {
  computeChainHash,
  GENESIS_HASH,
  createTransitionEvent,
  type ChainedAuditEvent,
} from './types.js';
import { SESSION_ID, TS1, TS2, TS3, stampChainSequence } from './audit-test-helpers.js';
import { computeCanonicalEventDigest } from './canonical-digest.js';

describe('strict timestamp verification branches', () => {
  const transition = {
    from: 'TICKET',
    to: 'PLAN',
    event: 'PLAN_READY',
    autoAdvanced: false,
    chainIndex: -1,
  } as const;

  it('detects non-monotonic record timestamps', () => {
    const first = stampChainSequence(
      createTransitionEvent(SESSION_ID, 'PLAN', transition, TS3, GENESIS_HASH),
      1,
    );
    const second = stampChainSequence(
      createTransitionEvent(SESSION_ID, 'IMPLEMENTATION', transition, TS2, first.chainHash),
      2,
    );
    const result = verifyChain([{ ...first }, { ...second }], {
      strictTimestamps: true,
    });
    expect(result.reason).toBe('CLOCK_ANOMALY');
    expect(result.timestampMonotonicity?.valid).toBe(false);
    expect(result.timestampMonotonicity?.firstBreak).toBe(1);
  });

  it('detects non-monotonic record timestamps without opting into strict timestamps', () => {
    // A1: clock monotonicity needs no TSA evidence and no timestamp policy, so
    // it must be reported in the default mode too. It used to be gated behind
    // `strictTimestamps`, which bundled it with the TSA evidence-presence
    // requirement — so the only way to reach CLOCK_ANOMALY was to also demand
    // TSA evidence from sessions that never enabled timestamp assurance. The
    // CLI compliance report therefore never checked it at all.
    const first = stampChainSequence(
      createTransitionEvent(SESSION_ID, 'PLAN', transition, TS3, GENESIS_HASH),
      1,
    );
    const second = stampChainSequence(
      createTransitionEvent(SESSION_ID, 'IMPLEMENTATION', transition, TS2, first.chainHash),
      2,
    );
    const result = verifyChain([{ ...first }, { ...second }]);
    expect(result.reason).toBe('CLOCK_ANOMALY');
    expect(result.timestampMonotonicity?.valid).toBe(false);
  });

  it('does not demand TSA evidence in the default mode', () => {
    // The other half of the decoupling: a perfectly ordered trail from a
    // session without timestamp assurance must stay clean. Enabling
    // strictTimestamps at the CLI would have made every such session
    // non-compliant via TIMESTAMP_EVIDENCE_MISSING.
    const first = stampChainSequence(
      createTransitionEvent(SESSION_ID, 'PLAN', transition, TS1, GENESIS_HASH),
      1,
    );
    const second = stampChainSequence(
      createTransitionEvent(SESSION_ID, 'IMPLEMENTATION', transition, TS2, first.chainHash),
      2,
    );
    const result = verifyChain([{ ...first }, { ...second }]);
    expect(result.reason).toBeNull();
    expect(result.timestampMonotonicity?.valid).toBe(true);
  });

  it('a deferred outbox event with an earlier occurredAt is not a clock anomaly', () => {
    // The durable audit outbox reconciles older state_write operations after
    // newer direct appends: occurredAt regresses while record order stays
    // monotonic. This must verify cleanly under strict timestamps.
    const first = stampChainSequence(
      createTransitionEvent(SESSION_ID, 'PLAN', transition, TS3, GENESIS_HASH),
      1,
    );
    const second = stampChainSequence(
      createTransitionEvent(SESSION_ID, 'IMPLEMENTATION', transition, TS2, first.chainHash),
      2,
    );
    // recordedAt was stamped at append time and stays monotonic even though
    // occurredAt (TS2) predates the predecessor's (TS3).
    const { chainHash: _staleChainHash, ...secondRest } = second;
    const secondBody = { ...secondRest, recordedAt: TS3 };
    const resealedSecond = {
      ...secondBody,
      chainHash: computeChainHash(
        second.prevHash,
        secondBody as unknown as Omit<ChainedAuditEvent, 'chainHash'>,
      ),
    };
    const result = verifyChain([{ ...first }, { ...resealedSecond }], {
      strictTimestamps: true,
    });
    expect(result.reason).toBeNull();
  });

  it('detects a TSA imprint mismatch without token verification', () => {
    // Internal-imprint model: no external TSA token exists. The canonical
    // envelope requires the tokenDerBase64 FIELD (TsaEvidenceSchema), so the
    // token-less form is persisted as the empty string — which
    // verifyTsaMessageImprint treats as "no token" and compares the stored
    // imprint against the recomputed canonical digest.
    const raw = stampChainSequence(
      createTransitionEvent(SESSION_ID, 'PLAN', transition, TS1, GENESIS_HASH),
      1,
    );
    const { chainHash: _chainHash, ...body } = raw;
    const stampedBody = {
      ...body,
      timestampEvidence: {
        status: 'tsa_stamped',
        source: 'tsa',
        resolvedAt: TS2,
        tsa: {
          tokenDerBase64: '',
          receivedAt: TS2,
          verificationStatus: 'unchecked',
          messageImprint: '0'.repeat(64),
          digestAlgorithm: 'sha256',
        },
      },
    };
    const stamped = {
      ...stampedBody,
      chainHash: computeChainHash(
        GENESIS_HASH,
        stampedBody as unknown as Omit<ChainedAuditEvent, 'chainHash'>,
      ),
    };
    const result = verifyChain([stamped], { strictTimestamps: true });
    expect(result.reason).toBe('TSA_MESSAGE_IMPRINT_MISMATCH');
    expect(result.tsaImprintMismatches).toEqual([0]);
    expect(result.tokenVerificationRequired).toEqual([]);
  });

  it('rejects a token-less TSA payload as envelope-invalid before timestamp verification', () => {
    // A tsa payload that omits the tokenDerBase64 FIELD is schema-invalid per
    // the canonical TsaEvidenceSchema. Even though the record is hash-shaped
    // and internally consistent, the envelope gate must fail closed and the
    // invalid record must never reach the timestamp sub-authorities.
    const raw = stampChainSequence(
      createTransitionEvent(SESSION_ID, 'PLAN', transition, TS1, GENESIS_HASH),
      1,
    );
    const { chainHash: _chainHash, ...body } = raw;
    const stampedBody = {
      ...body,
      timestampEvidence: {
        status: 'tsa_stamped',
        source: 'tsa',
        resolvedAt: TS2,
        tsa: {
          messageImprint: '0'.repeat(64),
          digestAlgorithm: 'sha256',
        },
      },
    };
    const stamped = {
      ...stampedBody,
      chainHash: computeChainHash(
        GENESIS_HASH,
        stampedBody as unknown as Omit<ChainedAuditEvent, 'chainHash'>,
      ),
    };
    const result = verifyChain([stamped], { strictTimestamps: true });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('AUDIT_ENVELOPE_INVALID');
    expect(result.firstBreak?.reasonCode).toBe('AUDIT_ENVELOPE_INVALID');
    expect(result.tsaImprintMismatches).toEqual([]);
    expect(result.tokenVerificationRequired).toEqual([]);
    expect(result.missingTimestampEvidence).toEqual([]);
  });

  it('detects missing decision timestamp evidence', () => {
    const raw = stampChainSequence(
      createTransitionEvent(SESSION_ID, 'PLAN', transition, TS1, GENESIS_HASH),
      1,
    );
    const { chainHash: _chainHash, ...body } = raw;
    const decisionBody = {
      ...body,
      event: 'decision:approve',
      semanticEventDigest: computeCanonicalEventDigest({
        ...body,
        event: 'decision:approve',
      } as unknown as Record<string, unknown>),
    };
    const decisionEvent = {
      ...decisionBody,
      chainHash: computeChainHash(GENESIS_HASH, decisionBody),
    };
    const result = verifyChain([decisionEvent], { strictTimestamps: true });
    expect(result.reason).toBe('TIMESTAMP_EVIDENCE_MISSING');
    expect(result.missingTimestampEvidence).toEqual([0]);
  });
});

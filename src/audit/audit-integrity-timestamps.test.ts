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
      strict: true,
      strictTimestamps: true,
    });
    expect(result.reason).toBe('CLOCK_ANOMALY');
    expect(result.timestampMonotonicity?.valid).toBe(false);
    expect(result.timestampMonotonicity?.firstBreak).toBe(1);
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
      strict: true,
      strictTimestamps: true,
    });
    expect(result.reason).toBeNull();
  });

  it('detects a TSA imprint mismatch without token verification', () => {
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
          receivedAt: TS2,
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
    const result = verifyChain([stamped], { strict: true, strictTimestamps: true });
    expect(result.reason).toBe('TSA_MESSAGE_IMPRINT_MISMATCH');
    expect(result.tsaImprintMismatches).toEqual([0]);
    expect(result.tokenVerificationRequired).toEqual([]);
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
    const result = verifyChain([decisionEvent], { strict: true, strictTimestamps: true });
    expect(result.reason).toBe('TIMESTAMP_EVIDENCE_MISSING');
    expect(result.missingTimestampEvidence).toEqual([0]);
  });
});

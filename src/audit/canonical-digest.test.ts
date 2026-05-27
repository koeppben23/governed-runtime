import { describe, it, expect } from 'vitest';
import { computeCanonicalEventDigest } from './canonical-digest.js';
import { computeChainHash, GENESIS_HASH, createTransitionEvent } from './types.js';
import type { ChainedAuditEvent } from './types.js';

describe('canonicalEventDigest', () => {
  it('produces deterministic digest for same event', () => {
    const event = buildEvent('TICKET', 'PLAN', 'PLAN_READY');
    const d1 = computeCanonicalEventDigest(event);
    const d2 = computeCanonicalEventDigest(event);
    expect(d1).toBe(d2);
    expect(d1).toHaveLength(64);
  });

  it('different events produce different digests', () => {
    const e1 = buildEvent('TICKET', 'PLAN', 'PLAN_READY');
    const e2 = buildEvent('PLAN', 'PLAN_REVIEW', 'APPROVE');
    expect(computeCanonicalEventDigest(e1)).not.toBe(computeCanonicalEventDigest(e2));
  });

  it('timestampEvidence does not affect canonical digest', () => {
    const base = buildEvent('TICKET', 'PLAN', 'PLAN_READY');
    const withEvidence = {
      ...base,
      timestampEvidence: {
        status: 'tsa_stamped' as const,
        source: 'tsa' as const,
        resolvedAt: '2026-01-01T00:00:00.000Z',
        tsa: {
          tokenDerBase64: 'abc',
          receivedAt: '2026-01-01T00:00:01.000Z',
          verificationStatus: 'unchecked' as const,
        },
      },
    };
    expect(computeCanonicalEventDigest(base)).toBe(computeCanonicalEventDigest(withEvidence));
  });

  it('chainHash does not affect canonical digest', () => {
    const base = buildEvent('TICKET', 'PLAN', 'PLAN_READY');
    const withChainHash = { ...base, chainHash: 'abc123' };
    expect(computeCanonicalEventDigest(base)).toBe(
      computeCanonicalEventDigest(withChainHash as Omit<ChainedAuditEvent, 'chainHash'>),
    );
  });

  it('prevHash does not affect canonical digest', () => {
    const base = buildEvent('TICKET', 'PLAN', 'PLAN_READY');
    const withDifferentPrevHash = {
      ...base,
      prevHash: 'other-hash-64-chars-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    };
    expect(computeCanonicalEventDigest(base)).toBe(
      computeCanonicalEventDigest(withDifferentPrevHash),
    );
  });

  it('canonicalEventDigest field itself is excluded from computation', () => {
    const base = buildEvent('TICKET', 'PLAN', 'PLAN_READY');
    const withCanonical = { ...base, canonicalEventDigest: 'different_value' };
    expect(computeCanonicalEventDigest(base)).toBe(computeCanonicalEventDigest(withCanonical));
  });

  it('produces hex-formatted SHA-256', () => {
    const event = buildEvent('TICKET', 'PLAN', 'PLAN_READY');
    const digest = computeCanonicalEventDigest(event);
    expect(/^[0-9a-f]{64}$/.test(digest)).toBe(true);
  });
});

function buildEvent(
  from: string,
  to: string,
  eventName: string,
): Omit<ChainedAuditEvent, 'chainHash'> {
  const evt = createTransitionEvent(
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    to as Parameters<typeof createTransitionEvent>[1],
    {
      from: from as Parameters<typeof createTransitionEvent>[2]['from'],
      to: to as Parameters<typeof createTransitionEvent>[2]['to'],
      event: eventName as Parameters<typeof createTransitionEvent>[2]['event'],
      autoAdvanced: false,
      chainIndex: -1,
    },
    '2026-01-01T00:00:00.000Z',
    GENESIS_HASH,
  );
  const { chainHash, ...base } = evt;
  return base;
}

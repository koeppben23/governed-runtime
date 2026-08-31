import { describe, it, expect } from 'vitest';
import { canonicalJsonStringify, computeCanonicalEventDigest } from './canonical-digest.js';
import {
  computeChainHash,
  CURRENT_AUDIT_FORMAT_VERSION,
  GENESIS_HASH,
  createTransitionEvent,
} from './types.js';
import type { ChainedAuditEvent } from './types.js';
import type { Event, Phase } from '../state/schema.js';

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

  it('semanticEventDigest field itself is excluded from computation', () => {
    const base = buildEvent('TICKET', 'PLAN', 'PLAN_READY');
    const withSemantic = { ...base, semanticEventDigest: 'different_value' };
    expect(computeCanonicalEventDigest(base)).toBe(computeCanonicalEventDigest(withSemantic));
  });

  it('auditSequence and recordedAt are excluded from computation (positional authority)', () => {
    const base = buildEvent('TICKET', 'PLAN', 'PLAN_READY');
    const positional = {
      ...base,
      auditSequence: 999,
      recordedAt: '2027-01-01T00:00:00.000Z',
    };
    expect(computeCanonicalEventDigest(base)).toBe(computeCanonicalEventDigest(positional));
  });

  it('produces hex-formatted SHA-256', () => {
    const event = buildEvent('TICKET', 'PLAN', 'PLAN_READY');
    const digest = computeCanonicalEventDigest(event);
    expect(/^[0-9a-f]{64}$/.test(digest)).toBe(true);
  });

  it('canonical JSON sorts nested object keys recursively', () => {
    const left = { z: [{ b: 2, a: 1 }], a: { y: 'yes', x: 'ex' } };
    const right = { a: { x: 'ex', y: 'yes' }, z: [{ a: 1, b: 2 }] };

    expect(canonicalJsonStringify(left)).toBe(canonicalJsonStringify(right));
  });

  it('chainHash is deterministic for equivalent nested content with different key order', () => {
    const bodyA = buildNestedBody({ verdict: 'approve', evidence: { b: 2, a: 1 } });
    const bodyB = buildNestedBody({ evidence: { a: 1, b: 2 }, verdict: 'approve' });

    expect(computeChainHash(GENESIS_HASH, bodyA)).toBe(computeChainHash(GENESIS_HASH, bodyB));
  });
});

function buildEvent(
  from: Phase,
  to: Phase,
  eventName: Event,
): Omit<ChainedAuditEvent, 'chainHash'> {
  const evt = createTransitionEvent(
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    to,
    {
      from,
      to,
      event: eventName,
      autoAdvanced: false,
      chainIndex: -1,
    },
    '2026-01-01T00:00:00.000Z',
    GENESIS_HASH,
  );
  const { chainHash, ...base } = evt;
  return base;
}

function buildNestedBody(decision: Record<string, unknown>): Omit<ChainedAuditEvent, 'chainHash'> {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    flowguardSessionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    phase: 'PLAN_REVIEW',
    event: 'decision:DEC-001',
    occurredAt: '2026-01-01T00:00:00.000Z',
    auditSequence: 1,
    recordedAt: '2026-01-01T00:00:00.000Z',
    semanticEventDigest: 'd'.repeat(64),
    actor: 'human',
    auditFormatVersion: CURRENT_AUDIT_FORMAT_VERSION,
    detail: { decision },
    prevHash: GENESIS_HASH,
  };
}

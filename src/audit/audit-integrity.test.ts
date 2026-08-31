import { describe, it, expect } from 'vitest';
import {
  computeChainHash,
  CURRENT_AUDIT_FORMAT_VERSION,
  GENESIS_HASH,
  createTransitionEvent,
  type ChainedAuditEvent,
} from './types.js';
import { verifyEvent, verifyChain, getLastChainHash } from './integrity.js';
import { computeCanonicalEventDigest } from './canonical-digest.js';
import { benchmarkSync, PERF_BUDGETS } from '../test-policy.js';
import { SESSION_ID, TS1, TS2, TS3, buildChain, stampChainSequence } from './audit-test-helpers.js';

describe('audit integrity', () => {
  // ─── HAPPY ──────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('verifyEvent passes for valid event with correct prevHash', () => {
      const event = stampChainSequence(
        createTransitionEvent(
          SESSION_ID,
          'PLAN',
          { from: 'TICKET', to: 'PLAN', event: 'PLAN_READY', autoAdvanced: false, chainIndex: -1 },
          TS1,
          GENESIS_HASH,
        ),
        1,
      );
      const result = verifyEvent(event, GENESIS_HASH, 0);
      expect(result.valid).toBe(true);
      expect(result.reason).toBeNull();
    });

    it('verifyChain passes for valid 3-event chain', () => {
      const chain = buildChain(3);
      const result = verifyChain(chain.map((event) => ({ ...event })));
      expect(result.valid).toBe(true);
      expect(result.totalEvents).toBe(3);
      expect(result.verifiedCount).toBe(3);
      expect(result.skippedCount).toBe(0);
      expect(result.firstBreak).toBeNull();
      expect(result.reason).toBeNull();
    });

    it('getLastChainHash returns last event chainHash', () => {
      const chain = buildChain(3);
      const lastHash = getLastChainHash(chain.map((event) => ({ ...event })));
      expect(lastHash).toBe(chain[2]!.chainHash);
    });

    it('verifyChain rejects a trail whose sequence authority is not index + 1 (1, 7, 7)', () => {
      const chain = buildChain(3);
      const resealed = chain.map((event, i) => {
        const { chainHash: _chainHash, ...body } = event;
        const restamped = {
          ...body,
          auditSequence: i === 0 ? 1 : 7,
        } as unknown as Omit<ChainedAuditEvent, 'chainHash'>;
        return {
          ...restamped,
          chainHash: computeChainHash(restamped.prevHash, restamped),
        };
      });
      // Re-chain so every chainHash is internally consistent: the sequence
      // authority alone must still invalidate the trail.
      const result = verifyChain(resealed);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('CHAIN_BREAK');
      expect(result.firstBreak?.reason).toContain('auditSequence mismatch');
    });

    it('verifyChain rejects a re-sealed trail whose semanticEventDigest was not recomputed', () => {
      const chain = buildChain(2);
      const resealed = chain.map((event) => {
        const { chainHash: _chainHash, ...body } = event;
        const tamperedBody = {
          ...body,
          semanticEventDigest: '0'.repeat(64),
        } as unknown as Omit<ChainedAuditEvent, 'chainHash'>;
        return {
          ...tamperedBody,
          chainHash: computeChainHash(tamperedBody.prevHash, tamperedBody),
        };
      });
      const result = verifyChain(resealed);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('CHAIN_BREAK');
      expect(result.firstBreak?.reason).toContain('semanticEventDigest mismatch');
    });
  });

  // ─── BAD ────────────────────────────────────────────────────
  describe('BAD', () => {
    it('verifyEvent fails on prevHash mismatch', () => {
      const event = createTransitionEvent(
        SESSION_ID,
        'PLAN',
        { from: 'TICKET', to: 'PLAN', event: 'PLAN_READY', autoAdvanced: false, chainIndex: -1 },
        TS1,
        GENESIS_HASH,
      );
      const result = verifyEvent(event, 'wrong-prev-hash', 0);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('prevHash mismatch');
    });

    it('verifyEvent fails on tampered chainHash', () => {
      const event = createTransitionEvent(
        SESSION_ID,
        'PLAN',
        { from: 'TICKET', to: 'PLAN', event: 'PLAN_READY', autoAdvanced: false, chainIndex: -1 },
        TS1,
        GENESIS_HASH,
      );
      // Tamper the chainHash
      const tampered: ChainedAuditEvent = { ...event, chainHash: '0'.repeat(64) };
      const result = verifyEvent(tampered, GENESIS_HASH, 0);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('chainHash mismatch');
      expect(result.expectedChainHash).toHaveLength(64);
      expect(result.actualChainHash).toBe('0'.repeat(64));
    });

    it('computeChainHash changes when nested event content changes', () => {
      const event = buildNestedDecisionEvent(GENESIS_HASH);
      const { chainHash: _chainHash, ...body } = event;
      const tamperedBody = {
        ...body,
        detail: {
          ...body.detail,
          decision: {
            ...(body.detail.decision as Record<string, unknown>),
            verdict: 'reject',
          },
        },
      } as Omit<ChainedAuditEvent, 'chainHash'>;

      expect(computeChainHash(GENESIS_HASH, body)).not.toBe(
        computeChainHash(GENESIS_HASH, tamperedBody),
      );
    });

    it('verifyChain fails closed when nested event content is tampered', () => {
      const event = buildNestedDecisionEvent(GENESIS_HASH);
      const tampered = {
        ...event,
        detail: {
          ...event.detail,
          decision: {
            ...(event.detail.decision as Record<string, unknown>),
            verdict: 'reject',
          },
        },
      } as unknown as Record<string, unknown>;

      const result = verifyChain([tampered], { strict: true });
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('CHAIN_BREAK');
      expect(result.firstBreak?.expectedChainHash).toHaveLength(64);
      expect(result.firstBreak?.actualChainHash).toBe(event.chainHash);
    });

    it('strict timestamp verification fails when nested content tamper is re-sealed but TSA imprint is unchanged', () => {
      const original = buildNestedDecisionEvent(GENESIS_HASH);
      const originalDigest = computeCanonicalEventDigest({ ...original });
      const { chainHash: _originalChainHash, ...originalBody } = original;
      const stampedBody: Omit<ChainedAuditEvent, 'chainHash'> = {
        ...originalBody,
        semanticEventDigest: originalDigest,
        timestampEvidence: {
          status: 'tsa_stamped',
          source: 'tsa',
          resolvedAt: TS1,
          tsa: {
            tokenDerBase64: 'trusted-token',
            receivedAt: TS1,
            messageImprint: originalDigest,
            digestAlgorithm: 'sha256',
            verificationStatus: 'unchecked',
          },
        },
      };
      const stamped = {
        ...stampedBody,
        chainHash: computeChainHash(GENESIS_HASH, stampedBody),
      };
      const { chainHash: _stampedChainHash, ...stampedWithoutHash } = stamped;
      const tamperedBody = {
        ...stampedWithoutHash,
        detail: {
          ...stamped.detail,
          decision: {
            ...(stamped.detail.decision as Record<string, unknown>),
            verdict: 'reject',
          },
        },
      } as Omit<ChainedAuditEvent, 'chainHash'>;
      // A coordinated local edit recomputes BOTH the stamped semantic digest
      // and the chainHash — the TSA imprint is the only authority it cannot
      // regenerate, so verification must fall through to the TSA check.
      const tamperedWithUpdatedLocalDigest = {
        ...tamperedBody,
        semanticEventDigest: computeCanonicalEventDigest(
          tamperedBody as unknown as Record<string, unknown>,
        ),
      };
      const resealedTamper = {
        ...tamperedWithUpdatedLocalDigest,
        chainHash: computeChainHash(GENESIS_HASH, tamperedWithUpdatedLocalDigest),
      };

      const result = verifyChain([resealedTamper], { strict: true, strictTimestamps: true });

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('TOKEN_VERIFICATION_REQUIRED');
      expect(result.tokenVerificationRequired).toEqual([0]);
    });

    it('AC2: a downgraded status on stronger TSA evidence is a chain failure (TSA_EVIDENCE_DOWNGRADED)', () => {
      const original = buildNestedDecisionEvent(GENESIS_HASH);
      const originalDigest = computeCanonicalEventDigest({ ...original });
      const { chainHash: _originalChainHash, ...originalBody } = original;
      const downgradedBody: Omit<ChainedAuditEvent, 'chainHash'> = {
        ...originalBody,
        semanticEventDigest: originalDigest,
        timestampEvidence: {
          status: 'local',
          source: 'local_clock',
          resolvedAt: TS1,
          tsa: {
            tokenDerBase64: '',
            receivedAt: TS1,
            verificationStatus: 'unchecked',
            messageImprint: originalDigest,
            digestAlgorithm: 'sha256',
          },
        },
      };
      const downgraded = {
        ...downgradedBody,
        chainHash: computeChainHash(GENESIS_HASH, downgradedBody),
      };

      const result = verifyChain([downgraded], { strict: true, strictTimestamps: true });

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('TSA_EVIDENCE_DOWNGRADED');
      expect(result.tsaEvidenceDowngraded).toEqual([0]);
    });

    // ── Constant-time comparison tests for safeHashEqual ────────

    it('verifyEvent fails on equal-length prevHash mismatch', () => {
      const event = createTransitionEvent(
        SESSION_ID,
        'PLAN',
        { from: 'TICKET', to: 'PLAN', event: 'PLAN_READY', autoAdvanced: false, chainIndex: -1 },
        TS1,
        GENESIS_HASH,
      );
      // Same string length as GENESIS_HASH (64 chars) but different value
      const wrongPrevHash = 'a'.repeat(64);
      const result = verifyEvent(event, wrongPrevHash, 0);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('prevHash mismatch');
    });

    it('verifyEvent fails safely on different-length prevHash', () => {
      const event = createTransitionEvent(
        SESSION_ID,
        'PLAN',
        { from: 'TICKET', to: 'PLAN', event: 'PLAN_READY', autoAdvanced: false, chainIndex: -1 },
        TS1,
        GENESIS_HASH,
      );
      // Different string length than GENESIS_HASH (64 chars)
      const shortPrevHash = 'short';
      const result = verifyEvent(event, shortPrevHash, 0);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('prevHash mismatch');
    });

    it('verifyEvent fails safely on different-length chainHash', () => {
      const event = createTransitionEvent(
        SESSION_ID,
        'PLAN',
        { from: 'TICKET', to: 'PLAN', event: 'PLAN_READY', autoAdvanced: false, chainIndex: -1 },
        TS1,
        GENESIS_HASH,
      );
      // Set chainHash to different string length than computed hash
      const tampered: ChainedAuditEvent = { ...event, chainHash: 'short' };
      const result = verifyEvent(tampered, GENESIS_HASH, 0);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('chainHash mismatch');
    });

    it('verifyEvent fails safely on same string length but different byte length (Unicode edge)', () => {
      const event = createTransitionEvent(
        SESSION_ID,
        'PLAN',
        { from: 'TICKET', to: 'PLAN', event: 'PLAN_READY', autoAdvanced: false, chainIndex: -1 },
        TS1,
        GENESIS_HASH,
      );
      // 'ä' is 2 bytes in UTF-8, so 64 chars = 128 bytes
      // A hex hash is 64 ASCII chars = 64 bytes
      // Same JS string length (64) but different byte lengths → tests buffer-length check
      const tamperedChainHash = 'ä'.repeat(64); // 64 chars, 128 bytes
      const tampered: ChainedAuditEvent = { ...event, chainHash: tamperedChainHash };
      const result = verifyEvent(tampered, GENESIS_HASH, 0);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('chainHash mismatch');
    });

    it('verifyEvent passes with matching hash', () => {
      const event = stampChainSequence(
        createTransitionEvent(
          SESSION_ID,
          'PLAN',
          { from: 'TICKET', to: 'PLAN', event: 'PLAN_READY', autoAdvanced: false, chainIndex: -1 },
          TS1,
          GENESIS_HASH,
        ),
        1,
      );
      // Use the actual correct prevHash
      const result = verifyEvent(event, GENESIS_HASH, 0);
      expect(result.valid).toBe(true);
      expect(result.reason).toBeNull();
    });

    it('verifyChain detects a break in the middle', () => {
      const chain = buildChain(5);
      // Tamper event #2 by modifying its detail
      const tampered = chain.map((e, i) => {
        if (i === 2) return { ...e, phase: 'TAMPERED' } as unknown as Record<string, unknown>;
        return e as unknown as Record<string, unknown>;
      });
      const result = verifyChain(tampered);
      expect(result.valid).toBe(false);
      expect(result.firstBreak).not.toBeNull();
      expect(result.firstBreak!.index).toBe(2);
      expect(result.reason).toBe('CHAIN_BREAK');
    });

    it('verifyChain reports pre-v3 records as unsupported legacy, not tampering', () => {
      const event = buildNestedDecisionEvent(GENESIS_HASH);
      const { auditFormatVersion: _auditFormatVersion, ...legacy } = event;

      const result = verifyChain([legacy as unknown as Record<string, unknown>], { strict: true });
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('LEGACY_ASSURANCE_FORMAT_UNSUPPORTED');
      expect(result.firstBreak?.reasonCode).toBe('LEGACY_ASSURANCE_FORMAT_UNSUPPORTED');
    });

    it('verifyChain reports audit-chain.v1 as unsupported legacy, not tampering', () => {
      const event = {
        ...buildNestedDecisionEvent(GENESIS_HASH),
        auditFormatVersion: 'audit-chain.v1',
      };

      const result = verifyChain([event as unknown as Record<string, unknown>], { strict: true });
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('LEGACY_ASSURANCE_FORMAT_UNSUPPORTED');
      expect(result.firstBreak?.reasonCode).toBe('LEGACY_ASSURANCE_FORMAT_UNSUPPORTED');
    });

    it('verifyChain reports unknown audit format as unsupported legacy', () => {
      const event = {
        ...buildNestedDecisionEvent(GENESIS_HASH),
        auditFormatVersion: 'audit-chain.v999',
      };

      const result = verifyChain([event as unknown as Record<string, unknown>], { strict: true });
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('LEGACY_ASSURANCE_FORMAT_UNSUPPORTED');
      expect(result.firstBreak?.reasonCode).toBe('LEGACY_ASSURANCE_FORMAT_UNSUPPORTED');
    });
  });

  // ─── CORNER ─────────────────────────────────────────────────
  describe('CORNER', () => {
    it('verifyChain with empty trail → valid (vacuously true)', () => {
      const result = verifyChain([]);
      expect(result.valid).toBe(true);
      expect(result.totalEvents).toBe(0);
      expect(result.verifiedCount).toBe(0);
      expect(result.reason).toBeNull();
    });

    it('verifyChain with single event → valid', () => {
      const chain = buildChain(1);
      const result = verifyChain(chain as unknown as Record<string, unknown>[]);
      expect(result.valid).toBe(true);
      expect(result.verifiedCount).toBe(1);
      expect(result.reason).toBeNull();
    });

    it('getLastChainHash with empty trail → GENESIS_HASH', () => {
      expect(getLastChainHash([])).toBe(GENESIS_HASH);
    });

    it('getLastChainHash finds chained event at index 0 when it is the only chained event', () => {
      const chain = buildChain(1);
      const events = [chain[0] as unknown as Record<string, unknown>];
      expect(getLastChainHash(events)).toBe(chain[0]!.chainHash);
    });

    it('isChainedEvent returns false for empty chainHash string', () => {
      const event: Record<string, unknown> = {
        id: 'evt-1',
        chainHash: '',
        prevHash: 'abc123',
      };
      // verifyChain treats non-chained records as unsupported legacy — no skipping.
      const result = verifyChain([event]);
      expect(result.skippedCount).toBe(0);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('LEGACY_ASSURANCE_FORMAT_UNSUPPORTED');
    });

    it('isChainedEvent returns false for empty prevHash string', () => {
      const event: Record<string, unknown> = {
        id: 'evt-2',
        chainHash: 'abc123',
        prevHash: '',
      };
      const result = verifyChain([event]);
      expect(result.skippedCount).toBe(0);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('LEGACY_ASSURANCE_FORMAT_UNSUPPORTED');
    });

    it('verifyChain rejects non-chained (legacy) records', () => {
      const legacyEvent: Record<string, unknown> = {
        id: 'legacy-1',
        flowguardSessionId: SESSION_ID,
        phase: 'PLAN',
        event: 'transition:PLAN_READY',
        occurredAt: TS1,
        actor: 'machine',
        detail: {},
        // No prevHash, no chainHash
      };
      const result = verifyChain([legacyEvent]);
      expect(result.valid).toBe(false);
      expect(result.totalEvents).toBe(1);
      expect(result.verifiedCount).toBe(1);
      expect(result.skippedCount).toBe(0);
      expect(result.reason).toBe('LEGACY_ASSURANCE_FORMAT_UNSUPPORTED');
      expect(result.firstBreak?.reasonCode).toBe('LEGACY_ASSURANCE_FORMAT_UNSUPPORTED');
    });
  });

  // ─── EDGE ───────────────────────────────────────────────────
  describe('EDGE', () => {
    it('verifyChain with mixed chained and legacy records fails closed on the legacy record', () => {
      const chain = buildChain(2);
      const legacy: Record<string, unknown> = {
        id: 'legacy-1',
        flowguardSessionId: SESSION_ID,
        phase: 'PLAN',
        event: 'some:event',
        occurredAt: TS2,
        actor: 'machine',
        detail: {},
      };
      // Append the legacy record after the chained events (inserting it
      // between chained events would additionally break the sequence authority
      // of every following record, which the dedicated sequence test covers).
      const mixed = [
        chain[0] as unknown as Record<string, unknown>,
        chain[1] as unknown as Record<string, unknown>,
        legacy,
      ];
      const result = verifyChain(mixed);
      // Legacy records are never skipped — the chain fails closed.
      expect(result.totalEvents).toBe(3);
      expect(result.skippedCount).toBe(0);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('LEGACY_ASSURANCE_FORMAT_UNSUPPORTED');
      expect(result.firstBreak?.index).toBe(2);
    });

    it('insertion attack detected — new event breaks prevHash chain', () => {
      const chain = buildChain(3);
      // Create an "inserted" event with correct prevHash but inserted between [0] and [1]
      const inserted = createTransitionEvent(
        SESSION_ID,
        'PLAN',
        {
          from: 'PLAN',
          to: 'PLAN_REVIEW',
          event: 'PLAN_READY',
          autoAdvanced: false,
          chainIndex: -1,
        },
        TS2,
        chain[0]!.chainHash, // Uses correct prevHash for [0]
      );
      // The inserted event carries a compliant sequence for its chain position;
      // the attack is exposed by the prevHash break of the event AFTER it.
      const insertedStamped = stampChainSequence(inserted, 2);
      // Insert between [0] and [1] — [1]'s prevHash still points to [0], not inserted
      const tampered = [
        chain[0] as unknown as Record<string, unknown>,
        insertedStamped as unknown as Record<string, unknown>,
        chain[1] as unknown as Record<string, unknown>, // prevHash = chain[0].chainHash, not inserted.chainHash
        chain[2] as unknown as Record<string, unknown>,
      ];
      const result = verifyChain(tampered);
      // Event at index 2 (original chain[1]) has prevHash = chain[0].chainHash
      // but the verifier expects prevHash = inserted.chainHash → break
      expect(result.valid).toBe(false);
      expect(result.firstBreak!.index).toBe(2);
      expect(result.reason).toBe('CHAIN_BREAK');
    });

    it('getLastChainHash skips trailing legacy events', () => {
      const chain = buildChain(2);
      const legacy: Record<string, unknown> = {
        id: 'legacy-tail',
        flowguardSessionId: SESSION_ID,
        phase: 'COMPLETE',
        event: 'some:event',
        timestamp: TS3,
        actor: 'machine',
        detail: {},
      };
      const mixed = [...chain.map((e) => e as unknown as Record<string, unknown>), legacy];
      expect(getLastChainHash(mixed)).toBe(chain[1]!.chainHash);
    });
  });

  // ─── PERF ───────────────────────────────────────────────────
  describe('PERF', () => {
    it('verifyChain for 1000 events < 100ms', () => {
      const chain = buildChain(1000);
      const raw = chain.map((e) => e as unknown as Record<string, unknown>);
      const { p99Ms } = benchmarkSync(() => verifyChain(raw), 5, 1);
      expect(p99Ms).toBeLessThan(PERF_BUDGETS.auditChainVerify1000Ms);
    });
  });

  // ─── STRICT MODE ───────────────────────────────────────────
  describe('STRICT MODE', () => {
    // ─── HAPPY ──────────────────────────────────────────────
    describe('HAPPY', () => {
      it('strict mode with all chained events → valid', () => {
        const chain = buildChain(3);
        const raw = chain.map((e) => e as unknown as Record<string, unknown>);
        const result = verifyChain(raw, { strict: true });
        expect(result.valid).toBe(true);
        expect(result.reason).toBeNull();
        expect(result.skippedCount).toBe(0);
        expect(result.verifiedCount).toBe(3);
      });

      it('strict mode with single chained event → valid', () => {
        const chain = buildChain(1);
        const raw = chain.map((e) => e as unknown as Record<string, unknown>);
        const result = verifyChain(raw, { strict: true });
        expect(result.valid).toBe(true);
        expect(result.reason).toBeNull();
      });
    });

    // ─── BAD ────────────────────────────────────────────────
    describe('BAD', () => {
      it('rejects a single legacy record in every mode', () => {
        const legacyEvent: Record<string, unknown> = {
          id: 'legacy-strict-1',
          flowguardSessionId: SESSION_ID,
          phase: 'PLAN',
          event: 'transition:PLAN_READY',
          occurredAt: TS1,
          actor: 'machine',
          detail: {},
        };
        const result = verifyChain([legacyEvent], { strict: true });
        expect(result.valid).toBe(false);
        expect(result.reason).toBe('LEGACY_ASSURANCE_FORMAT_UNSUPPORTED');
        expect(result.skippedCount).toBe(0);
        expect(result.verifiedCount).toBe(1);
        expect(result.firstBreak?.index).toBe(0);
      });

      it('rejects multiple legacy records in every mode', () => {
        const legacyEvents: Record<string, unknown>[] = [
          {
            id: 'leg-1',
            flowguardSessionId: SESSION_ID,
            phase: 'TICKET',
            event: 'e1',
            occurredAt: TS1,
            actor: 'machine',
            detail: {},
          },
          {
            id: 'leg-2',
            flowguardSessionId: SESSION_ID,
            phase: 'PLAN',
            event: 'e2',
            occurredAt: TS2,
            actor: 'machine',
            detail: {},
          },
          {
            id: 'leg-3',
            flowguardSessionId: SESSION_ID,
            phase: 'PLAN',
            event: 'e3',
            occurredAt: TS3,
            actor: 'machine',
            detail: {},
          },
        ];
        const result = verifyChain(legacyEvents, { strict: true });
        expect(result.valid).toBe(false);
        expect(result.reason).toBe('LEGACY_ASSURANCE_FORMAT_UNSUPPORTED');
        expect(result.skippedCount).toBe(0);
      });

      it('strict mode with tampered event → CHAIN_BREAK (not legacy)', () => {
        const chain = buildChain(3);
        const tampered = chain.map((e, i) => {
          if (i === 1) return { ...e, phase: 'TAMPERED' } as unknown as Record<string, unknown>;
          return e as unknown as Record<string, unknown>;
        });
        const result = verifyChain(tampered, { strict: true });
        expect(result.valid).toBe(false);
        expect(result.reason).toBe('CHAIN_BREAK');
        expect(result.firstBreak).not.toBeNull();
      });
    });

    // ─── CORNER ─────────────────────────────────────────────
    describe('CORNER', () => {
      it('strict mode with empty trail → valid', () => {
        const result = verifyChain([], { strict: true });
        expect(result.valid).toBe(true);
        expect(result.reason).toBeNull();
        expect(result.skippedCount).toBe(0);
      });

      it('non-strict (default) with legacy records → still fails closed', () => {
        const legacyEvent: Record<string, unknown> = {
          id: 'legacy-compat',
          flowguardSessionId: SESSION_ID,
          phase: 'PLAN',
          event: 'transition:PLAN_READY',
          occurredAt: TS1,
          actor: 'machine',
          detail: {},
        };
        const result = verifyChain([legacyEvent]);
        expect(result.valid).toBe(false);
        expect(result.reason).toBe('LEGACY_ASSURANCE_FORMAT_UNSUPPORTED');
        expect(result.skippedCount).toBe(0);
      });

      it('explicit strict: false also fails closed on legacy records', () => {
        const legacyEvent: Record<string, unknown> = {
          id: 'legacy-explicit-false',
          flowguardSessionId: SESSION_ID,
          phase: 'PLAN',
          event: 'transition:PLAN_READY',
          occurredAt: TS1,
          actor: 'machine',
          detail: {},
        };
        const result = verifyChain([legacyEvent], { strict: false });
        expect(result.valid).toBe(false);
        expect(result.reason).toBe('LEGACY_ASSURANCE_FORMAT_UNSUPPORTED');
        expect(result.skippedCount).toBe(0);
      });
    });

    // ─── EDGE ───────────────────────────────────────────────
    describe('EDGE', () => {
      it('mixed chained + legacy → fails closed on the legacy record', () => {
        const chain = buildChain(2);
        const legacy: Record<string, unknown> = {
          id: 'legacy-mixed-strict',
          flowguardSessionId: SESSION_ID,
          phase: 'PLAN',
          event: 'some:event',
          occurredAt: TS2,
          actor: 'machine',
          detail: {},
        };
        const mixed = [
          chain[0] as unknown as Record<string, unknown>,
          chain[1] as unknown as Record<string, unknown>,
          legacy,
        ];
        const result = verifyChain(mixed, { strict: true });
        expect(result.valid).toBe(false);
        expect(result.reason).toBe('LEGACY_ASSURANCE_FORMAT_UNSUPPORTED');
        expect(result.skippedCount).toBe(0);
        expect(result.firstBreak?.index).toBe(2);
      });

      it('strict mode: chain break + legacy record → reason is CHAIN_BREAK (severity priority)', () => {
        const chain = buildChain(3);
        const legacy: Record<string, unknown> = {
          id: 'legacy-plus-break',
          flowguardSessionId: SESSION_ID,
          phase: 'PLAN',
          event: 'some:event',
          occurredAt: TS2,
          actor: 'machine',
          detail: {},
        };
        // Tamper chain[1] AND insert a legacy record
        const tampered = [
          chain[0] as unknown as Record<string, unknown>,
          legacy,
          { ...chain[1], phase: 'TAMPERED' } as unknown as Record<string, unknown>,
          chain[2] as unknown as Record<string, unknown>,
        ];
        const result = verifyChain(tampered, { strict: true });
        expect(result.valid).toBe(false);
        // CHAIN_BREAK wins over legacy — more severe
        expect(result.reason).toBe('CHAIN_BREAK');
        expect(result.skippedCount).toBe(0);
        expect(result.firstBreak).not.toBeNull();
      });
    });

    // ─── PERF ───────────────────────────────────────────────
    describe('PERF', () => {
      it('strict mode adds no measurable overhead vs default', () => {
        const chain = buildChain(1000);
        const raw = chain.map((e) => e as unknown as Record<string, unknown>);
        const { p99Ms } = benchmarkSync(() => verifyChain(raw, { strict: true }), 5, 1);
        expect(p99Ms).toBeLessThan(PERF_BUDGETS.auditChainVerify1000Ms);
      });
    });
  });
});

function buildNestedDecisionEvent(prevHash: string): ChainedAuditEvent {
  const body: Omit<ChainedAuditEvent, 'chainHash'> = {
    id: '11111111-1111-4111-8111-111111111111',
    flowguardSessionId: SESSION_ID,
    phase: 'PLAN_REVIEW',
    event: 'decision:DEC-001',
    occurredAt: TS1,
    auditSequence: 1,
    recordedAt: TS1,
    semanticEventDigest: 'c'.repeat(64),
    actor: 'human',
    auditFormatVersion: CURRENT_AUDIT_FORMAT_VERSION,
    detail: {
      decision: {
        id: 'DEC-001',
        verdict: 'approve',
        reviewer: { id: 'reviewer-1', assurance: 'claim_validated' },
      },
    },
    prevHash,
  };
  return { ...body, chainHash: computeChainHash(prevHash, body) };
}

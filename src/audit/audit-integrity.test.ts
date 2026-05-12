import { describe, it, expect } from 'vitest';
import {
  computeChainHash,
  GENESIS_HASH,
  createTransitionEvent,
  type ChainedAuditEvent,
} from './types.js';
import { verifyEvent, verifyChain, getLastChainHash } from './integrity.js';
import { benchmarkSync, PERF_BUDGETS } from '../test-policy.js';
import { SESSION_ID, TS1, TS2, TS3, buildChain } from './audit-test-helpers.js';

describe('audit integrity', () => {
  // ─── HAPPY ──────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('verifyEvent passes for valid event with correct prevHash', () => {
      const event = createTransitionEvent(
        SESSION_ID,
        'PLAN',
        { from: 'TICKET', to: 'PLAN', event: 'PLAN_READY', autoAdvanced: false, chainIndex: -1 },
        TS1,
        GENESIS_HASH,
      );
      const result = verifyEvent(event, GENESIS_HASH, 0);
      expect(result.valid).toBe(true);
      expect(result.reason).toBeNull();
    });

    it('verifyChain passes for valid 3-event chain', () => {
      const chain = buildChain(3);
      const result = verifyChain(chain as unknown as Record<string, unknown>[]);
      expect(result.valid).toBe(true);
      expect(result.totalEvents).toBe(3);
      expect(result.verifiedCount).toBe(3);
      expect(result.skippedCount).toBe(0);
      expect(result.firstBreak).toBeNull();
      expect(result.reason).toBeNull();
    });

    it('getLastChainHash returns last event chainHash', () => {
      const chain = buildChain(3);
      const lastHash = getLastChainHash(chain as unknown as Record<string, unknown>[]);
      expect(lastHash).toBe(chain[2]!.chainHash);
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
      const event = createTransitionEvent(
        SESSION_ID,
        'PLAN',
        { from: 'TICKET', to: 'PLAN', event: 'PLAN_READY', autoAdvanced: false, chainIndex: -1 },
        TS1,
        GENESIS_HASH,
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
      const chain = buildChain(1);
      // verifyChain should skip this event (handled internally via isChainedEvent)
      const result = verifyChain([event]);
      expect(result.skippedCount).toBe(1);
    });

    it('isChainedEvent returns false for empty prevHash string', () => {
      const event: Record<string, unknown> = {
        id: 'evt-2',
        chainHash: 'abc123',
        prevHash: '',
      };
      const result = verifyChain([event]);
      expect(result.skippedCount).toBe(1);
    });

    it('verifyChain skips non-chained (legacy) events', () => {
      const legacyEvent: Record<string, unknown> = {
        id: 'legacy-1',
        sessionId: SESSION_ID,
        phase: 'PLAN',
        event: 'transition:PLAN_READY',
        timestamp: TS1,
        actor: 'machine',
        detail: {},
        // No prevHash, no chainHash
      };
      const result = verifyChain([legacyEvent]);
      expect(result.valid).toBe(true);
      expect(result.totalEvents).toBe(1);
      expect(result.verifiedCount).toBe(0);
      expect(result.skippedCount).toBe(1);
      expect(result.reason).toBeNull();
    });
  });

  // ─── EDGE ───────────────────────────────────────────────────
  describe('EDGE', () => {
    it('verifyChain with mixed chained and legacy events', () => {
      const chain = buildChain(2);
      const legacy: Record<string, unknown> = {
        id: 'legacy-1',
        sessionId: SESSION_ID,
        phase: 'PLAN',
        event: 'some:event',
        timestamp: TS2,
        actor: 'machine',
        detail: {},
      };
      // Insert legacy between two chained events
      const mixed = [
        chain[0] as unknown as Record<string, unknown>,
        legacy,
        chain[1] as unknown as Record<string, unknown>,
      ];
      const result = verifyChain(mixed);
      // Chain continues from event[0].chainHash to event[2].prevHash
      // Event[2] was created with event[0].chainHash as prevHash
      // so after skipping the legacy event, the chain should still be valid
      expect(result.totalEvents).toBe(3);
      expect(result.skippedCount).toBe(1);
      expect(result.verifiedCount).toBe(2);
      // The chain is valid because event[1] (chained, index=2) was built
      // with event[0].chainHash as prevHash
      expect(result.valid).toBe(true);
      expect(result.reason).toBeNull();
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
      // Insert between [0] and [1] — [1]'s prevHash still points to [0], not inserted
      const tampered = [
        chain[0] as unknown as Record<string, unknown>,
        inserted as unknown as Record<string, unknown>,
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
        sessionId: SESSION_ID,
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
      it('strict mode rejects single legacy event', () => {
        const legacyEvent: Record<string, unknown> = {
          id: 'legacy-strict-1',
          sessionId: SESSION_ID,
          phase: 'PLAN',
          event: 'transition:PLAN_READY',
          timestamp: TS1,
          actor: 'machine',
          detail: {},
        };
        const result = verifyChain([legacyEvent], { strict: true });
        expect(result.valid).toBe(false);
        expect(result.reason).toBe('LEGACY_EVENTS_NOT_ALLOWED_IN_STRICT_MODE');
        expect(result.skippedCount).toBe(1);
        expect(result.verifiedCount).toBe(0);
        expect(result.firstBreak).toBeNull();
      });

      it('strict mode rejects multiple legacy events', () => {
        const legacyEvents: Record<string, unknown>[] = [
          {
            id: 'leg-1',
            sessionId: SESSION_ID,
            phase: 'TICKET',
            event: 'e1',
            timestamp: TS1,
            actor: 'machine',
            detail: {},
          },
          {
            id: 'leg-2',
            sessionId: SESSION_ID,
            phase: 'PLAN',
            event: 'e2',
            timestamp: TS2,
            actor: 'machine',
            detail: {},
          },
          {
            id: 'leg-3',
            sessionId: SESSION_ID,
            phase: 'PLAN',
            event: 'e3',
            timestamp: TS3,
            actor: 'machine',
            detail: {},
          },
        ];
        const result = verifyChain(legacyEvents, { strict: true });
        expect(result.valid).toBe(false);
        expect(result.reason).toBe('LEGACY_EVENTS_NOT_ALLOWED_IN_STRICT_MODE');
        expect(result.skippedCount).toBe(3);
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
      it('strict mode with empty trail → valid (nothing to skip)', () => {
        const result = verifyChain([], { strict: true });
        expect(result.valid).toBe(true);
        expect(result.reason).toBeNull();
        expect(result.skippedCount).toBe(0);
      });

      it('non-strict (default) with legacy events → still valid (backward compat)', () => {
        const legacyEvent: Record<string, unknown> = {
          id: 'legacy-compat',
          sessionId: SESSION_ID,
          phase: 'PLAN',
          event: 'transition:PLAN_READY',
          timestamp: TS1,
          actor: 'machine',
          detail: {},
        };
        const result = verifyChain([legacyEvent]);
        expect(result.valid).toBe(true);
        expect(result.reason).toBeNull();
        expect(result.skippedCount).toBe(1);
      });

      it('explicit strict: false behaves like default (legacy-tolerant)', () => {
        const legacyEvent: Record<string, unknown> = {
          id: 'legacy-explicit-false',
          sessionId: SESSION_ID,
          phase: 'PLAN',
          event: 'transition:PLAN_READY',
          timestamp: TS1,
          actor: 'machine',
          detail: {},
        };
        const result = verifyChain([legacyEvent], { strict: false });
        expect(result.valid).toBe(true);
        expect(result.reason).toBeNull();
        expect(result.skippedCount).toBe(1);
      });
    });

    // ─── EDGE ───────────────────────────────────────────────
    describe('EDGE', () => {
      it('strict mode with mixed chained + legacy → fails on legacy', () => {
        const chain = buildChain(2);
        const legacy: Record<string, unknown> = {
          id: 'legacy-mixed-strict',
          sessionId: SESSION_ID,
          phase: 'PLAN',
          event: 'some:event',
          timestamp: TS2,
          actor: 'machine',
          detail: {},
        };
        const mixed = [
          chain[0] as unknown as Record<string, unknown>,
          legacy,
          chain[1] as unknown as Record<string, unknown>,
        ];
        const result = verifyChain(mixed, { strict: true });
        expect(result.valid).toBe(false);
        expect(result.reason).toBe('LEGACY_EVENTS_NOT_ALLOWED_IN_STRICT_MODE');
        expect(result.skippedCount).toBe(1);
        expect(result.verifiedCount).toBe(2);
        // Chain hashes themselves are valid — the break is due to legacy event
        expect(result.firstBreak).toBeNull();
      });

      it('strict mode: chain break + legacy events → reason is CHAIN_BREAK (severity priority)', () => {
        const chain = buildChain(3);
        const legacy: Record<string, unknown> = {
          id: 'legacy-plus-break',
          sessionId: SESSION_ID,
          phase: 'PLAN',
          event: 'some:event',
          timestamp: TS2,
          actor: 'machine',
          detail: {},
        };
        // Tamper chain[1] AND insert a legacy event
        const tampered = [
          chain[0] as unknown as Record<string, unknown>,
          legacy,
          { ...chain[1], phase: 'TAMPERED' } as unknown as Record<string, unknown>,
          chain[2] as unknown as Record<string, unknown>,
        ];
        const result = verifyChain(tampered, { strict: true });
        expect(result.valid).toBe(false);
        // CHAIN_BREAK wins over LEGACY — more severe
        expect(result.reason).toBe('CHAIN_BREAK');
        expect(result.skippedCount).toBe(1);
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

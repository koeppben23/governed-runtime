import { describe, it, expect } from 'vitest';
import { generateTimeline, generateComplianceSummary } from './summary.js';
import { verifyChain } from './integrity.js';
import type { AuditEvent } from '../state/evidence.js';
import { benchmarkSync, PERF_BUDGETS } from '../test-policy.js';
import {
  SESSION_ID,
  TS1,
  TS2,
  TS3,
  makeAuditEvent,
  buildSessionTrail,
} from './audit-test-helpers.js';

describe('audit summary', () => {
  // ─── HAPPY ──────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('generateTimeline produces correct timeline for a complete session', () => {
      const trail = buildSessionTrail();
      const timeline = generateTimeline(trail, SESSION_ID);
      expect(timeline.sessionId).toBe(SESSION_ID);
      expect(timeline.eventCount).toBe(trail.length);
      expect(timeline.timeSpan).not.toBeNull();
      expect(timeline.entries).toHaveLength(trail.length);
      // Phase progression should be deduped
      expect(timeline.phaseProgression).toEqual([
        'TICKET',
        'PLAN',
        'VALIDATION',
        'IMPLEMENTATION',
        'IMPL_REVIEW',
        'EVIDENCE_REVIEW',
        'COMPLETE',
      ]);
    });

    it('generateComplianceSummary passes for complete session with all checks', () => {
      const trail = buildSessionTrail();
      const chainResult = verifyChain([] /* no chained events for this test */);
      const summary = generateComplianceSummary(trail, SESSION_ID, chainResult, TS3);
      expect(summary.sessionId).toBe(SESSION_ID);
      expect(summary.generatedAt).toBe(TS3);
      expect(summary.stats.totalEvents).toBe(trail.length);
      // Check that at least session_created and session_terminated pass
      const createdCheck = summary.checks.find((c) => c.name === 'session_created');
      expect(createdCheck?.passed).toBe(true);
      const terminatedCheck = summary.checks.find((c) => c.name === 'session_terminated');
      expect(terminatedCheck?.passed).toBe(true);
    });

    it('timeline entries have correct structure', () => {
      const trail = buildSessionTrail();
      const timeline = generateTimeline(trail, SESSION_ID);
      const first = timeline.entries[0]!;
      expect(first).toHaveProperty('timestamp');
      expect(first).toHaveProperty('kind');
      expect(first).toHaveProperty('event');
      expect(first).toHaveProperty('phase');
      expect(first).toHaveProperty('actor');
      expect(first).toHaveProperty('description');
      expect(first.kind).toBe('lifecycle');
      expect(first.description).toContain('session created');
    });
  });

  // ─── BAD ────────────────────────────────────────────────────
  describe('BAD', () => {
    it('timeline for nonexistent session → empty', () => {
      const trail = buildSessionTrail();
      const timeline = generateTimeline(trail, 'nonexistent');
      expect(timeline.eventCount).toBe(0);
      expect(timeline.timeSpan).toBeNull();
      expect(timeline.entries).toHaveLength(0);
      expect(timeline.phaseProgression).toHaveLength(0);
    });

    it('compliance for incomplete session flags missing termination', () => {
      // Session with only creation, no completion
      const trail: AuditEvent[] = [
        makeAuditEvent({
          event: 'lifecycle:session_created',
          phase: 'TICKET',
          timestamp: TS1,
          actor: 'system',
          detail: { kind: 'lifecycle', action: 'session_created', finalPhase: 'TICKET' },
        }),
        makeAuditEvent({
          event: 'transition:TICKET_SET',
          phase: 'PLAN',
          timestamp: TS2,
          detail: { from: 'TICKET', to: 'PLAN' },
        }),
      ];
      const summary = generateComplianceSummary(trail, SESSION_ID, null, TS3);
      const terminated = summary.checks.find((c) => c.name === 'session_terminated');
      expect(terminated?.passed).toBe(false);
    });
  });

  // ─── CORNER ─────────────────────────────────────────────────
  describe('CORNER', () => {
    it('compliance summary without chain verification omits chain_integrity check', () => {
      const trail = buildSessionTrail();
      const summary = generateComplianceSummary(trail, SESSION_ID, null, TS3);
      const chainCheck = summary.checks.find((c) => c.name === 'chain_integrity');
      expect(chainCheck).toBeUndefined();
    });

    it('compliance summary with broken chain reports failure', () => {
      const trail = buildSessionTrail();
      const brokenChain = {
        valid: false,
        totalEvents: 10,
        verifiedCount: 8,
        skippedCount: 2,
        firstBreak: { index: 3, eventId: 'broken-event', valid: false, reason: 'tampered' },
        results: [],
        reason: 'CHAIN_BREAK' as const,
      };
      const summary = generateComplianceSummary(trail, SESSION_ID, brokenChain, TS3);
      const chainCheck = summary.checks.find((c) => c.name === 'chain_integrity');
      expect(chainCheck).toBeDefined();
      expect(chainCheck!.passed).toBe(false);
      expect(chainCheck!.detail).toContain('BROKEN');
    });

    it('compliance with error events that are resolved (session reaches COMPLETE)', () => {
      const trail: AuditEvent[] = [
        makeAuditEvent({
          event: 'lifecycle:session_created',
          phase: 'TICKET',
          timestamp: TS1,
          actor: 'system',
          detail: { kind: 'lifecycle', action: 'session_created', finalPhase: 'TICKET' },
        }),
        makeAuditEvent({
          event: 'error:TOOL_TIMEOUT',
          phase: 'PLAN',
          timestamp: TS2,
          actor: 'machine',
          detail: { kind: 'error', code: 'TOOL_TIMEOUT' },
        }),
        makeAuditEvent({
          event: 'lifecycle:session_completed',
          phase: 'COMPLETE',
          timestamp: TS3,
          actor: 'system',
          detail: { kind: 'lifecycle', action: 'session_completed', finalPhase: 'COMPLETE' },
        }),
      ];
      const summary = generateComplianceSummary(trail, SESSION_ID, null, TS3);
      const errorCheck = summary.checks.find((c) => c.name === 'no_unresolved_errors');
      expect(errorCheck?.passed).toBe(true);
    });

    it('empty events for compliance summary produces all-fail checks', () => {
      const summary = generateComplianceSummary([], SESSION_ID, null, TS3);
      expect(summary.stats.totalEvents).toBe(0);
      expect(summary.compliant).toBe(false);
    });
  });

  // ─── EDGE ───────────────────────────────────────────────────
  describe('EDGE', () => {
    it('describeEvent produces correct descriptions for each kind', () => {
      const trail = buildSessionTrail();
      const timeline = generateTimeline(trail, SESSION_ID);
      // lifecycle event
      const lifecycleEntry = timeline.entries.find((e) => e.kind === 'lifecycle');
      expect(lifecycleEntry?.description).toContain('Lifecycle');

      // transition event
      const transitionEntry = timeline.entries.find((e) => e.kind === 'transition');
      expect(transitionEntry?.description).toContain('State transition');

      // tool_call event
      const toolEntry = timeline.entries.find((e) => e.kind === 'tool_call');
      expect(toolEntry?.description).toContain('Tool call');
    });

    it('compliance: review gates not applicable if session never reached those phases', () => {
      const trail: AuditEvent[] = [
        makeAuditEvent({
          event: 'lifecycle:session_created',
          phase: 'TICKET',
          timestamp: TS1,
          actor: 'system',
          detail: { kind: 'lifecycle', action: 'session_created', finalPhase: 'TICKET' },
        }),
        makeAuditEvent({
          event: 'lifecycle:session_aborted',
          phase: 'TICKET',
          timestamp: TS2,
          actor: 'user',
          detail: { kind: 'lifecycle', action: 'session_aborted', finalPhase: 'TICKET' },
        }),
      ];
      const summary = generateComplianceSummary(trail, SESSION_ID, null, TS3);
      const planReview = summary.checks.find((c) => c.name === 'plan_review_honored');
      const evidenceReview = summary.checks.find((c) => c.name === 'evidence_review_honored');
      // Not applicable → passes by default
      expect(planReview?.passed).toBe(true);
      expect(evidenceReview?.passed).toBe(true);
    });
  });

  // ─── PERF ───────────────────────────────────────────────────
  describe('PERF', () => {
    it(`generateComplianceSummary for 500 events < ${PERF_BUDGETS.complianceSummary500Ms}ms (p95)`, () => {
      const largeTrail: AuditEvent[] = Array.from({ length: 500 }, (_, i) =>
        makeAuditEvent({
          id: `perf-${i}`,
          event: `transition:EVENT_${i}`,
          phase: i < 250 ? 'PLAN' : 'VALIDATION',
          timestamp: `2026-01-01T00:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
        }),
      );
      const { p95Ms } = benchmarkSync(
        () => generateComplianceSummary(largeTrail, SESSION_ID, null, TS3),
        20,
        5,
      );
      expect(p95Ms).toBeLessThan(PERF_BUDGETS.complianceSummary500Ms);
    });
  });

  // ─── STRICT CHAIN SUMMARY ─────────────────────────────────
  describe('STRICT CHAIN SUMMARY', () => {
    it('compliance summary with strict failure (legacy events) reports STRICT detail', () => {
      const trail = buildSessionTrail();
      const strictFailure = {
        valid: false,
        totalEvents: 5,
        verifiedCount: 3,
        skippedCount: 2,
        firstBreak: null,
        results: [],
        reason: 'LEGACY_EVENTS_NOT_ALLOWED_IN_STRICT_MODE' as const,
      };
      const summary = generateComplianceSummary(trail, SESSION_ID, strictFailure, TS3);
      const chainCheck = summary.checks.find((c) => c.name === 'chain_integrity');
      expect(chainCheck).toBeDefined();
      expect(chainCheck!.passed).toBe(false);
      expect(chainCheck!.detail).toContain('STRICT');
      expect(chainCheck!.detail).toContain('legacy');
      expect(chainCheck!.detail).toContain('2');
    });

    it('compliance summary with strict valid (all chained) passes', () => {
      const trail = buildSessionTrail();
      const strictValid = {
        valid: true,
        totalEvents: 5,
        verifiedCount: 5,
        skippedCount: 0,
        firstBreak: null,
        results: [],
        reason: null,
      };
      const summary = generateComplianceSummary(trail, SESSION_ID, strictValid, TS3);
      const chainCheck = summary.checks.find((c) => c.name === 'chain_integrity');
      expect(chainCheck).toBeDefined();
      expect(chainCheck!.passed).toBe(true);
      expect(chainCheck!.detail).toContain('verified');
    });
  });
});

// =============================================================================
// audit/completeness
// =============================================================================

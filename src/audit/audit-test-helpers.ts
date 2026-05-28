/**
 * @module audit-test-helpers
 * @description Shared test fixtures for the audit test suite.
 */

import { GENESIS_HASH, createTransitionEvent, type ChainedAuditEvent } from './types.js';
import type { AuditEvent } from '../state/evidence.js';
import { FIXED_SESSION_UUID } from '../__fixtures__.js';

export const SESSION_ID = FIXED_SESSION_UUID;
export const TS1 = '2026-01-01T00:00:00.000Z';
export const TS2 = '2026-01-01T00:01:00.000Z';
export const TS3 = '2026-01-01T00:02:00.000Z';

/** Build a minimal AuditEvent for query tests. */
export function makeAuditEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    sessionId: SESSION_ID,
    phase: 'PLAN',
    event: 'transition:PLAN_READY',
    timestamp: TS1,
    actor: 'machine',
    detail: { from: 'TICKET', to: 'PLAN', kind: 'transition' },
    ...overrides,
  };
}

/** Build a chain of N chained audit events (for integrity tests). */
export function buildChain(length: number): ChainedAuditEvent[] {
  const events: ChainedAuditEvent[] = [];
  let prevHash = GENESIS_HASH;

  for (let i = 0; i < length; i++) {
    const event = createTransitionEvent(
      SESSION_ID,
      'PLAN',
      {
        from: 'TICKET',
        to: 'PLAN',
        event: 'PLAN_READY',
        autoAdvanced: false,
        chainIndex: -1,
      },
      `2026-01-01T00:${String(i).padStart(2, '0')}:00.000Z`,
      prevHash,
    );
    events.push(event);
    prevHash = event.chainHash;
  }

  return events;
}

/** Build a realistic session event trail for summary/compliance tests. */
export function buildSessionTrail(): AuditEvent[] {
  return [
    makeAuditEvent({
      event: 'lifecycle:session_created',
      phase: 'TICKET',
      timestamp: TS1,
      actor: 'system',
      detail: { kind: 'lifecycle', action: 'session_created', finalPhase: 'TICKET' },
    }),
    makeAuditEvent({
      event: 'tool_call:flowguard_ticket',
      phase: 'TICKET',
      timestamp: TS1,
      actor: 'user',
      detail: { kind: 'tool_call', tool: 'flowguard_ticket', success: true, transitionCount: 1 },
    }),
    makeAuditEvent({
      event: 'transition:TICKET_SET',
      phase: 'PLAN',
      timestamp: TS1,
      detail: {
        kind: 'transition',
        from: 'TICKET',
        to: 'PLAN',
        event: 'TICKET_SET',
        autoAdvanced: false,
        chainIndex: -1,
      },
    }),
    makeAuditEvent({
      event: 'transition:PLAN_READY',
      phase: 'PLAN',
      timestamp: TS2,
      detail: {
        kind: 'transition',
        from: 'PLAN',
        to: 'PLAN_REVIEW',
        event: 'PLAN_READY',
        autoAdvanced: true,
        chainIndex: 0,
      },
    }),
    makeAuditEvent({
      event: 'transition:APPROVE',
      phase: 'VALIDATION',
      timestamp: TS2,
      detail: {
        kind: 'transition',
        from: 'PLAN_REVIEW',
        to: 'VALIDATION',
        event: 'APPROVE',
        autoAdvanced: false,
        chainIndex: -1,
      },
    }),
    makeAuditEvent({
      event: 'tool_call:flowguard_run_check',
      phase: 'VALIDATION',
      timestamp: TS2,
      actor: 'machine',
      detail: { kind: 'tool_call', tool: 'flowguard_run_check', success: true, transitionCount: 1 },
    }),
    makeAuditEvent({
      event: 'transition:ALL_PASSED',
      phase: 'IMPLEMENTATION',
      timestamp: TS2,
      detail: {
        kind: 'transition',
        from: 'VALIDATION',
        to: 'IMPLEMENTATION',
        event: 'ALL_PASSED',
        autoAdvanced: false,
        chainIndex: -1,
      },
    }),
    makeAuditEvent({
      event: 'transition:IMPL_COMPLETE',
      phase: 'IMPL_REVIEW',
      timestamp: TS3,
      detail: {
        kind: 'transition',
        from: 'IMPLEMENTATION',
        to: 'IMPL_REVIEW',
        event: 'IMPL_COMPLETE',
        autoAdvanced: false,
        chainIndex: -1,
      },
    }),
    makeAuditEvent({
      event: 'transition:REVIEW_CONVERGED',
      phase: 'EVIDENCE_REVIEW',
      timestamp: TS3,
      detail: {
        kind: 'transition',
        from: 'IMPL_REVIEW',
        to: 'EVIDENCE_REVIEW',
        event: 'REVIEW_CONVERGED',
        autoAdvanced: false,
        chainIndex: -1,
      },
    }),
    makeAuditEvent({
      event: 'transition:APPROVE',
      phase: 'COMPLETE',
      timestamp: TS3,
      detail: {
        kind: 'transition',
        from: 'EVIDENCE_REVIEW',
        to: 'COMPLETE',
        event: 'APPROVE',
        autoAdvanced: false,
        chainIndex: -1,
      },
    }),
    makeAuditEvent({
      event: 'lifecycle:session_completed',
      phase: 'COMPLETE',
      timestamp: TS3,
      actor: 'system',
      detail: { kind: 'lifecycle', action: 'session_completed', finalPhase: 'COMPLETE' },
    }),
  ];
}

import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '../../state/evidence-audit.js';
import type { ExplorerView } from '../diagnostics/types.js';
import { projectWorkbenchDiagnostics } from './workbench-diagnostics-projection.js';

function explorer(): ExplorerView {
  return {
    schemaVersion: 'diagnostic-view.v1',
    kind: 'explorer',
    rootSessionId: 'ses_root',
    generatedAt: '2026-11-07T14:00:00.000Z',
    status: 'PARTIAL',
    completeness: { lineage: 'partial', canonicalState: 'partial' },
    sessions: [
      {
        sessionId: 'ses_root', parentSessionId: null, role: 'root',
        discoveredBy: ['root'], state: 'captured', lineage: 'verified',
        phase: 'PLAN_REVIEW', binding: 'verified', warningCodes: [],
      },
      {
        sessionId: 'ses_child', parentSessionId: 'ses_root', role: 'reviewer',
        discoveredBy: ['review_attempt'], state: 'unavailable', lineage: 'not_verified',
        phase: null, binding: 'unknown', warningCodes: ['SESSION_LINEAGE_NOT_VERIFIED'],
      },
    ],
    reviewLinks: null,
    warnings: [],
  };
}

function event(sequence: number, occurredAt: string): AuditEvent {
  return {
    auditSequence: sequence,
    occurredAt,
    recordedAt: occurredAt,
    event: 'transition:PLAN_REVIEW',
    phase: 'PLAN_REVIEW',
    detail: { confidentialPath: '/secret/workspace' },
  } as unknown as AuditEvent;
}

describe('native Workbench session explorer and verified audit projection', () => {
  it('preserves unknown children without reading them or inventing positive integrity', () => {
    const result = projectWorkbenchDiagnostics(explorer(), [
      { sessionID: 'ses_root', integrity: 'verified', reasonCode: null,
        events: [event(1, '2026-11-07T12:00:00.000Z')] },
      { sessionID: 'ses_child', integrity: 'not_verified',
        reasonCode: 'SESSION_LINEAGE_OR_BINDING_NOT_VERIFIED', events: [] },
    ]);
    expect(result.explorer.lineage).toBe('partial');
    expect(result.explorer.sessions[1]?.lineage).toBe('not_verified');
    expect(result.audit.status).toBe('PARTIAL');
    expect(result.audit.events).toHaveLength(1);
    expect(result.audit.sessions[1]?.integrity).toBe('not_verified');
    expect(result.decisionAuthority).toBe('not_granted');
    expect(JSON.stringify(result)).not.toContain('/secret/workspace');
  });

  it('never shows events from an invalid audit chain', () => {
    const result = projectWorkbenchDiagnostics(explorer(), [
      { sessionID: 'ses_root', integrity: 'invalid', reasonCode: 'CHAIN_BREAK',
        events: [event(1, '2026-11-07T12:00:00.000Z')] },
    ]);
    expect(result.audit.status).toBe('NOT_VERIFIED');
    expect(result.audit.events).toEqual([]);
    expect(result.audit.sessions[0]?.reasonCode).toBe('CHAIN_BREAK');
  });

  it('bounds and sorts verified audit chronology without equating timestamps to causality', () => {
    const root = explorer();
    const full: ExplorerView = {
      ...root,
      status: 'COMPLETE',
      completeness: { lineage: 'complete', canonicalState: 'complete' },
      sessions: [root.sessions[0]!],
    };
    const events = Array.from({ length: 120 }, (_, i) =>
      event(i + 1, new Date(Date.UTC(2026, 10, 7, 12, 0, 119 - i)).toISOString()));
    const result = projectWorkbenchDiagnostics(full, [
      { sessionID: 'ses_root', integrity: 'verified', reasonCode: null, events },
    ]);
    expect(result.audit.status).toBe('COMPLETE');
    expect(result.audit.totalEvents).toBe(120);
    expect(result.audit.eventsTruncated).toBe(true);
    expect(result.audit.events).toHaveLength(100);
    expect(result.audit.events[0]?.at).toBe('2026-11-07T12:00:20.000Z');
    expect(result.audit.note).toContain('do not establish cross-session causality');
  });
});

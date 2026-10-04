import { describe, expect, it } from 'vitest';
import { createRailContext } from '../adapters/context.js';
import { makeProgressedState } from '../fixtures.js';
import { executeExport } from './export.js';

const evidence = {
  id: '00000000-0000-4000-8000-000000000001',
  packageDigest: 'a'.repeat(64),
  purpose: 'auditor' as const,
  integrityCapability: 'verifiable' as const,
  createdAt: '2025-01-01T00:00:00.000Z',
};

describe('executeExport', () => {
  it('persists exact completion evidence with EXPORT_READY → COMPLETE', () => {
    const result = executeExport(
      makeProgressedState('EXPORT_READY'),
      evidence,
      createRailContext(),
    );
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.state.phase).toBe('COMPLETE');
      expect(result.state.exportCompletionEvidence).toEqual(evidence);
      expect(result.transitions).toEqual([
        expect.objectContaining({
          from: 'EXPORT_READY',
          to: 'COMPLETE',
          event: 'EXPORT_MATERIALIZED',
        }),
      ]);
    }
  });

  it('blocks export outside EXPORT_READY without changing state', () => {
    const state = makeProgressedState('EVIDENCE_REVIEW');
    const result = executeExport(state, evidence, createRailContext());
    expect(result).toMatchObject({ kind: 'blocked', code: 'COMMAND_NOT_ALLOWED' });
  });
});

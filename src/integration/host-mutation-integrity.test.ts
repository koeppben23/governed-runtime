import { describe, expect, it } from 'vitest';
import { hostMutationIntegrityGate } from './phase-tool-gate.js';
import { makeState } from '../fixtures.js';
import type { ReviewAssuranceState } from '../state/evidence-review.js';

describe('integrity incident repository-mutation fence', () => {
  const state = makeState('IMPLEMENTATION');
  const incident = {
    ...state,
    reviewAssurance: {
      obligations: [{ status: 'blocked', blockedCode: 'SUBAGENT_EVIDENCE_REUSED' }],
    } as ReviewAssuranceState,
  };
  it.each(['bash', 'write', 'edit', 'apply_patch'])('denies host mutation %s', (tool) => {
    expect(hostMutationIntegrityGate(tool, incident)).toMatchObject({
      kind: 'blocked',
      code: 'INTEGRITY_INCIDENT_MUTATION_DENIED',
    });
  });
  it.each([
    'read',
    'grep',
    'flowguard_status',
    'flowguard_abort_session',
    'flowguard_export',
    'flowguard_archive',
  ])('preserves diagnosis, evidence and termination via %s', (tool) => {
    expect(hostMutationIntegrityGate(tool, incident)).toEqual({ kind: 'clear' });
  });
  it('blocks obvious direct state writes but permits a diagnostic read', () => {
    expect(
      hostMutationIntegrityGate(
        'bash',
        state,
        { command: 'printf x > /workspace/sessions/a/session-state.json' },
        '/workspace/sessions/a',
      ),
    ).toMatchObject({ code: 'SESSION_STATE_DIRECT_WRITE_DENIED' });
    expect(hostMutationIntegrityGate('read', incident, {}, '/workspace/sessions/a')).toEqual({
      kind: 'clear',
    });
  });
});

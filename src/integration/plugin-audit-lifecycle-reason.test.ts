import { describe, expect, it } from 'vitest';
import { buildLifecycleDetail } from './plugin-audit-lifecycle-reason.js';
import type { AuditContext } from './plugin-audit-context.js';
import type { SessionState } from '../state/schema.js';

const baseCtx: AuditContext = {
  sessDir: '/tmp/ses_test',
  emitToolCalls: true,
  emitTransitions: true,
  enableChainHash: true,
  actor: 'system',
  now: '2026-01-01T00:00:00.000Z',
  prevHash: 'genesis',
  phase: 'READY',
  transitions: [],
  success: true,
  errorMessage: undefined,
  parsed: {},
  timestampAssurance: {
    enabled: false,
    mode: 'local_only',
    strict: false,
    criticalEvents: [],
    ntpDriftThresholdMs: 30000,
    tsaTimeoutMs: 10000,
  },
};

const state = {
  policySnapshot: {
    requestedMode: 'state-requested',
    mode: 'state-effective',
    source: 'state-source',
    effectiveGateBehavior: 'state-gate',
    degradedReason: 'state-reason',
    resolutionReason: 'state-resolution',
    centralMinimumMode: 'state-minimum',
    policyDigest: 'state-digest',
  },
} as unknown as SessionState;

describe('buildLifecycleDetail', () => {
  it('uses parsed policy resolution fields before state and policy fallbacks', () => {
    const detail = buildLifecycleDetail(
      {
        ...baseCtx,
        parsed: {
          policyResolution: {
            requestedMode: 'parsed-requested',
            effectiveMode: 'parsed-effective',
            source: 'parsed-source',
            effectiveGateBehavior: 'parsed-gate',
            reason: 'parsed-reason',
            resolutionReason: 'parsed-resolution',
            centralMinimumMode: 'parsed-minimum',
            centralPolicyDigest: 'parsed-digest',
          },
        },
      },
      'session_created',
      state,
      { mode: 'policy-mode', requireHumanGates: true },
    );

    expect(detail.finalPhase).toBe('READY');
    expect(detail.reason).toBe(
      'requested_mode:parsed-requested;effective_mode:parsed-effective;source:parsed-source;effective_gate_behavior:parsed-gate;reason:parsed-reason;resolution_reason:parsed-resolution;central_minimum_mode:parsed-minimum;central_policy_digest:parsed-digest',
    );
  });

  it('uses state fallbacks before policy/default fallbacks', () => {
    const detail = buildLifecycleDetail(baseCtx, 'session_created', state, {
      mode: 'policy-mode',
      requireHumanGates: false,
    });

    expect(detail.reason).toBe(
      'requested_mode:state-requested;effective_mode:state-effective;source:state-source;effective_gate_behavior:state-gate;reason:state-reason;resolution_reason:state-resolution;central_minimum_mode:state-minimum;central_policy_digest:state-digest',
    );
  });

  it('uses policy/default fallbacks and final transition phase without reason for completion', () => {
    const detail = buildLifecycleDetail(
      {
        ...baseCtx,
        transitions: [{ event: 'APPROVE', from: 'IMPLEMENTATION', to: 'COMPLETE', at: 'now' }],
      },
      'session_completed',
      null,
      { mode: 'policy-mode', requireHumanGates: true },
    );

    expect(detail).toEqual({ action: 'session_completed', finalPhase: 'COMPLETE' });
  });

  it('uses policy/default fallbacks for created sessions when state is absent', () => {
    const detail = buildLifecycleDetail(baseCtx, 'session_created', null, {
      mode: 'policy-mode',
      requireHumanGates: true,
    });

    expect(detail.reason).toBe(
      'requested_mode:policy-mode;effective_mode:policy-mode;source:unknown;effective_gate_behavior:human_gated;reason:none;resolution_reason:none;central_minimum_mode:none;central_policy_digest:none',
    );
  });
});

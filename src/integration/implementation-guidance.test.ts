/**
 * @module integration/implementation-guidance.test
 * @description Focused projection tests for runtime implementation guidance.
 */

import { describe, expect, it } from 'vitest';

import { extractDiscoveryHealth } from '../discovery/discovery-health.js';
import { makeDiscoveryResult } from '../discovery/discovery-test-fixtures.js';
import { makeState, PLAN_RECORD, TICKET } from '../__fixtures__.js';
import { buildImplementationGuidance } from './implementation-guidance.js';

describe('buildImplementationGuidance', () => {
  it('builds compact task-specific guidance from task text and discovery evidence', () => {
    const discovery = makeDiscoveryResult();
    const state = makeState('IMPLEMENTATION', {
      ticket: { ...TICKET, text: 'Fix login auth bug in src/auth/login.ts' },
      plan: PLAN_RECORD,
      verificationCandidates: [
        {
          kind: 'test',
          command: 'npm test -- login',
          source: 'package.json:scripts.test',
          confidence: 'high',
          reason: 'Vitest test script detected',
        },
      ],
    });

    const guidance = buildImplementationGuidance({
      state,
      discovery,
      discoveryHealth: extractDiscoveryHealth(discovery),
    });

    expect(guidance.kind).toBe('derived_implementation_guidance');
    expect(guidance.advisory).toBe(true);
    expect(guidance.runtimeOnly).toBe(true);
    expect(guidance.confidence).toBe('high');
    expect(guidance.relevantFiles[0]).toMatchObject({
      path: 'src/auth/login.ts',
      confidence: 'high',
      source: 'task_text_and_discovery',
    });
    expect(guidance.modules[0]).toMatchObject({ path: 'src/auth' });
    expect(guidance.tests[0]).toMatchObject({
      label: 'npm test -- login',
      source: 'session_verification_candidates',
    });
    expect(guidance.notVerified.join('\n')).toContain('never overrides');
  });

  it('caps confidence and marks NOT_VERIFIED when discovery is degraded', () => {
    const discovery = makeDiscoveryResult({
      diagnostics: [
        { name: 'code-surface-analysis', status: 'failed', durationMs: 1, timedOut: true },
      ],
      codeSurfaces: {
        ...makeDiscoveryResult().codeSurfaces!,
        budget: { ...makeDiscoveryResult().codeSurfaces!.budget, budgetExhausted: true },
      },
    });

    const guidance = buildImplementationGuidance({
      state: makeState('IMPLEMENTATION', {
        ticket: { ...TICKET, text: 'Fix login auth bug in src/auth/login.ts' },
      }),
      discovery,
      discoveryHealth: extractDiscoveryHealth(discovery),
    });

    expect(guidance.confidence).toBe('medium');
    expect(guidance.warnings.map((warning) => warning.code)).toContain('discovery_degraded');
    expect(guidance.warnings.map((warning) => warning.code)).toContain(
      'discovery_budget_exhausted',
    );
    expect(guidance.notVerified.join('\n')).toContain('degraded');
  });

  it('does not leak discovery-only files when task text does not corroborate them', () => {
    const discovery = makeDiscoveryResult();

    const guidance = buildImplementationGuidance({
      state: makeState('IMPLEMENTATION', {
        ticket: { ...TICKET, text: 'Update release notes wording' },
      }),
      discovery,
      discoveryHealth: extractDiscoveryHealth(discovery),
    });

    expect(guidance.relevantFiles).toHaveLength(0);
    expect(guidance.modules).toHaveLength(0);
    expect(guidance.surfaces).toHaveLength(0);
    expect(guidance.contracts).toHaveLength(0);
    expect(guidance.confidence).toBe('none');
    expect(guidance.notVerified.join('\n')).toContain('No matching');
  });

  it('surfaces high-risk surface warnings and risk hotspots', () => {
    const discovery = makeDiscoveryResult({
      surfaces: {
        ...makeDiscoveryResult().surfaces,
        security: [
          {
            id: 'auth-policy',
            label: 'Auth policy boundary',
            classification: 'fact',
            evidence: ['src/auth/policy.ts'],
          },
        ],
      },
      codeSurfaces: {
        ...makeDiscoveryResult().codeSurfaces!,
        authBoundaries: [
          {
            id: 'auth-check',
            label: 'auth check',
            confidence: 0.9,
            classification: 'fact',
            evidence: ['src/auth/policy.ts'],
            location: 'src/auth/policy.ts',
          },
        ],
      },
    });

    const guidance = buildImplementationGuidance({
      state: makeState('IMPLEMENTATION', {
        ticket: { ...TICKET, text: 'Fix auth policy behavior' },
      }),
      discovery,
      discoveryHealth: extractDiscoveryHealth(discovery),
    });

    expect(guidance.warnings.map((warning) => warning.code)).toContain('high_risk_surface_present');
    expect(guidance.riskHotspots.some((hotspot) => hotspot.path === 'src/auth/policy.ts')).toBe(
      true,
    );
  });

  it('surfaces blocked riskGate as a risk hotspot without changing gate state', () => {
    const discovery = makeDiscoveryResult();
    const state = makeState('IMPLEMENTATION', {
      ticket: { ...TICKET, text: 'Update release notes wording' },
      riskGate: {
        status: 'blocked',
        code: 'RISK_CLASSIFICATION_REQUIRED',
        message: 'Runtime evidence requires HIGH-RISK classification.',
        blockedAt: '2026-01-01T00:00:00.000Z',
        lastDecisionId: 'risk-decision-1',
      },
    });

    const guidance = buildImplementationGuidance({
      state,
      discovery,
      discoveryHealth: extractDiscoveryHealth(discovery),
    });

    expect(guidance.warnings.map((warning) => warning.code)).toContain('risk_gate_blocked');
    expect(guidance.riskHotspots[0]).toMatchObject({
      label: 'RISK_CLASSIFICATION_REQUIRED',
      source: 'session_risk_gate',
    });
    expect(state.riskGate?.status).toBe('blocked');
  });

  it('returns explicit unavailable guidance when discovery is missing', () => {
    const guidance = buildImplementationGuidance({
      state: makeState('IMPLEMENTATION', { ticket: TICKET }),
      discovery: null,
      discoveryHealth: null,
    });

    expect(guidance.confidence).toBe('none');
    expect(guidance.source.discovery).toBe('unavailable');
    expect(guidance.warnings.map((warning) => warning.code)).toContain('discovery_unavailable');
    expect(guidance.notVerified.join('\n')).toContain('unavailable');
  });
});

/**
 * @module integration/implementation-guidance.test
 * @description Focused projection tests for runtime implementation guidance.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  extractDiscoveryHealth,
  unavailableDiscoveryHealth,
  type DiscoveryHealthProjection,
} from '../discovery/discovery-health.js';
import { makeDiscoveryResult } from '../discovery/discovery-test-fixtures.js';
import type { DiscoveryResult } from '../discovery/types.js';
import { IMPL_EVIDENCE, makeState, PLAN_RECORD, TICKET } from '../fixtures.js';
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import type { VerificationCandidate } from '../state/discovery-schemas.js';
import type { SessionState } from '../state/schema.js';
import { buildImplementationGuidance } from './implementation-guidance.js';

describe('buildImplementationGuidance', () => {
  it('builds compact task-specific guidance from task text and discovery evidence', () => {
    const discovery = makeDiscoveryResult();
    const state = makeState('IMPLEMENTATION', {
      ticket: { ...TICKET, text: 'Fix login auth bug in src/auth/login.ts' },
      plan: PLAN_RECORD,
      verificationCandidates: [
        {
          assertionCapability: 'unsupported' as const,
          candidateId: 'vc_test_login',
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
        ...makeDiscoveryResult().codeSurfaces,
        budget: { ...makeDiscoveryResult().codeSurfaces.budget, budgetExhausted: true },
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

  it('keeps corroborated changed files when uncorroborated surfaces would fill the limit', () => {
    const discovery = makeDiscoveryResult({
      surfaces: {
        ...makeDiscoveryResult().surfaces,
        api: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map((label) => ({
          id: label,
          label,
          classification: 'fact' as const,
          evidence: [`lib/${label}.ts`],
        })),
      },
    });
    const state = makeState('IMPLEMENTATION', {
      ticket: { ...TICKET, text: 'Quieten frobnicator output' },
      implementation: {
        ...IMPL_EVIDENCE,
        changedFiles: ['zz/impl.ts'],
        domainFiles: ['zz/impl.ts'],
      },
    });

    const guidance = buildImplementationGuidance({
      state,
      discovery,
      discoveryHealth: extractDiscoveryHealth(discovery),
    });

    // Corroborated sections promise corroborated guidance up to the limit. The
    // session-owned changed file is corroborated even though it does not match
    // the task text, so the corroboration filter must run before truncation —
    // otherwise six discovery-only surfaces consume every slot and the changed
    // file disappears.
    expect(guidance.relevantFiles.map((item) => item.path)).toEqual(['zz/impl.ts']);
    expect(guidance.relevantFiles[0]).toMatchObject({
      source: 'session_implementation_evidence',
    });
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
        ...makeDiscoveryResult().codeSurfaces,
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

// ─── Canonical projection characterization ────────────────────────────────────
// Pins the complete canonical projection (ordering, deduplication, limits,
// confidence caps, sources, evidence, warnings, notVerified) across the
// ranking/corroboration pipeline refactor. Time is frozen because
// extractDiscoveryHealth derives an age warning from Date.now().

const FIXED_NOW = Date.parse('2026-01-01T01:00:00.000Z');

type UnsupportedCandidate = Extract<VerificationCandidate, { assertionCapability: 'unsupported' }>;

function candidate(overrides: Partial<UnsupportedCandidate> = {}): VerificationCandidate {
  const base: UnsupportedCandidate = {
    assertionCapability: 'unsupported',
    candidateId: 'vc_test',
    kind: 'test',
    command: 'npm test --',
    source: 'package.json:scripts.test',
    confidence: 'high',
    reason: 'Repo-native test script detected',
  };
  return { ...base, ...overrides };
}

type GuidanceHealthSpec = 'extract' | 'unavailable' | 'null';

interface GuidanceCharacterizationCase {
  readonly name: string;
  readonly state: SessionState;
  readonly discovery: DiscoveryResult | null;
  readonly health: GuidanceHealthSpec;
}

function resolveHealth(
  health: GuidanceHealthSpec,
  discovery: DiscoveryResult | null,
): DiscoveryHealthProjection | null {
  if (health === 'unavailable') return unavailableDiscoveryHealth('schema_invalid');
  if (health === 'extract' && discovery) return extractDiscoveryHealth(discovery);
  return null;
}

function matchingTaskState(overrides: Partial<SessionState> = {}): SessionState {
  return makeState('IMPLEMENTATION', {
    ticket: { ...TICKET, text: 'Fix login auth bug in src/auth/login.ts' },
    ...overrides,
  });
}

function makeCharacterizationCases(): GuidanceCharacterizationCase[] {
  const healthy = makeDiscoveryResult();
  const degraded = makeDiscoveryResult({
    diagnostics: [
      { name: 'code-surface-analysis', status: 'failed', durationMs: 1, timedOut: true },
    ],
    codeSurfaces: {
      ...makeDiscoveryResult().codeSurfaces,
      budget: { ...makeDiscoveryResult().codeSurfaces.budget, budgetExhausted: true },
    },
  });
  const richTaskState = matchingTaskState({
    plan: PLAN_RECORD,
    verificationCandidates: [
      candidate({ candidateId: 'vc_test', command: 'npm test -- login' }),
      candidate({
        candidateId: 'vc_coverage',
        kind: 'coverage',
        command: 'npm run coverage',
        source: 'package.json:scripts.coverage',
        reason: 'Repo-native coverage script detected',
      }),
      candidate({
        candidateId: 'vc_build',
        kind: 'build',
        command: 'npm run build',
        confidence: 'medium',
        source: 'package.json:scripts.build',
        reason: 'Repo-native build script detected',
      }),
    ],
  });
  const unpagedTestState = makeState('IMPLEMENTATION', {
    ticket: TICKET,
    verificationCandidates: [
      candidate({ candidateId: 'vc_test_1', command: 'npm test -- unit' }),
      candidate({
        candidateId: 'vc_test_2',
        kind: 'coverage',
        command: 'npm run coverage',
        source: 'package.json:scripts.coverage',
        reason: 'Repo-native coverage script detected',
      }),
      candidate({ candidateId: 'vc_test_3', command: 'npm test -- integration' }),
      candidate({
        candidateId: 'vc_test_4',
        kind: 'coverage',
        command: 'npm run coverage:ci',
        source: 'package.json:scripts.coverage:ci',
        reason: 'Repo-native coverage script detected',
      }),
      candidate({ candidateId: 'vc_test_5', command: 'npm test -- smoke' }),
      candidate({
        candidateId: 'vc_test_6',
        kind: 'coverage',
        command: 'npm run coverage:all',
        source: 'package.json:scripts.coverage:all',
        reason: 'Repo-native coverage script detected',
      }),
    ],
  });
  const blockedRiskGateState = matchingTaskState({
    riskGate: {
      status: 'blocked',
      code: 'RISK_CLASSIFICATION_REQUIRED',
      message: 'Runtime evidence requires HIGH-RISK classification.',
      blockedAt: '2026-01-01T00:00:00.000Z',
      lastDecisionId: 'risk-decision-1',
    },
  });
  const noMatchState = makeState('IMPLEMENTATION', {
    ticket: { ...TICKET, text: 'Quieten frobnicator output' },
  });
  const duplicateConfidenceState = makeState('IMPLEMENTATION', {
    ticket: TICKET,
    verificationCandidates: [
      candidate({
        candidateId: 'vc_low',
        command: 'npm run verify',
        confidence: 'low',
        source: 'package.json:scripts.verify',
        reason: 'Generic verify script detected',
      }),
      candidate({
        candidateId: 'vc_high',
        command: 'npm run verify',
        confidence: 'high',
        source: 'package.json:scripts.verify-native',
        reason: 'Repo-native verify script detected',
      }),
    ],
  });
  const equalConfidenceState = makeState('IMPLEMENTATION', {
    ticket: { ...TICKET, text: 'Fix login auth bug in src/auth/login.ts' },
    verificationCandidates: [
      candidate({
        candidateId: 'vc_first',
        command: 'npm run verify',
        source: 'package.json:scripts.verify',
        reason: 'Unrelated release note change',
      }),
      candidate({
        candidateId: 'vc_second',
        command: 'npm run verify',
        source: 'package.json:scripts.verify',
        reason: 'login auth fix detected',
      }),
    ],
  });
  const corroborationBeforeLimitDiscovery = makeDiscoveryResult({
    surfaces: {
      ...makeDiscoveryResult().surfaces,
      api: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map((label) => ({
        id: label,
        label,
        classification: 'fact' as const,
        evidence: [`lib/${label}.ts`],
      })),
    },
  });
  const corroborationBeforeLimitState = makeState('IMPLEMENTATION', {
    ticket: { ...TICKET, text: 'Quieten frobnicator output' },
    implementation: {
      ...IMPL_EVIDENCE,
      changedFiles: ['zz/impl.ts'],
      domainFiles: ['zz/impl.ts'],
    },
  });

  return [
    {
      name: 'healthy discovery with matching task terms',
      state: richTaskState,
      discovery: healthy,
      health: 'extract',
    },
    {
      name: 'degraded discovery health caps confidence',
      state: matchingTaskState(),
      discovery: degraded,
      health: 'extract',
    },
    {
      name: 'unavailable discovery health projection',
      state: matchingTaskState(),
      discovery: healthy,
      health: 'unavailable',
    },
    {
      name: 'missing discovery health projection',
      state: matchingTaskState(),
      discovery: healthy,
      health: 'null',
    },
    {
      name: 'discovery artifact unavailable',
      state: makeState('IMPLEMENTATION', { ticket: TICKET }),
      discovery: null,
      health: 'null',
    },
    {
      name: 'discovery artifact unavailable leaves test items unpaged',
      state: unpagedTestState,
      discovery: null,
      health: 'null',
    },
    {
      name: 'blocked risk gate with matching task terms',
      state: blockedRiskGateState,
      discovery: healthy,
      health: 'extract',
    },
    {
      name: 'no matching task terms',
      state: noMatchState,
      discovery: healthy,
      health: 'extract',
    },
    {
      name: 'duplicate test candidates keep higher confidence evidence',
      state: duplicateConfidenceState,
      discovery: healthy,
      health: 'extract',
    },
    {
      name: 'equal-confidence duplicate commands keep the first ranked survivor',
      state: equalConfidenceState,
      discovery: healthy,
      health: 'extract',
    },
    {
      name: 'corroboration filtering precedes the limit truncation',
      state: corroborationBeforeLimitState,
      discovery: corroborationBeforeLimitDiscovery,
      health: 'extract',
    },
  ];
}

const CHARACTERIZATION_CASES = makeCharacterizationCases();

describe('buildImplementationGuidance characterization', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
  });

  it.each(CHARACTERIZATION_CASES)('$name', (testCase) => {
    const guidance = buildImplementationGuidance({
      state: testCase.state,
      discovery: testCase.discovery,
      discoveryHealth: resolveHealth(testCase.health, testCase.discovery),
    });

    expect(canonicalJsonStringify(guidance)).toMatchSnapshot();
  });
});

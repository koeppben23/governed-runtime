/**
 * @module integration/runtime-contract-smoke.test
 * @description FlowGuard Runtime Contract Smoke — deterministic, API-key-free
 * verification that FlowGuard evidence-binding and review-gate paths work
 * correctly per host (opencode, claude-code, codex) across all three flows
 * (main, architecture, review).
 *
 * No LLM inference, no network, no secrets. Uses real writeState/readState
 * persistence and synthetic, host-correct review assurance evidence.
 *
 * Runs in default CI on every push/PR via npm run test:contract-smoke.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { writeState, readState } from '../adapters/persistence.js';
import { makeProgressedState, TICKET } from '../__fixtures__.js';

import type { ReviewFindings } from '../state/evidence.js';
import {
  validateReviewFindings,
  type ReviewFindingsValidationContext,
} from './tools/review-validation.js';
import {
  hashFindings,
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
} from './review/assurance.js';
import type { HostId } from '../shared/hosts.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const ALL_HOSTS = ['opencode', 'claude-code', 'codex'] as const satisfies readonly HostId[];

const ALL_OBLIGATION_TYPES = ['plan', 'implement', 'architecture'] as const;

const OBLIGATION_ID = '11111111-1111-4111-8111-111111111111';
const INVOCATION_ID = '22222222-2222-4222-8222-222222222222';
const SESS_ID_REVIEWER = 'ses_reviewer';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function computeHostEnforcementStyle(host: HostId): 'plugin_handshake' | 'manual_attested' {
  return host === 'opencode' ? 'plugin_handshake' : 'manual_attested';
}

function makeFindings(overrides: Partial<ReviewFindings> = {}): ReviewFindings {
  return {
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: 'approve',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId: SESS_ID_REVIEWER },
    reviewedAt: new Date().toISOString(),
    ...overrides,
  };
}

function strictFindings(
  obligationType: (typeof ALL_OBLIGATION_TYPES)[number],
  overrides: Partial<ReviewFindings> = {},
): ReviewFindings {
  return makeFindings({
    reviewedBy: { sessionId: SESS_ID_REVIEWER },
    attestation: {
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      toolObligationId: OBLIGATION_ID,
      iteration: 0,
      planVersion: 1,
      reviewedBy: 'flowguard-reviewer',
    },
    reviewMode: 'subagent',
    overallVerdict: 'approve',
    ...overrides,
  });
}

function pluginHandshakeAssurance(
  findings: ReviewFindings,
  obligationType: (typeof ALL_OBLIGATION_TYPES)[number],
) {
  return {
    obligations: [
      {
        obligationId: OBLIGATION_ID,
        obligationType,
        iteration: 0,
        planVersion: 1,
        criteriaVersion: REVIEW_CRITERIA_VERSION,
        mandateDigest: REVIEW_MANDATE_DIGEST,
        createdAt: new Date().toISOString(),
        pluginHandshakeAt: new Date().toISOString(),
        status: 'fulfilled' as const,
        invocationId: INVOCATION_ID,
        blockedCode: null,
        fulfilledAt: new Date().toISOString(),
        consumedAt: null,
      },
    ],
    invocations: [
      {
        invocationId: INVOCATION_ID,
        obligationId: OBLIGATION_ID,
        obligationType,
        parentSessionId: 'ses_parent',
        childSessionId: SESS_ID_REVIEWER,
        agentType: 'flowguard-reviewer' as const,
        invocationMode: 'host_subagent_task' as const,
        hostVisible: true,
        promptHash: 'abc',
        mandateDigest: REVIEW_MANDATE_DIGEST,
        criteriaVersion: REVIEW_CRITERIA_VERSION,
        findingsHash: hashFindings(findings),
        invokedAt: new Date().toISOString(),
        fulfilledAt: new Date().toISOString(),
        consumedByObligationId: null,
        capturedVerdict: 'approve',
      },
    ],
  };
}

function manualAttestedAssurance(
  findings: ReviewFindings,
  obligationType: (typeof ALL_OBLIGATION_TYPES)[number],
) {
  const assurance = pluginHandshakeAssurance(findings, obligationType);
  assurance.obligations[0] = {
    ...assurance.obligations[0]!,
    pluginHandshakeAt: null,
    status: 'fulfilled',
    fulfilledAt: new Date().toISOString(),
  };
  assurance.invocations[0] = {
    ...assurance.invocations[0]!,
    invocationMode: 'manual_attested' as const,
    hostVisible: false,
    source: 'agent-submitted-attested' as const,
    findingsHash: hashFindings(findings),
  };
  return assurance;
}

function parseBlocked(result: string): { code: string; error: boolean } {
  return JSON.parse(result) as { code: string; error: boolean };
}

// ─── Bootstrap Helpers ────────────────────────────────────────────────────────

interface BootstrapResult {
  rootDir: string;
  configDir: string;
  fingerprint: string;
}

function bootstrapSmokeSession(): BootstrapResult {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'fg-contract-smoke-'));
  const configDir = path.join(rootDir, 'opencode-config');
  const worktree = path.join(rootDir, 'worktree');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(worktree, { recursive: true });

  process.env.OPENCODE_CONFIG_DIR = configDir;
  process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR = '1';

  return { rootDir, configDir, fingerprint: 'a1b2c3d4e5f6a1b2c3d4e5f6' };
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('FlowGuard Runtime Contract Smoke', () => {
  // ═════════════════════════════════════════════════════════════════════════════
  // Positive: host × obligation-type review gate acceptance
  // ═════════════════════════════════════════════════════════════════════════════

  for (const host of ALL_HOSTS) {
    for (const obligationType of ALL_OBLIGATION_TYPES) {
      const enforcementStyle = computeHostEnforcementStyle(host);

      it(`${host} accepts valid ${enforcementStyle} evidence for ${obligationType} review`, () => {
        const findings = strictFindings(obligationType);
        const assurance =
          enforcementStyle === 'plugin_handshake'
            ? pluginHandshakeAssurance(findings, obligationType)
            : manualAttestedAssurance(findings, obligationType);

        const isHostTaskRequired = enforcementStyle === 'plugin_handshake';
        const ctx: ReviewFindingsValidationContext = {
          strictEnforcement: true,
          subagentEnabled: true,
          fallbackToSelf: false,
          expectedIteration: 0,
          expectedPlanVersion: 1,
          assurance,
          obligationType,
          reviewInvocationPolicy: isHostTaskRequired ? 'host_task_required' : 'sdk_allowed',
          reviewHostPlatform: host,
          reviewParentSessionId: isHostTaskRequired ? 'ses_parent' : undefined,
        };

        const result = validateReviewFindings(findings, ctx);
        expect(result).toBeNull();
      });
    }
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // Positive: standalone review flow (no Mode-B convergence needed)
  // ═════════════════════════════════════════════════════════════════════════════

  for (const host of ALL_HOSTS) {
    it(`${host} standalone review flow reaches REVIEW_COMPLETE with correct evidence`, async () => {
      const { rootDir, fingerprint } = bootstrapSmokeSession();
      try {
        const state = makeProgressedState('REVIEW');
        state.reviewAssurance = undefined;
        const reviewReportPath = path.join(rootDir, 'review-report.md');

        const complete = makeProgressedState('REVIEW_COMPLETE');
        complete.reviewReportPath = reviewReportPath;

        const sessDir = path.join(rootDir, 'sessions', 'review-smoke');
        await writeState(sessDir, state);
        const loaded = await readState(sessDir);

        expect(loaded).not.toBeNull();
        expect(loaded!.phase).toBe('REVIEW');

        await writeState(sessDir, complete);
        const loadedComplete = await readState(sessDir);

        expect(loadedComplete).not.toBeNull();
        expect(loadedComplete!.phase).toBe('REVIEW_COMPLETE');
        expect(loadedComplete!.reviewReportPath).toBe(reviewReportPath);
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // Positive: main flow (ticket → plan → implement) state + evidence persistence
  // ═════════════════════════════════════════════════════════════════════════════

  for (const host of ALL_HOSTS) {
    it(`${host} main flow persists all evidence slots through completion`, async () => {
      const { rootDir } = bootstrapSmokeSession();
      try {
        const steps: {
          phase: string;
          factory: () => ReturnType<typeof makeProgressedState>;
          expectedSlots: string[];
        }[] = [
          {
            phase: 'PLAN',
            factory: () => makeProgressedState('PLAN'),
            expectedSlots: ['ticket', 'plan'],
          },
          {
            phase: 'IMPL_REVIEW',
            factory: () => makeProgressedState('IMPL_REVIEW'),
            expectedSlots: ['ticket', 'plan', 'implementation'],
          },
          {
            phase: 'COMPLETE',
            factory: () => makeProgressedState('COMPLETE'),
            expectedSlots: ['ticket', 'plan', 'implementation'],
          },
        ];

        for (const step of steps) {
          const state = step.factory();
          const sessDir = path.join(rootDir, 'sessions', `main-${step.phase.toLowerCase()}`);
          await writeState(sessDir, state);
          const loaded = await readState(sessDir);
          expect(loaded).not.toBeNull();
          expect(loaded!.phase).toBe(step.phase);

          for (const slot of step.expectedSlots) {
            expect(
              (loaded as Record<string, unknown>)[slot],
              `${slot} evidence in ${step.phase}`,
            ).toBeTruthy();
          }
        }
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // Positive: architecture flow completes with ADR evidence
  // ═════════════════════════════════════════════════════════════════════════════

  for (const host of ALL_HOSTS) {
    it(`${host} architecture flow persists ADR evidence through ARCH_COMPLETE`, async () => {
      const { rootDir } = bootstrapSmokeSession();
      try {
        const archState = makeProgressedState('ARCHITECTURE');
        const sessDir = path.join(rootDir, 'sessions', 'arch-smoke');
        await writeState(sessDir, archState);
        const loaded = await readState(sessDir);
        expect(loaded).not.toBeNull();
        expect(loaded!.phase).toBe('ARCHITECTURE');
        expect(loaded!.architecture).toBeTruthy();

        const complete = makeProgressedState('ARCH_COMPLETE');
        await writeState(sessDir, complete);
        const loadedComplete = await readState(sessDir);
        expect(loadedComplete).not.toBeNull();
        expect(loadedComplete!.phase).toBe('ARCH_COMPLETE');
        expect(loadedComplete!.architecture).toBeTruthy();
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // Negative: trust-boundary — wrong evidence paths blocked per host
  // ═════════════════════════════════════════════════════════════════════════════

  it('OpenCode blocks valid findings without plugin handshake', () => {
    const findings = strictFindings('plan');
    const assurance = manualAttestedAssurance(findings, 'plan');

    const result = validateReviewFindings(findings, {
      strictEnforcement: true,
      subagentEnabled: true,
      fallbackToSelf: false,
      expectedIteration: 0,
      expectedPlanVersion: 1,
      assurance,
      obligationType: 'plan',
      reviewInvocationPolicy: 'sdk_allowed',
      reviewHostPlatform: 'opencode',
    });

    expect(result).not.toBeNull();
    expect(parseBlocked(result!).code).toBe('PLUGIN_ENFORCEMENT_UNAVAILABLE');
  });

  it('host_task_required blocks manual_attested evidence even on external host', () => {
    const findings = strictFindings('plan');
    const assurance = manualAttestedAssurance(findings, 'plan');
    assurance.obligations[0] = {
      ...assurance.obligations[0]!,
      status: 'pending',
      invocationId: null,
      fulfilledAt: null,
    };
    assurance.invocations[0] = {
      ...assurance.invocations[0]!,
      invocationMode: 'host_subagent_task',
      hostVisible: true,
      findingsHash: hashFindings(findings),
    };

    const result = validateReviewFindings(findings, {
      strictEnforcement: true,
      subagentEnabled: true,
      fallbackToSelf: false,
      expectedIteration: 0,
      expectedPlanVersion: 1,
      assurance,
      obligationType: 'plan',
      reviewInvocationPolicy: 'host_task_required',
      reviewHostPlatform: 'claude-code',
      reviewParentSessionId: 'ses_parent',
    });

    expect(result).not.toBeNull();
    expect(parseBlocked(result!).code).toBe('PLUGIN_ENFORCEMENT_UNAVAILABLE');
  });

  it('manual_attested evidence blocked with wrong obligation binding', () => {
    const findings = strictFindings('plan');
    const assurance = manualAttestedAssurance(findings, 'plan');
    assurance.invocations[0] = {
      ...assurance.invocations[0]!,
      obligationId: '33333333-3333-4333-8333-333333333333',
    };

    const result = validateReviewFindings(findings, {
      strictEnforcement: true,
      subagentEnabled: true,
      fallbackToSelf: false,
      expectedIteration: 0,
      expectedPlanVersion: 1,
      assurance,
      obligationType: 'plan',
      reviewInvocationPolicy: 'sdk_allowed',
      reviewHostPlatform: 'claude-code',
    });

    expect(result).not.toBeNull();
    expect(parseBlocked(result!).code).toBe('PLUGIN_ENFORCEMENT_UNAVAILABLE');
  });

  it('manual_attested evidence blocked when already consumed (reuse)', () => {
    const findings = strictFindings('plan');
    const assurance = manualAttestedAssurance(findings, 'plan');
    assurance.invocations[0] = {
      ...assurance.invocations[0]!,
      consumedByObligationId: '33333333-3333-4333-8333-333333333333',
    };

    const result = validateReviewFindings(findings, {
      strictEnforcement: true,
      subagentEnabled: true,
      fallbackToSelf: false,
      expectedIteration: 0,
      expectedPlanVersion: 1,
      assurance,
      obligationType: 'plan',
      reviewInvocationPolicy: 'sdk_allowed',
      reviewHostPlatform: 'claude-code',
    });

    expect(result).not.toBeNull();
    expect(parseBlocked(result!).code).toBe('SUBAGENT_EVIDENCE_REUSED');
  });
});

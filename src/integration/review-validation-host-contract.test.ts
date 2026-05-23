/**
 * @module integration/review-validation-host-contract.test
 * @description Host-specific contract tests for FlowGuard's canonical
 * review-evidence gate (validateReviewFindings) and assurance lifecycle
 * (createReviewObligation, appendReviewObligation,
 * consumeReviewObligation, appendInvocationEvidence).
 *
 * Validates that FlowGuard correctly accepts or blocks review
 * invocation evidence per host platform (opencode, claude-code, codex)
 * and per obligation type (plan, implement, architecture).
 *
 * Additionally exercises the assurance lifecycle with real writeState /
 * readState persistence on temporary directories to prove that
 * obligations, invocations, consumption, and state evidence slots
 * interact correctly across all three obligation types and host
 * enforcement profiles.
 *
 * Host enforcement matrix:
 *   opencode   — requires pluginHandshakeAt + host_subagent_task
 *   claude-code — accepts manual_attested without pluginHandshakeAt
 *   codex       — accepts manual_attested without pluginHandshakeAt
 *
 * No LLM inference, no network, no secrets. No tool.execute() calls.
 */

import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { writeState, readState } from '../adapters/persistence.js';
import {
  makeState,
  TICKET,
  PLAN_RECORD,
  ARCHITECTURE_DECISION,
  IMPL_EVIDENCE,
} from '../__fixtures__.js';

import type {
  ReviewFindings,
  ReviewObligation,
  ReviewInvocationEvidence,
} from '../state/evidence.js';
import {
  validateReviewFindings,
  type ReviewFindingsValidationContext,
} from './tools/review-validation.js';
import {
  createReviewObligation,
  appendReviewObligation,
  consumeReviewObligation,
  appendInvocationEvidence,
  hashFindings,
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
} from './review/assurance.js';
import type { HostId } from '../shared/hosts.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const ALL_HOSTS = ['opencode', 'claude-code', 'codex'] as const satisfies readonly HostId[];
const ALL_OBLIGATION_TYPES = ['plan', 'implement', 'architecture'] as const;
const NOW = new Date().toISOString();
const DECIDED_BY = 'reviewer-1';

const OBLIGATION_ID = '11111111-1111-4111-8111-111111111111';
const INVOCATION_ID = '22222222-2222-4222-8222-222222222222';
const INVOCATION_ID_PLAN = '33333333-3333-4333-8333-333333333333';
const INVOCATION_ID_IMPL = '44444444-4444-4444-8444-444444444444';
const INVOCATION_ID_ARCH = '55555555-5555-4555-8555-555555555555';
const SESS_ID_REVIEWER = 'ses_reviewer';

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

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
    reviewedAt: NOW,
    ...overrides,
  };
}

function strictFindings(overrides: Partial<ReviewFindings> = {}): ReviewFindings {
  return makeFindings({
    attestation: {
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      toolObligationId: OBLIGATION_ID,
      iteration: 0,
      planVersion: 1,
      reviewedBy: 'flowguard-reviewer',
    },
    ...overrides,
  });
}

function buildHostInvocation(
  host: HostId,
  obligation: ReviewObligation,
  findingsHash: string,
  invocationId = INVOCATION_ID,
): ReviewInvocationEvidence {
  const style = computeHostEnforcementStyle(host);
  return {
    invocationId,
    obligationId: obligation.obligationId,
    obligationType: obligation.obligationType,
    parentSessionId: 'ses_parent',
    childSessionId: SESS_ID_REVIEWER,
    agentType: 'flowguard-reviewer',
    invocationMode: style === 'plugin_handshake' ? 'host_subagent_task' : 'manual_attested',
    hostVisible: style === 'plugin_handshake',
    source: style === 'plugin_handshake' ? 'host-orchestrated' : 'agent-submitted-attested',
    promptHash: 'abc',
    mandateDigest: REVIEW_MANDATE_DIGEST,
    criteriaVersion: REVIEW_CRITERIA_VERSION,
    findingsHash,
    invokedAt: NOW,
    fulfilledAt: NOW,
    consumedByObligationId: null,
    capturedVerdict: style === 'plugin_handshake' ? 'approve' : undefined,
  };
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
        createdAt: NOW,
        pluginHandshakeAt: NOW,
        status: 'fulfilled' as const,
        invocationId: INVOCATION_ID,
        blockedCode: null,
        fulfilledAt: NOW,
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
        invokedAt: NOW,
        fulfilledAt: NOW,
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
  };
  assurance.invocations[0] = {
    ...assurance.invocations[0]!,
    invocationMode: 'manual_attested' as const,
    hostVisible: false,
    source: 'agent-submitted-attested' as const,
  };
  return assurance;
}

function parseBlocked(result: string): { code: string; error: boolean } {
  return JSON.parse(result) as { code: string; error: boolean };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Review Gate Contract Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('validateReviewFindings host contract', () => {
  for (const host of ALL_HOSTS) {
    for (const obligationType of ALL_OBLIGATION_TYPES) {
      const enforcementStyle = computeHostEnforcementStyle(host);

      it(`${host} accepts valid ${enforcementStyle} evidence for ${obligationType} review`, () => {
        const findings = strictFindings();
        const assurance =
          enforcementStyle === 'plugin_handshake'
            ? pluginHandshakeAssurance(findings, obligationType)
            : manualAttestedAssurance(findings, obligationType);

        const isHostTask = enforcementStyle === 'plugin_handshake';
        const result = validateReviewFindings(findings, {
          strictEnforcement: true,
          subagentEnabled: true,
          fallbackToSelf: false,
          expectedIteration: 0,
          expectedPlanVersion: 1,
          assurance,
          obligationType,
          reviewInvocationPolicy: isHostTask ? 'host_task_required' : 'sdk_allowed',
          reviewHostPlatform: host,
          reviewParentSessionId: isHostTask ? 'ses_parent' : undefined,
        });

        expect(result).toBeNull();
      });
    }
  }

  it('OpenCode blocks manual_attested evidence without plugin handshake', () => {
    const findings = strictFindings();
    const result = validateReviewFindings(findings, {
      strictEnforcement: true,
      subagentEnabled: true,
      fallbackToSelf: false,
      expectedIteration: 0,
      expectedPlanVersion: 1,
      assurance: manualAttestedAssurance(findings, 'plan'),
      obligationType: 'plan',
      reviewInvocationPolicy: 'sdk_allowed',
      reviewHostPlatform: 'opencode',
    });
    expect(result).not.toBeNull();
    expect(parseBlocked(result!).code).toBe('PLUGIN_ENFORCEMENT_UNAVAILABLE');
  });

  it('host_task_required blocks without plugin handshake even on external host', () => {
    const findings = strictFindings();
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

  it('manual_attested blocked with wrong obligation binding', () => {
    const findings = strictFindings();
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

  it('manual_attested blocked when evidence already consumed', () => {
    const findings = strictFindings();
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

// ─── Assurance lifecycle persistence matrix ─────────────────────

describe('assurance lifecycle persistence across hosts', () => {
  const hostContracts = ALL_HOSTS.map((host) => ({
    host,
    style: computeHostEnforcementStyle(host),
    isOpenCode: host === 'opencode',
  }));

  for (const { host, style, isOpenCode } of hostContracts) {
    describe(`${host} (${style})`, () => {
      let rootDir: string;

      function bootstrapSessDir(label: string): string {
        rootDir = mkdtempSync(path.join(tmpdir(), `fg-pipeline-${host}-`));
        return path.join(rootDir, 'sessions', label);
      }

      afterEach(() => {
        if (rootDir) rmSync(rootDir, { recursive: true, force: true });
      });

      // ── Plan + implement obligation lifecycle ──────────────────

      it('obligation lifecycle: plan creation → fulfilment → consumption, then implement repeat', async () => {
        const sessDir = bootstrapSessDir('main');

        // Phase 1: PLAN — create obligation
        const planState = makeState('PLAN', { ticket: TICKET, plan: PLAN_RECORD });
        const obligationP = createReviewObligation({
          obligationType: 'plan',
          iteration: 0,
          planVersion: 1,
          now: NOW,
        });
        const findingsP = strictFindings({ iteration: 0, planVersion: 1 });
        const fhP = hashFindings(findingsP);
        const invocationP = buildHostInvocation(host, obligationP, fhP, INVOCATION_ID_PLAN);

        let assurance = appendReviewObligation(undefined, obligationP);
        // Mark obligation fulfilled (as if plugin/agent completed review)
        assurance = {
          obligations: assurance.obligations.map((o) =>
            o.obligationId === obligationP.obligationId
              ? {
                  ...o,
                  status: 'fulfilled' as const,
                  fulfilledAt: NOW,
                  pluginHandshakeAt: isOpenCode ? NOW : null,
                }
              : o,
          ),
          invocations: assurance.invocations,
        };
        assurance = appendInvocationEvidence(assurance, invocationP);
        assurance = consumeReviewObligation(assurance, obligationP, NOW, INVOCATION_ID_PLAN);

        planState.reviewAssurance = assurance;
        planState.reviewDecision = {
          verdict: 'approve',
          rationale: 'LGTM',
          decidedAt: NOW,
          decidedBy: DECIDED_BY,
        };
        await writeState(sessDir, planState);
        let loaded = await readState(sessDir);
        expect(loaded).not.toBeNull();
        expect(loaded!.reviewAssurance?.obligations.length).toBe(1);
        expect(loaded!.reviewAssurance?.obligations[0]!.status).toBe('consumed');
        expect(loaded!.reviewAssurance?.invocations.length).toBe(1);

        // Phase 2: IMPLEMENTATION — create impl review obligation
        const implState = makeState('IMPLEMENTATION', {
          ticket: TICKET,
          plan: PLAN_RECORD,
          implementation: IMPL_EVIDENCE,
        });
        const obligationI = createReviewObligation({
          obligationType: 'implement',
          iteration: 0,
          planVersion: 1,
          now: NOW,
        });
        const findingsI = strictFindings({ iteration: 0, planVersion: 1 });
        const fhI = hashFindings(findingsI);
        const invocationI = buildHostInvocation(host, obligationI, fhI, INVOCATION_ID_IMPL);

        let implAssurance = appendReviewObligation(assurance, obligationI);
        implAssurance = {
          obligations: implAssurance.obligations.map((o) =>
            o.obligationId === obligationI.obligationId
              ? {
                  ...o,
                  status: 'fulfilled' as const,
                  fulfilledAt: NOW,
                  pluginHandshakeAt: isOpenCode ? NOW : null,
                }
              : o,
          ),
          invocations: implAssurance.invocations,
        };
        implAssurance = appendInvocationEvidence(implAssurance, invocationI);
        implAssurance = consumeReviewObligation(
          implAssurance,
          obligationI,
          NOW,
          INVOCATION_ID_IMPL,
        );

        implState.reviewAssurance = implAssurance;
        await writeState(sessDir, implState);
        loaded = await readState(sessDir);
        expect(loaded!.phase).toBe('IMPLEMENTATION');
        expect(loaded!.implementation).toBeTruthy();
        expect(loaded!.reviewAssurance?.obligations.length).toBe(2);
        expect(loaded!.reviewAssurance?.obligations.every((o) => o.status === 'consumed')).toBe(
          true,
        );

        // Phase 3: COMPLETE
        const completeState = makeState('COMPLETE', {
          ticket: TICKET,
          plan: PLAN_RECORD,
          implementation: IMPL_EVIDENCE,
          reviewAssurance: implAssurance,
        });
        await writeState(sessDir, completeState);
        loaded = await readState(sessDir);
        expect(loaded!.phase).toBe('COMPLETE');
        expect(loaded!.ticket).toBeTruthy();
        expect(loaded!.plan).toBeTruthy();
        expect(loaded!.implementation).toBeTruthy();
        expect(loaded!.reviewAssurance?.obligations.length).toBe(2);
      });

      // ── Architecture obligation lifecycle ────────────────────────

      it('obligation lifecycle: architecture creation → fulfilment → consumption + ADR persistence', async () => {
        const sessDir = bootstrapSessDir('arch');

        const archState = makeState('ARCHITECTURE', {
          architecture: { ...ARCHITECTURE_DECISION, status: 'proposed' },
        });
        const obligationA = createReviewObligation({
          obligationType: 'architecture',
          iteration: 0,
          planVersion: 1,
          now: NOW,
        });
        const findingsA = strictFindings({ iteration: 0, planVersion: 1 });
        const fhA = hashFindings(findingsA);
        const invocationA = buildHostInvocation(host, obligationA, fhA, INVOCATION_ID_ARCH);

        let archAssurance = appendReviewObligation(undefined, obligationA);
        archAssurance = {
          obligations: archAssurance.obligations.map((o) =>
            o.obligationId === obligationA.obligationId
              ? {
                  ...o,
                  status: 'fulfilled' as const,
                  fulfilledAt: NOW,
                  pluginHandshakeAt: isOpenCode ? NOW : null,
                }
              : o,
          ),
          invocations: archAssurance.invocations,
        };
        archAssurance = appendInvocationEvidence(archAssurance, invocationA);
        archAssurance = consumeReviewObligation(
          archAssurance,
          obligationA,
          NOW,
          INVOCATION_ID_ARCH,
        );

        archState.reviewAssurance = archAssurance;
        archState.reviewDecision = {
          verdict: 'approve',
          rationale: 'ADR accepted',
          decidedAt: NOW,
          decidedBy: DECIDED_BY,
        };
        await writeState(sessDir, archState);

        const complete = makeState('ARCH_COMPLETE', {
          architecture: { ...ARCHITECTURE_DECISION, status: 'accepted' },
          reviewAssurance: archAssurance,
          reviewDecision: {
            verdict: 'approve',
            rationale: 'ADR accepted',
            decidedAt: NOW,
            decidedBy: DECIDED_BY,
          },
        });
        await writeState(sessDir, complete);
        const loaded = await readState(sessDir);
        expect(loaded!.phase).toBe('ARCH_COMPLETE');
        expect(loaded!.architecture).toBeTruthy();
        expect(loaded!.reviewAssurance?.obligations[0]!.obligationType).toBe('architecture');
        expect(loaded!.reviewAssurance?.obligations[0]!.status).toBe('consumed');
      });

      // ── Review report persistence ─────────────────────────────────

      it('review report persistence: REVIEW → REVIEW_COMPLETE with report path', async () => {
        const sessDir = bootstrapSessDir('review');

        const reviewState = makeState('REVIEW');
        const reviewReportPath = path.join(sessDir, 'review-report.json');
        await writeState(sessDir, reviewState);
        let loaded = await readState(sessDir);
        expect(loaded!.phase).toBe('REVIEW');

        const completeState = makeState('REVIEW_COMPLETE', { reviewReportPath });
        await writeState(sessDir, completeState);
        loaded = await readState(sessDir);
        expect(loaded!.phase).toBe('REVIEW_COMPLETE');
        expect(loaded!.reviewReportPath).toBe(reviewReportPath);
      });
    });
  }
});

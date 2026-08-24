/**
 * @module integration/review/discovery-context-prompt.test
 * @description Tests for bounded Discovery context rendering in reviewer prompts.
 */

import { describe, expect, it, vi } from 'vitest';

import { unavailableDiscoveryHealth } from '../../discovery/discovery-health.js';
import { makeState, PLAN_RECORD, TICKET } from '../../fixtures.js';
import {
  buildDiscoveryDriftStatus,
  notCheckedDiscoveryDriftStatus,
} from '../discovery-drift-status.js';
import { buildImplementationGuidance } from '../implementation-guidance.js';
import { PLAN_REVIEW_DISCOVERY_INSTRUCTION } from '../../config/profiles/content/shared.js';
import {
  buildArchitectureReviewPrompt,
  buildImplReviewPrompt,
  buildPlanReviewPrompt,
  buildReviewContentPrompt,
} from './prompt-builders.js';
import {
  buildDiscoveryContextSection,
  type DiscoveryReviewContext,
} from './discovery-context-prompt.js';
import type { ImplementationGuidanceItem } from '../implementation-guidance.js';
import { buildReviewDiscoveryContextForPipeline } from './shared-helpers.js';
import type { PipelineContext } from './pipeline-types.js';

const BASE_CONTEXT: DiscoveryReviewContext = {
  health: {
    kind: 'derived_discovery_health',
    advisory: true,
    source: 'persisted_discovery_result',
    status: 'available',
    completeCollectors: 5,
    partialCollectors: 0,
    failedCollectors: 0,
    failedCollectorNames: [],
    hasBudgetExhaustion: false,
    readFailureCount: 0,
    codeSurfaceStatus: 'ok',
    collectedAt: '2026-01-01T00:00:00.000Z',
    ageWarning: null,
    healthy: true,
  },
  drift: {
    kind: 'derived_discovery_drift',
    advisory: true,
    runtimeOnly: true,
    source: 'checkDiscoveryDrift',
    status: 'clean',
    drifted: false,
    currentDigest: 'sha256-current',
    persistedDigest: 'sha256-persisted',
    changedContributorNames: [],
    diagnostics: [],
    notVerified: ['NOT_VERIFIED: Drift is advisory.'],
    warnings: [],
  },
  detectedStack: {
    summary: 'typescript=6.0.3, vitest',
    items: [
      { kind: 'language', id: 'typescript', version: '6.0.3', evidence: 'package.json' },
      { kind: 'testFramework', id: 'vitest', evidence: 'package.json:scripts.test' },
    ],
    versions: [
      { id: 'typescript', version: '6.0.3', target: 'language', evidence: 'package.json' },
    ],
  },
  verificationCandidates: [
    {
      assertionCapability: 'unsupported' as const,
      kind: 'test',
      command: 'npm test',
      source: 'package.json:scripts.test',
      confidence: 'high',
      reason: 'test script detected',
    },
  ],
  implementationGuidance: buildImplementationGuidance({
    state: makeState('IMPLEMENTATION', {
      ticket: { ...TICKET, text: 'Fix auth policy behavior' },
      plan: PLAN_RECORD,
      verificationCandidates: [
        {
          assertionCapability: 'unsupported' as const,
          kind: 'test',
          command: 'npm test',
          source: 'package.json:scripts.test',
          confidence: 'high',
          reason: 'test script detected',
        },
      ],
    }),
    discovery: null,
    discoveryHealth: unavailableDiscoveryHealth('missing'),
  }),
};

describe('buildDiscoveryContextSection', () => {
  it('renders one advisory Discovery Context section with repo-native candidates', () => {
    const section = buildDiscoveryContextSection(BASE_CONTEXT);

    expect(section.match(/## Discovery Context/g)).toHaveLength(1);
    expect(section).toContain('advisory falsification evidence, not review verdict authority');
    expect(section).toContain(
      'ReviewFindings, obligation binding, mandate digest, and attestation',
    );
    expect(section).toContain('npm test');
    expect(section).toContain('do not recommend only generic "run tests/build"');
  });

  it('renders unavailable Discovery as explicit NOT_VERIFIED instead of fake health', () => {
    const section = buildDiscoveryContextSection({
      health: unavailableDiscoveryHealth('corrupt'),
      drift: notCheckedDiscoveryDriftStatus('Discovery drift was not checked.'),
      verificationCandidates: [],
    });

    expect(section).toContain('status: unavailable');
    expect(section).toContain('reason: corrupt');
    expect(section).toContain('NOT_VERIFIED');
    expect(section).toContain('do not invent them');
  });

  it('renders degraded and drifted Discovery as review risk', () => {
    const section = buildDiscoveryContextSection({
      health: {
        kind: 'derived_discovery_health',
        advisory: true,
        source: 'persisted_discovery_result',
        status: 'available',
        healthy: false,
        completeCollectors: 4,
        partialCollectors: 0,
        failedCollectors: 1,
        failedCollectorNames: ['code-surface-analysis'],
        hasBudgetExhaustion: false,
        readFailureCount: 0,
        codeSurfaceStatus: 'ok',
        collectedAt: '2026-01-01T00:00:00.000Z',
        ageWarning: null,
      },
      drift: {
        ...BASE_CONTEXT.drift!,
        status: 'drifted',
        drifted: true,
        changedContributorNames: ['stack-detection'],
        warnings: [{ code: 'discovery_drifted', message: 'Repository changed since hydrate.' }],
      },
    });

    expect(section).toContain('failedCollectors: code-surface-analysis');
    expect(section).toContain('status: drifted');
    expect(section).toContain('changedContributors: stack-detection');
    expect(section).toContain('Discovery is degraded');
  });

  it('enforces bounds and does not dump full artifacts', () => {
    const section = buildDiscoveryContextSection({
      verificationCandidates: Array.from({ length: 10 }, (_, index) => ({
        assertionCapability: 'unsupported' as const,
        kind: 'test' as const,
        command: `npm test -- ${index}`,
        source: `package.json:${index}`,
        confidence: 'medium' as const,
        reason: 'bounded candidate',
      })),
      limits: { verificationCandidates: 2 },
    });

    expect(section).toContain('npm test -- 0');
    expect(section).toContain('npm test -- 1');
    expect(section).not.toContain('npm test -- 2');
    expect(section).not.toContain('"schemaVersion"');
  });
});

describe('review prompt Discovery context loading', () => {
  it('still produces explicit unavailable Discovery Context when context loading fails', async () => {
    const state = makeState('PLAN', { ticket: TICKET, plan: PLAN_RECORD });
    const ctx = {
      sessionState: state,
      deps: {
        resolveFingerprint: vi.fn().mockRejectedValue(new Error('fingerprint unavailable')),
        log: { warn: vi.fn(), info: vi.fn() },
        adapter: { getWorktree: () => '/tmp/repo' },
      },
    } as unknown as PipelineContext;

    const discoveryContext = await buildReviewDiscoveryContextForPipeline(ctx);
    const prompt = buildPlanReviewPrompt({
      planText: PLAN_RECORD.current.body,
      ticketText: TICKET.text,
      iteration: 0,
      planVersion: 1,
      obligationId: '11111111-1111-4111-8111-111111111111',
      criteriaVersion: 'p37-v1',
      mandateDigest: 'test-digest',
      discoveryContext,
    });

    expect(prompt).toContain('## Discovery Context');
    expect(prompt).toContain('status: unavailable');
    expect(prompt).toContain('NOT_VERIFIED');
    expect(prompt).toContain('workspace fingerprint could not be resolved');
  });

  it('injects Discovery Context into implementation prompts when provided', () => {
    const implPrompt = buildImplReviewPrompt({
      changedFiles: ['src/auth.ts'],
      planText: PLAN_RECORD.current.body,
      ticketText: TICKET.text,
      iteration: 1,
      planVersion: 2,
      obligationId: '11111111-1111-4111-8111-111111111111',
      criteriaVersion: 'p37-v1',
      mandateDigest: 'test-digest',
      discoveryContext: BASE_CONTEXT,
    });
    const contentPrompt = buildReviewContentPrompt({
      content: 'diff --git a/src/auth.ts b/src/auth.ts',
      ticketText: TICKET.text,
      obligationId: '11111111-1111-4111-8111-111111111111',
      criteriaVersion: 'p37-v1',
      mandateDigest: 'test-digest',
      iteration: 0,
      planVersion: 1,
    });

    expect(implPrompt.match(/## Discovery Context/g)).toHaveLength(1);
    expect(implPrompt).toContain('npm test');
    // Content scope without a repository frozen subject renders NO local
    // repository Discovery section at all.
    expect(contentPrompt).not.toContain('## Discovery Context');
  });

  it('injects Discovery Context into architecture review prompts without displacing attestation authority', () => {
    const archPrompt = buildArchitectureReviewPrompt({
      adrTitle: 'Use repository-native validation',
      adrText: 'ADR body',
      ticketText: TICKET.text,
      iteration: 0,
      planVersion: 1,
      obligationId: '11111111-1111-4111-8111-111111111111',
      criteriaVersion: 'p37-v1',
      mandateDigest: 'test-digest',
      discoveryContext: BASE_CONTEXT,
    });

    expect(archPrompt.match(/## Discovery Context/g)).toHaveLength(1);
    expect(archPrompt).toContain('advisory falsification evidence');
    expect(archPrompt).toContain('npm test');
    expect(archPrompt).toContain(
      'Set attestation.toolObligationId=11111111-1111-4111-8111-111111111111.',
    );
    expect(archPrompt).toContain(
      'Do not output reviewedBy, reviewedAt, mandateDigest, criteriaVersion, or attestation.reviewedBy',
    );
  });

  it('plan prompt with an unavailable discovery context renders NOT_VERIFIED and preserves attestation', () => {
    const prompt = buildPlanReviewPrompt({
      planText: PLAN_RECORD.current.body,
      ticketText: TICKET.text,
      iteration: 0,
      planVersion: 1,
      obligationId: '11111111-1111-4111-8111-111111111111',
      criteriaVersion: 'p37-v1',
      mandateDigest: 'test-digest',
      discoveryContext: {},
    });

    expect(prompt).toContain('## Discovery Context');
    expect(prompt).toContain('status: unavailable');
    expect(prompt).toContain('NOT_VERIFIED');
    expect(prompt).toContain(
      'Set attestation.toolObligationId=11111111-1111-4111-8111-111111111111.',
    );
    expect(prompt).toContain(
      'Do not output reviewedBy, reviewedAt, mandateDigest, criteriaVersion, or attestation.reviewedBy',
    );
  });

  it('impl prompt with an unavailable discovery context renders NOT_VERIFIED and preserves attestation', () => {
    const prompt = buildImplReviewPrompt({
      changedFiles: ['src/auth.ts'],
      planText: PLAN_RECORD.current.body,
      ticketText: TICKET.text,
      iteration: 1,
      planVersion: 2,
      obligationId: '11111111-1111-4111-8111-111111111111',
      criteriaVersion: 'p37-v1',
      mandateDigest: 'test-digest',
      discoveryContext: {},
    });

    expect(prompt).toContain('## Discovery Context');
    expect(prompt).toContain('status: unavailable');
    expect(prompt).toContain('NOT_VERIFIED');
    expect(prompt).toContain(
      'Set attestation.toolObligationId=11111111-1111-4111-8111-111111111111.',
    );
    expect(prompt).toContain(
      'Do not output reviewedBy, reviewedAt, mandateDigest, criteriaVersion, or attestation.reviewedBy',
    );
  });

  it('content prompt renders NO local repository Discovery section (content scope)', () => {
    const prompt = buildReviewContentPrompt({
      content: 'diff --git a/src/auth.ts b/src/auth.ts',
      ticketText: TICKET.text,
      obligationId: '11111111-1111-4111-8111-111111111111',
      criteriaVersion: 'p37-v1',
      mandateDigest: 'test-digest',
      iteration: 0,
      planVersion: 1,
    });

    // The scope rule: local repository Discovery must not confound external or
    // inline content subjects — no section, no instruction.
    expect(prompt).not.toContain('## Discovery Context');
    expect(prompt).not.toContain('Repository Discovery Contract');
    expect(prompt).toContain('toolObligationId: "11111111-1111-4111-8111-111111111111"');
    expect(prompt).not.toContain('mandateDigest: "test-digest"');
  });

  it('content prompt renders drift timeout as discovery_drift_timeout + NOT_VERIFIED (#401)', async () => {
    // Real runtime contract: a drift check timeout produces an explicit
    // status: "timeout" projection with a discovery_drift_timeout warning,
    // NOT a silent "not_checked" status. Use a check that never resolves with
    // a 1ms bound to exercise the genuine timeout path.
    const driftTimeout = await buildDiscoveryDriftStatus({
      workspaceDir: '/tmp/ws',
      worktree: '/tmp/repo',
      fingerprint: 'fp-1',
      timeoutMs: 1,
      check: () => new Promise(() => {}),
    });

    expect(driftTimeout.status).toBe('timeout');
    expect(driftTimeout.warnings[0]?.code).toBe('discovery_drift_timeout');
  });

  it('plan prompt with discovery context preserves attestation wording', () => {
    const prompt = buildPlanReviewPrompt({
      planText: PLAN_RECORD.current.body,
      ticketText: TICKET.text,
      iteration: 0,
      planVersion: 1,
      obligationId: '11111111-1111-4111-8111-111111111111',
      criteriaVersion: 'p37-v1',
      mandateDigest: 'test-digest',
      discoveryContext: BASE_CONTEXT,
    });

    expect(prompt.match(/## Discovery Context/g)).toHaveLength(1);
    expect(prompt).toContain(
      'Set attestation.toolObligationId=11111111-1111-4111-8111-111111111111.',
    );
    expect(prompt).toContain(
      'Do not output reviewedBy, reviewedAt, mandateDigest, criteriaVersion, or attestation.reviewedBy',
    );
  });

  it('impl prompt with discovery context preserves attestation wording', () => {
    const prompt = buildImplReviewPrompt({
      changedFiles: ['src/auth.ts'],
      planText: PLAN_RECORD.current.body,
      ticketText: TICKET.text,
      iteration: 1,
      planVersion: 2,
      obligationId: '11111111-1111-4111-8111-111111111111',
      criteriaVersion: 'p37-v1',
      mandateDigest: 'test-digest',
      discoveryContext: BASE_CONTEXT,
    });

    expect(prompt.match(/## Discovery Context/g)).toHaveLength(1);
    expect(prompt).toContain(
      'Set attestation.toolObligationId=11111111-1111-4111-8111-111111111111.',
    );
    expect(prompt).toContain(
      'Do not output reviewedBy, reviewedAt, mandateDigest, criteriaVersion, or attestation.reviewedBy',
    );
  });

  it('content prompt preserves attestation wording without a Discovery section', () => {
    const prompt = buildReviewContentPrompt({
      content: 'diff --git a/src/auth.ts b/src/auth.ts',
      ticketText: TICKET.text,
      obligationId: '11111111-1111-4111-8111-111111111111',
      criteriaVersion: 'p37-v1',
      mandateDigest: 'test-digest',
      iteration: 0,
      planVersion: 1,
    });

    expect(prompt).not.toContain('## Discovery Context');
    expect(prompt).toContain('toolObligationId: "11111111-1111-4111-8111-111111111111"');
    expect(prompt).not.toContain('mandateDigest: "test-digest"');
  });

  it('renders surfaces and modules from implementation guidance', () => {
    const context: DiscoveryReviewContext = {
      ...BASE_CONTEXT,
      implementationGuidance: {
        confidence: 'high',
        warnings: [],
        notVerified: [],
        relevantFiles: [],
        surfaces: [
          {
            label: 'auth',
            path: 'src/auth.ts',
            source: 'persisted_discovery_result',
            confidence: 'high',
            evidence: [],
          },
        ],
        modules: [
          {
            label: 'auth-module',
            path: 'src/auth/index.ts',
            source: 'persisted_discovery_result',
            confidence: 'medium',
            evidence: [],
          },
        ],
        contracts: [],
        riskHotspots: [],
        tests: [],
      },
    };

    const section = buildDiscoveryContextSection(context);
    expect(section).toContain('src/auth/index.ts');
    expect(section).toContain('auth-module');
  });

  it('bounds surfaces and modules to configured limits', () => {
    const manySurfaces: ImplementationGuidanceItem[] = Array.from({ length: 10 }, (_, i) => ({
      label: `surface-${i}`,
      path: `src/${i}.ts`,
      source: 'persisted_discovery_result',
      confidence: 'medium' as const,
      evidence: [],
    }));
    const manyModules: ImplementationGuidanceItem[] = Array.from({ length: 10 }, (_, i) => ({
      label: `module-${i}`,
      path: `src/mod/${i}.ts`,
      source: 'persisted_discovery_result',
      confidence: 'medium' as const,
      evidence: [],
    }));
    const context: DiscoveryReviewContext = {
      health: BASE_CONTEXT.health,
      drift: BASE_CONTEXT.drift,
      verificationCandidates: [],
      implementationGuidance: {
        confidence: 'high',
        warnings: [],
        notVerified: [],
        relevantFiles: [],
        surfaces: manySurfaces,
        modules: manyModules,
        contracts: [],
        riskHotspots: [],
        tests: [],
      },
      limits: { surfaces: 3, modules: 2 },
    };

    const section = buildDiscoveryContextSection(context);
    expect(section).toContain('surface-0');
    expect(section).toContain('surface-2');
    expect(section).not.toContain('surface-3');
    expect(section).toContain('module-0');
    expect(section).toContain('module-1');
    expect(section).not.toContain('module-2');
  });

  it('plan prompt with profile rules includes Discovery Evidence Check instruction', () => {
    const prompt = buildPlanReviewPrompt({
      planText: PLAN_RECORD.current.body,
      ticketText: TICKET.text,
      iteration: 0,
      planVersion: 1,
      obligationId: '11111111-1111-4111-8111-111111111111',
      criteriaVersion: 'p37-v1',
      mandateDigest: 'test-digest',
      profileRules: PLAN_REVIEW_DISCOVERY_INSTRUCTION,
      discoveryContext: BASE_CONTEXT,
    });

    expect(prompt.match(/## Discovery Context/g)).toHaveLength(1);
    expect(prompt).toContain('Discovery Evidence Check');
    expect(prompt).not.toContain('flowguard_status.detectedStack');
    expect(prompt).not.toContain('<examples>');
  });
});

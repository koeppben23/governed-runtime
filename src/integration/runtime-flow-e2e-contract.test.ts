/**
 * @module integration/runtime-flow-e2e-contract.test
 * @description FlowGuard tool-level E2E contract smoke.
 *
 * Calls actual tool.execute() methods with real git worktrees and
 * real persistence across all host profiles. Tests the complete
 * architecture flow and plan evidence binding for the main flow.
 *
 * Host profiles: opencode (plugin_handshake), claude-code and codex (manual_attested).
 * No LLM inference, no network, no secrets.
 *
 * @see review-validation-host-contract.test.ts for host gate-level tests.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { readState } from '../adapters/persistence.js';
import { sessionDir } from '../adapters/workspace/index.js';
import { computeFingerprint } from '../adapters/workspace/fingerprint.js';
import { writeStateWithArtifacts } from './tools/helpers.js';
import type { HostId } from '../shared/hosts.js';

import { plan } from './tools/plan.js';
import { architecture } from './tools/architecture.js';
import type { ToolContext } from './tools/helpers.js';
import type {
  ReviewFindings,
  ReviewObligation,
  ReviewInvocationEvidence,
} from '../state/evidence.js';
import {
  createReviewObligation,
  appendReviewObligation,
  consumeReviewObligation,
  appendInvocationEvidence,
  hashFindings,
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
} from './review/assurance.js';
import { makeState, TICKET } from '../__fixtures__.js';
import type { SessionState } from '../state/schema.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const ALL_HOSTS = ['opencode', 'claude-code', 'codex'] as const satisfies readonly HostId[];
const NOW = () => new Date().toISOString();
const DECIDED_BY = 'reviewer-1';

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function computeHostEnforcementStyle(host: HostId): 'plugin_handshake' | 'manual_attested' {
  return host === 'opencode' ? 'plugin_handshake' : 'manual_attested';
}

function strictFindings(
  obligationId: string,
  overrides: Partial<ReviewFindings> = {},
): ReviewFindings {
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
    reviewedBy: { sessionId: 'ses_reviewer' },
    reviewedAt: NOW(),
    attestation: {
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      toolObligationId: obligationId,
      iteration: 0,
      planVersion: 1,
      reviewedBy: 'flowguard-reviewer',
    },
    ...overrides,
  };
}

function buildHostInvocation(
  host: HostId,
  obligation: ReviewObligation,
  findingsHash: string,
  invocationId: string,
): ReviewInvocationEvidence {
  const style = computeHostEnforcementStyle(host);
  return {
    invocationId,
    obligationId: obligation.obligationId,
    obligationType: obligation.obligationType,
    parentSessionId: 'ses_parent',
    childSessionId: 'ses_reviewer',
    agentType: 'flowguard-reviewer',
    invocationMode: style === 'plugin_handshake' ? 'host_subagent_task' : 'manual_attested',
    hostVisible: style === 'plugin_handshake',
    source: style === 'plugin_handshake' ? 'host-orchestrated' : 'agent-submitted-attested',
    promptHash: 'abc',
    mandateDigest: REVIEW_MANDATE_DIGEST,
    criteriaVersion: REVIEW_CRITERIA_VERSION,
    findingsHash,
    invokedAt: NOW(),
    fulfilledAt: NOW(),
    consumedByObligationId: null,
    capturedVerdict: style === 'plugin_handshake' ? 'approve' : undefined,
  };
}

interface E2ESession {
  rootDir: string;
  worktree: string;
  configDir: string;
  sessionId: string;
  sessDir: string;
  toolContext: ToolContext;
}

async function bootstrapE2ESession(host: HostId, label: string): Promise<E2ESession> {
  const rootDir = mkdtempSync(path.join(tmpdir(), `fg-e2e-${host}-${label}-`));
  const worktree = path.join(rootDir, 'worktree');
  const configDir = path.join(rootDir, 'config');
  const sessionId = randomUUID();
  mkdirSync(worktree, { recursive: true });
  mkdirSync(configDir, { recursive: true });

  execSync('git init', { cwd: worktree, stdio: 'pipe' });
  execSync('git config user.email t@t && git config user.name T', { cwd: worktree, stdio: 'pipe' });
  writeFileSync(path.join(worktree, 'README.md'), '# E2E');
  execSync('git add README.md && git commit -m init', { cwd: worktree, stdio: 'pipe' });
  execSync('git remote add origin https://github.com/fg/e2e.git', { cwd: worktree, stdio: 'pipe' });

  process.env.OPENCODE_CONFIG_DIR = configDir;
  process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR = '1';
  process.env.FLOWGUARD_HOST_PLATFORM = host;

  const fpResult = await computeFingerprint(worktree);
  const sessDir = sessionDir(fpResult.fingerprint, sessionId);
  mkdirSync(sessDir, { recursive: true });

  return {
    rootDir,
    worktree,
    configDir,
    sessionId,
    sessDir,
    toolContext: {
      sessionID: sessionId,
      messageID: randomUUID(),
      agent: 'test',
      directory: worktree,
      worktree,
      abort: new AbortController().signal,
      metadata: () => {},
    },
  };
}

async function injectAssurance(
  sessDir: string,
  state: SessionState,
  obligationType: 'plan' | 'architecture',
  host: HostId,
  obligationId: string,
  invocationId: string,
): Promise<SessionState> {
  const isOpenCode = host === 'opencode';
  const assurance = appendReviewObligation(state.reviewAssurance, null);
  const obligation: ReviewObligation = {
    ...createReviewObligation({ obligationType, iteration: 0, planVersion: 1, now: NOW() }),
    obligationId,
  };
  let bound = appendReviewObligation(assurance, obligation);
  const findings = strictFindings(obligationId);
  const fh = hashFindings(findings);
  const invocation = buildHostInvocation(host, obligation, fh, invocationId);
  bound = {
    obligations: bound.obligations.map((o) =>
      o.obligationId === obligationId
        ? {
            ...o,
            status: 'fulfilled' as const,
            fulfilledAt: NOW(),
            pluginHandshakeAt: isOpenCode ? NOW() : null,
          }
        : o,
    ),
    invocations: bound.invocations,
  };
  bound = appendInvocationEvidence(bound, invocation);
  bound = consumeReviewObligation(bound, obligation, NOW(), invocationId);
  const augmented: SessionState = {
    ...state,
    reviewAssurance: bound,
    reviewDecision: {
      verdict: 'approve',
      rationale: 'E2E',
      decidedAt: NOW(),
      decidedBy: DECIDED_BY,
    },
  };
  await writeStateWithArtifacts(sessDir, augmented);
  return augmented;
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('FlowGuard tool-level E2E contract', () => {
  for (const host of ALL_HOSTS) {
    describe(`${host} (${computeHostEnforcementStyle(host)})`, () => {
      let session: E2ESession;
      let prevConfigDir: string | undefined;
      let prevRequire: string | undefined;

      beforeEach(() => {
        prevConfigDir = process.env.OPENCODE_CONFIG_DIR;
        prevRequire = process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR;
      });
      afterEach(() => {
        process.env.OPENCODE_CONFIG_DIR = prevConfigDir;
        process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR = prevRequire;
        if (session) rmSync(session.rootDir, { recursive: true, force: true });
      });

      // ── Architecture flow ─────────────────────────────────────

      it('architecture flow: ADR submission, evidence injection, review verdict approved', async () => {
        session = await bootstrapE2ESession(host, 'arch');
        await writeStateWithArtifacts(session.sessDir, makeState('READY'));

        const adrText =
          '## Context\nTest ADR.\n\n## Decision\nUse PostgreSQL.\n\n## Consequences\nMigration needed.\n';
        const archResultA = await architecture.execute(
          { title: 'E2E ADR', adrText },
          session.toolContext,
        );
        expect(typeof archResultA).toBe('string');
        expect(archResultA).not.toContain('INTERNAL_ERROR');

        let state = await readState(session.sessDir);
        expect(state!.architecture).toBeTruthy();
        expect(
          state!.reviewAssurance?.obligations.some((o) => o.obligationType === 'architecture'),
        ).toBe(true);

        const invId = randomUUID();
        const oblId = randomUUID();
        state = await injectAssurance(session.sessDir, state!, 'architecture', host, oblId, invId);

        const archResultB = await architecture.execute(
          { reviewVerdict: 'approve', reviewFindings: strictFindings(oblId) },
          session.toolContext,
        );
        expect(typeof archResultB).toBe('string');
        expect(archResultB).not.toContain('INTERNAL_ERROR');

        state = await readState(session.sessDir);
        expect(state!.architecture).toBeTruthy();
        expect(
          state!.reviewAssurance?.obligations.some(
            (o) => o.obligationType === 'architecture' && o.status === 'consumed',
          ),
        ).toBe(true);
      });

      // ── Main flow ─────────────────────────────────────────────

      it('main flow: plan submission, evidence binding, review verdict approved', async () => {
        session = await bootstrapE2ESession(host, 'main');
        await writeStateWithArtifacts(session.sessDir, makeState('TICKET', { ticket: TICKET }));

        const planResultA = await plan.execute(
          { planText: '## Plan\n1. Fix auth' },
          session.toolContext,
        );
        expect(typeof planResultA).toBe('string');
        expect(planResultA).not.toContain('INTERNAL_ERROR');

        let state = await readState(session.sessDir);
        expect(state!.plan).toBeTruthy();
        expect(state!.ticket).toBeTruthy();
        expect(state!.reviewAssurance?.obligations.some((o) => o.obligationType === 'plan')).toBe(
          true,
        );

        const invId = randomUUID();
        const oblId = randomUUID();
        state = await injectAssurance(session.sessDir, state!, 'plan', host, oblId, invId);

        const planResultB = await plan.execute(
          { reviewVerdict: 'approve', reviewFindings: strictFindings(oblId) },
          session.toolContext,
        );
        expect(typeof planResultB).toBe('string');
        expect(planResultB).not.toContain('INTERNAL_ERROR');

        state = await readState(session.sessDir);
        expect(state!.plan).toBeTruthy();
        expect(state!.ticket).toBeTruthy();
        expect(
          state!.reviewAssurance?.obligations.some(
            (o) => o.obligationType === 'plan' && o.status === 'consumed',
          ),
        ).toBe(true);
      });
    });
  }
});

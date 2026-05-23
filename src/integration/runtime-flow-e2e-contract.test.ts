/**
 * @module integration/runtime-flow-e2e-contract.test
 * @description FlowGuard tool-level E2E contract smoke.
 *
 * Calls actual plan.execute() and architecture.execute() in review-verdict
 * mode (Mode B) with real git worktrees and persistence. Bootstraps state
 * at the correct phase with pre-built evidence and host-specific synthetic
 * review assurance, then invokes the tool to validate and consume.
 *
 * Host profiles: opencode (plugin_handshake), claude-code and codex (manual_attested).
 * No LLM inference, no network, no secrets.
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
import type { ReviewFindings, ReviewObligation } from '../state/evidence.js';
import {
  createReviewObligation,
  appendReviewObligation,
  appendInvocationEvidence,
  hashFindings,
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
} from './review/assurance.js';
import {
  makeState,
  TICKET,
  PLAN_RECORD,
  ARCHITECTURE_DECISION,
  SELF_REVIEW_CONVERGED,
} from '../__fixtures__.js';
import type { SessionState } from '../state/schema.js';

const ALL_HOSTS = ['opencode', 'claude-code', 'codex'] as const satisfies readonly HostId[];
const NOW = () => new Date().toISOString();
const DECIDED_BY = 'reviewer-1';

function style(host: HostId) {
  return host === 'opencode' ? ('plugin_handshake' as const) : ('manual_attested' as const);
}

function findings(oblId: string, iteration = 0, planVersion = 1): ReviewFindings {
  return {
    iteration,
    planVersion,
    reviewMode: 'subagent' as const,
    overallVerdict: 'approve' as const,
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
      toolObligationId: oblId,
      iteration,
      planVersion,
      reviewedBy: 'flowguard-reviewer',
    },
  };
}

function buildAssuranceForObligation(
  host: HostId,
  obligation: ReviewObligation,
  findingsHash: string,
  parentSessionId: string,
  invocationId: string,
) {
  const s = style(host);
  const invocation = {
    invocationId,
    obligationId: obligation.obligationId,
    obligationType: obligation.obligationType,
    parentSessionId,
    childSessionId: 'ses_reviewer',
    agentType: 'flowguard-reviewer' as const,
    invocationMode:
      s === 'plugin_handshake' ? ('host_subagent_task' as const) : ('manual_attested' as const),
    hostVisible: s === 'plugin_handshake',
    source:
      s === 'plugin_handshake'
        ? ('host-orchestrated' as const)
        : ('agent-submitted-attested' as const),
    promptHash: 'abc',
    mandateDigest: REVIEW_MANDATE_DIGEST,
    criteriaVersion: REVIEW_CRITERIA_VERSION,
    findingsHash,
    invokedAt: NOW(),
    fulfilledAt: NOW(),
    consumedByObligationId: null,
    capturedVerdict: s === 'plugin_handshake' ? 'approve' : undefined,
  };
  const fulfilled = {
    ...obligation,
    status: 'fulfilled' as const,
    fulfilledAt: NOW(),
    pluginHandshakeAt: s === 'plugin_handshake' ? NOW() : null,
  };
  const assured = appendInvocationEvidence(
    { obligations: [fulfilled], invocations: [] },
    invocation,
  );
  return { ...assured };
}

interface E2ESession {
  rootDir: string;
  worktree: string;
  configDir: string;
  sessionId: string;
  sessDir: string;
  toolContext: ToolContext;
}

async function bootstrap(host: HostId, label: string): Promise<E2ESession> {
  const rootDir = mkdtempSync(path.join(tmpdir(), `fg-e2e-${host}-${label}-`));
  const worktree = path.join(rootDir, 'worktree'),
    configDir = path.join(rootDir, 'config'),
    sessionId = randomUUID();
  mkdirSync(worktree, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  execSync('git init && git config user.email t@t && git config user.name T', {
    cwd: worktree,
    stdio: 'pipe',
  });
  writeFileSync(path.join(worktree, 'README.md'), '# E2E');
  execSync(
    'git add README.md && git commit -m init && git remote add origin https://github.com/fg/e2e.git',
    { cwd: worktree, stdio: 'pipe' },
  );
  process.env.OPENCODE_CONFIG_DIR = configDir;
  process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR = '1';
  process.env.FLOWGUARD_HOST_PLATFORM = host;
  const fp = await computeFingerprint(worktree),
    sessDir = sessionDir(fp.fingerprint, sessionId);
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

describe('FlowGuard tool-level E2E contract', () => {
  for (const host of ALL_HOSTS) {
    describe(`${host} (${style(host)})`, () => {
      let session: E2ESession;
      let prevCfg: string | undefined, prevReq: string | undefined, prevPlat: string | undefined;

      beforeEach(() => {
        prevCfg = process.env.OPENCODE_CONFIG_DIR;
        prevReq = process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR;
        prevPlat = process.env.FLOWGUARD_HOST_PLATFORM;
      });
      afterEach(() => {
        process.env.OPENCODE_CONFIG_DIR = prevCfg;
        process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR = prevReq;
        process.env.FLOWGUARD_HOST_PLATFORM = prevPlat;
        if (session) rmSync(session.rootDir, { recursive: true, force: true });
      });

      it('plan Mode B: validates evidence and consumes obligation', async () => {
        session = await bootstrap(host, 'plan');

        const obl = createReviewObligation({
          obligationType: 'plan',
          iteration: 0,
          planVersion: 1,
          now: NOW(),
        });
        const f = findings(obl.obligationId);
        const fh = hashFindings(f);
        const assurance = buildAssuranceForObligation(
          host,
          obl,
          fh,
          session.toolContext.sessionID,
          randomUUID(),
        );

        const state: SessionState = {
          ...makeState('PLAN', { ticket: TICKET, plan: PLAN_RECORD }),
          selfReview: SELF_REVIEW_CONVERGED,
          reviewAssurance: assurance,
        };
        await writeStateWithArtifacts(session.sessDir, state);

        const result = await plan.execute(
          { reviewVerdict: 'approve', reviewFindings: f },
          session.toolContext,
        );
        expect(typeof result).toBe('string');

        const after = await readState(session.sessDir);
        const consumed = after!.reviewAssurance!.obligations.find(
          (o) => o.obligationId === obl.obligationId,
        );
        expect(consumed!.status).toBe('consumed');
      });

      it('architecture Mode B: validates evidence and consumes obligation', async () => {
        session = await bootstrap(host, 'arch');

        const obl = createReviewObligation({
          obligationType: 'architecture',
          iteration: 0,
          planVersion: 1,
          now: NOW(),
        });
        const f = findings(obl.obligationId);
        const fh = hashFindings(f);
        const assurance = buildAssuranceForObligation(
          host,
          obl,
          fh,
          session.toolContext.sessionID,
          randomUUID(),
        );

        const state: SessionState = {
          ...makeState('ARCHITECTURE', {
            architecture: { ...ARCHITECTURE_DECISION, status: 'proposed' },
          }),
          selfReview: SELF_REVIEW_CONVERGED,
          reviewAssurance: assurance,
        };
        await writeStateWithArtifacts(session.sessDir, state);

        const result = await architecture.execute(
          { reviewVerdict: 'approve', reviewFindings: f },
          session.toolContext,
        );
        expect(typeof result).toBe('string');

        const after = await readState(session.sessDir);
        const consumed = after!.reviewAssurance!.obligations.find(
          (o) => o.obligationId === obl.obligationId,
        );
        expect(consumed!.status).toBe('consumed');
      });
    });
  }
});

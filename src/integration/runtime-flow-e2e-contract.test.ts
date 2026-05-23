/**
 * @module integration/runtime-flow-e2e-contract.test
 * @description FlowGuard tool-level E2E contract smoke.
 *
 * Calls actual tool.execute() methods in-process with real git worktrees
 * and persistence. Each flow runs Mode A (evidence creation + obligation),
 * then host-specific synthetic evidence is injected into the tool-created
 * obligation, then Mode B (review verdict) validates and consumes it.
 *
 * Flows: architecture (full), plan (Mode A → evidence → Mode B).
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
import type { ReviewFindings } from '../state/evidence.js';
import {
  hashFindings,
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
} from './review/assurance.js';
import { makeState, TICKET } from '../__fixtures__.js';
import type { SessionState } from '../state/schema.js';

const ALL_HOSTS = ['opencode', 'claude-code', 'codex'] as const satisfies readonly HostId[];
const FIXED_TIME = '2026-01-01T00:00:00.000Z';

function isOpen(host: HostId) {
  return host === 'opencode';
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
    reviewedAt: FIXED_TIME,
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

/**
 * Injects host-specific evidence into the tool-created pending obligation
 * and persists via writeStateWithArtifacts.
 */
async function injectIntoObligation(
  sessDir: string,
  state: SessionState,
  host: HostId,
  oblType: string,
  sessionId: string,
): Promise<SessionState> {
  const obl = state.reviewAssurance!.obligations.find(
    (o) => o.obligationType === oblType && o.status === 'pending',
  );
  if (!obl) throw new Error(`No pending ${oblType} obligation in state`);
  const f = findings(obl.obligationId, obl.iteration, obl.planVersion);
  const fh = hashFindings(f);
  const invId = randomUUID();

  const newObl = {
    ...obl,
    status: 'fulfilled' as const,
    fulfilledAt: FIXED_TIME,
    pluginHandshakeAt: isOpen(host) ? FIXED_TIME : null,
  };
  const newInv = {
    invocationId: invId,
    obligationId: obl.obligationId,
    obligationType: obl.obligationType,
    parentSessionId: sessionId,
    childSessionId: 'ses_reviewer',
    agentType: 'flowguard-reviewer' as const,
    invocationMode: isOpen(host) ? ('host_subagent_task' as const) : ('manual_attested' as const),
    hostVisible: isOpen(host),
    source: isOpen(host) ? ('host-orchestrated' as const) : ('agent-submitted-attested' as const),
    promptHash: 'abc',
    mandateDigest: REVIEW_MANDATE_DIGEST,
    criteriaVersion: REVIEW_CRITERIA_VERSION,
    findingsHash: fh,
    invokedAt: FIXED_TIME,
    fulfilledAt: FIXED_TIME,
    consumedByObligationId: null,
    capturedVerdict: isOpen(host) ? 'approve' : undefined,
  };

  const augmented: SessionState = {
    ...state,
    reviewAssurance: {
      obligations: state.reviewAssurance!.obligations.map((o) =>
        o.obligationId === obl.obligationId ? newObl : o,
      ),
      invocations: [...state.reviewAssurance!.invocations, newInv],
    },
    reviewDecision: {
      verdict: 'approve',
      rationale: 'E2E',
      decidedAt: FIXED_TIME,
      decidedBy: 'reviewer-1',
    },
  };
  await writeStateWithArtifacts(sessDir, augmented);
  return augmented;
}

describe('FlowGuard tool-level E2E contract', () => {
  for (const host of ALL_HOSTS) {
    describe(`${host} (${isOpen(host) ? 'plugin_handshake' : 'manual_attested'})`, () => {
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

      // ── Architecture flow (Mode A → evidence → Mode B) ────────

      it('architecture flow: Mode A creates ADR + obligation, evidence bound, Mode B consumes', async () => {
        session = await bootstrap(host, 'arch');
        await writeStateWithArtifacts(session.sessDir, makeState('READY'));

        // Mode A
        const adrText =
          '## Context\nTest ADR.\n\n## Decision\nUse PostgreSQL.\n\n## Consequences\nMigration needed.\n';
        const rA = await architecture.execute({ title: 'E2E ADR', adrText }, session.toolContext);
        expect(typeof rA).toBe('string');
        expect(rA).not.toContain('INTERNAL_ERROR');

        let s = await readState(session.sessDir);
        expect(s!.architecture).toBeTruthy();
        const preCount = s!.reviewAssurance!.obligations.filter(
          (o) => o.obligationType === 'architecture',
        ).length;
        expect(preCount).toBe(1);

        // Inject evidence into tool-created obligation
        s = await injectIntoObligation(
          session.sessDir,
          s!,
          host,
          'architecture',
          session.toolContext.sessionID,
        );

        // Mode B
        const obl = s!.reviewAssurance!.obligations.find(
          (o) => o.obligationType === 'architecture',
        )!;
        const f = findings(obl.obligationId, obl.iteration, obl.planVersion);
        const rB = await architecture.execute(
          { reviewVerdict: 'approve', reviewFindings: f },
          session.toolContext,
        );
        expect(typeof rB).toBe('string');
        expect(rB).not.toContain('INTERNAL_ERROR');

        s = await readState(session.sessDir);
        const consumed = s!.reviewAssurance!.obligations.find(
          (o) => o.obligationId === obl.obligationId,
        );
        expect(consumed!.status).toBe('consumed');
      });

      // ── Plan flow (Mode A → evidence → Mode B) ────────────────

      it('plan flow: Mode A creates plan + obligation, evidence bound, Mode B consumes', async () => {
        session = await bootstrap(host, 'plan');
        await writeStateWithArtifacts(session.sessDir, makeState('TICKET', { ticket: TICKET }));

        // Mode A
        const rA = await plan.execute({ planText: '## Plan\n1. Fix auth' }, session.toolContext);
        expect(typeof rA).toBe('string');
        expect(rA).not.toContain('INTERNAL_ERROR');

        let s = await readState(session.sessDir);
        expect(s!.plan).toBeTruthy();
        expect(s!.ticket).toBeTruthy();
        expect(s!.reviewAssurance!.obligations.some((o) => o.obligationType === 'plan')).toBe(true);

        // Inject evidence into tool-created obligation
        s = await injectIntoObligation(
          session.sessDir,
          s!,
          host,
          'plan',
          session.toolContext.sessionID,
        );

        // Mode B
        const obl = s!.reviewAssurance!.obligations.find((o) => o.obligationType === 'plan')!;
        const f = findings(obl.obligationId, obl.iteration, obl.planVersion);
        const rB = await plan.execute(
          { reviewVerdict: 'approve', reviewFindings: f },
          session.toolContext,
        );
        expect(typeof rB).toBe('string');
        expect(rB).not.toContain('INTERNAL_ERROR');

        s = await readState(session.sessDir);
        const consumed = s!.reviewAssurance!.obligations.find(
          (o) => o.obligationId === obl.obligationId,
        );
        expect(consumed!.status).toBe('consumed');
      });
    });
  }
});

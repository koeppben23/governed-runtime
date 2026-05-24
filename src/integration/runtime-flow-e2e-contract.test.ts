/**
 * @module integration/runtime-flow-e2e-contract.test
 * @description FlowGuard tool-level contract coverage for review-gated
 * flow segments.
 *
 * Calls actual tool.execute() in-process with real git worktrees and persistence.
 * Each test: Mode A (evidence + obligation creation) → inject host-specific
 * synthetic evidence into tool-created obligation → Mode B (review verdict
 * validates and consumes). The main chain test links plan and implement
 * segments. The standalone review flow completes via content + findings.
 *
 * Host profiles: opencode (plugin_handshake), claude-code and codex (manual_attested).
 * Does NOT test /check, /validate, /export, /review-decision as standalone tools.
 * (validate and archive are tested within the plan-to-implement segment.)
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
import { implement } from './tools/implement.js';
import { architecture } from './tools/architecture.js';
import { review } from './tools/review-tool/index.js';
import { validate } from './tools/validate-tool.js';
import { archive } from './tools/archive-tool.js';
import type { ToolContext } from './tools/helpers.js';
import type { ReviewFindings } from '../state/evidence.js';
import {
  hashFindings,
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
} from './review/assurance.js';
import { makeState, TICKET } from '../__fixtures__.js';
import type { SessionState } from '../state/schema.js';

const HOSTS = ['opencode', 'claude-code', 'codex'] as const satisfies readonly HostId[];
const FIXED_TIME = '2026-01-01T00:00:00.000Z';

function isOpen(host: HostId) {
  return host === 'opencode';
}

function f(oblId: string, iter = 0, pv = 1): ReviewFindings {
  return {
    iteration: iter,
    planVersion: pv,
    reviewMode: 'subagent' as const,
    overallVerdict: 'approve' as const,
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId: 'ses_r' },
    reviewedAt: FIXED_TIME,
    attestation: {
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      toolObligationId: oblId,
      iteration: iter,
      planVersion: pv,
      reviewedBy: 'flowguard-reviewer',
    },
  };
}

interface SE {
  rootDir: string;
  worktree: string;
  configDir: string;
  sId: string;
  sDir: string;
  tc: ToolContext;
}

async function boot(host: HostId, label: string): Promise<SE> {
  const r = mkdtempSync(path.join(tmpdir(), `fg-e2e-${host}-${label}-`));
  const w = path.join(r, 'worktree'),
    c = path.join(r, 'config'),
    id = randomUUID();
  mkdirSync(w, { recursive: true });
  mkdirSync(c, { recursive: true });
  execSync('git init && git config user.email t@t && git config user.name T', {
    cwd: w,
    stdio: 'pipe',
  });
  writeFileSync(path.join(w, 'README.md'), '# E2E');
  execSync(
    'git add README.md && git commit -m init && git remote add origin https://github.com/fg/e2e.git',
    { cwd: w, stdio: 'pipe' },
  );
  process.env.OPENCODE_CONFIG_DIR = c;
  process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR = '1';
  process.env.FLOWGUARD_HOST_PLATFORM = host;
  const fp = await computeFingerprint(w),
    sd = sessionDir(fp.fingerprint, id);
  mkdirSync(sd, { recursive: true });
  return {
    rootDir: r,
    worktree: w,
    configDir: c,
    sId: id,
    sDir: sd,
    tc: {
      sessionID: id,
      messageID: randomUUID(),
      agent: 'test',
      directory: w,
      worktree: w,
      abort: new AbortController().signal,
      metadata: () => {},
    },
  };
}

async function inject(
  sDir: string,
  state: SessionState,
  host: HostId,
  oblType: string,
  sessionId: string,
): Promise<{ state: SessionState; oblId: string }> {
  const obl = state.reviewAssurance!.obligations.find(
    (o) => o.obligationType === oblType && o.status === 'pending',
  );
  if (!obl) throw new Error(`No pending ${oblType} obligation`);
  const ff = f(obl.obligationId, obl.iteration, obl.planVersion);
  const fh = hashFindings(ff);
  const newObl = {
    ...obl,
    status: 'fulfilled' as const,
    fulfilledAt: FIXED_TIME,
    pluginHandshakeAt: isOpen(host) ? FIXED_TIME : null,
  };
  const inv = {
    invocationId: randomUUID(),
    obligationId: obl.obligationId,
    obligationType: obl.obligationType,
    parentSessionId: sessionId,
    childSessionId: 'ses_r',
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
  const aug: SessionState = {
    ...state,
    reviewAssurance: {
      obligations: state.reviewAssurance!.obligations.map((o) =>
        o.obligationId === obl.obligationId ? newObl : o,
      ),
      invocations: [...state.reviewAssurance!.invocations, inv],
    },
    reviewDecision: {
      verdict: 'approve',
      rationale: 'E2E',
      decidedAt: FIXED_TIME,
      decidedBy: 'reviewer-1',
    },
  };
  await writeStateWithArtifacts(sDir, aug);
  return { state: aug, oblId: obl.obligationId };
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('FlowGuard tool-level E2E', () => {
  for (const host of HOSTS) {
    describe(`${host} (${isOpen(host) ? 'plugin_handshake' : 'manual_attested'})`, () => {
      let s: SE | undefined;
      let pc: string | undefined, pr: string | undefined, pp: string | undefined;
      beforeEach(() => {
        pc = process.env.OPENCODE_CONFIG_DIR;
        pr = process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR;
        pp = process.env.FLOWGUARD_HOST_PLATFORM;
      });
      afterEach(() => {
        restoreEnv('OPENCODE_CONFIG_DIR', pc);
        restoreEnv('FLOWGUARD_REQUIRE_TEST_CONFIG_DIR', pr);
        restoreEnv('FLOWGUARD_HOST_PLATFORM', pp);
        if (s) {
          rmSync(s.rootDir, { recursive: true, force: true });
          s = undefined;
        }
      });

      it('architecture: Mode A → evidence → Mode B', async () => {
        s = await boot(host, 'arch');
        await writeStateWithArtifacts(s.sDir, makeState('READY'));
        const a = await architecture.execute(
          {
            title: 'E2E ADR',
            adrText: '## Context\nTest.\n\n## Decision\nUse X.\n\n## Consequences\nY.\n',
          },
          s.tc,
        );
        expect(typeof a).toBe('string');
        expect(a).not.toContain('INTERNAL_ERROR');
        let st = await readState(s.sDir);
        expect(st!.architecture).toBeTruthy();
        const { oblId } = await inject(s.sDir, st!, host, 'architecture', s.tc.sessionID);
        st = await readState(s.sDir);
        const o1 = st!.reviewAssurance!.obligations.find((o) => o.obligationId === oblId)!;
        const b = await architecture.execute(
          {
            reviewVerdict: 'approve',
            reviewFindings: f(o1.obligationId, o1.iteration, o1.planVersion),
          },
          s.tc,
        );
        expect(typeof b).toBe('string');
        expect(b).not.toContain('INTERNAL_ERROR');
        st = await readState(s.sDir);
        expect(st!.reviewAssurance!.obligations.find((o) => o.obligationId === oblId)!.status).toBe(
          'consumed',
        );
      });

      it('plan: Mode A → evidence → Mode B', async () => {
        s = await boot(host, 'plan');
        await writeStateWithArtifacts(s.sDir, makeState('TICKET', { ticket: TICKET }));
        const a = await plan.execute({ planText: '## Plan\n1. Fix auth' }, s.tc);
        expect(typeof a).toBe('string');
        expect(a).not.toContain('INTERNAL_ERROR');
        let st = await readState(s.sDir);
        expect(st!.plan).toBeTruthy();
        expect(st!.ticket).toBeTruthy();
        const { oblId } = await inject(s.sDir, st!, host, 'plan', s.tc.sessionID);
        st = await readState(s.sDir);
        const o1 = st!.reviewAssurance!.obligations.find((o) => o.obligationId === oblId)!;
        const b = await plan.execute(
          {
            reviewVerdict: 'approve',
            reviewFindings: f(o1.obligationId, o1.iteration, o1.planVersion),
          },
          s.tc,
        );
        expect(typeof b).toBe('string');
        expect(b).not.toContain('INTERNAL_ERROR');
        st = await readState(s.sDir);
        expect(st!.reviewAssurance!.obligations.find((o) => o.obligationId === oblId)!.status).toBe(
          'consumed',
        );
      });

      it('implement: Mode A → evidence → Mode B', async () => {
        s = await boot(host, 'impl');
        await writeStateWithArtifacts(
          s.sDir,
          makeState('IMPLEMENTATION', {
            ticket: TICKET,
            plan: {
              current: { body: '# Plan', digest: 'abc', sections: [], createdAt: FIXED_TIME },
              history: [],
              reviewFindings: undefined,
            },
          }),
        );
        mkdirSync(path.join(s.worktree, 'src'), { recursive: true });
        writeFileSync(path.join(s.worktree, 'src', 'auth.ts'), 'export const auth = () => true;');
        execSync('git add src', { cwd: s.worktree, stdio: 'pipe' });
        const a = await implement.execute({}, s.tc);
        expect(typeof a).toBe('string');
        expect(a).not.toContain('INTERNAL_ERROR');
        let st = await readState(s.sDir);
        expect(st!.implementation).toBeTruthy();
        const { oblId } = await inject(s.sDir, st!, host, 'implement', s.tc.sessionID);
        st = await readState(s.sDir);
        const o1 = st!.reviewAssurance!.obligations.find((o) => o.obligationId === oblId)!;
        const b = await implement.execute(
          {
            reviewVerdict: 'approve',
            reviewFindings: f(o1.obligationId, o1.iteration, o1.planVersion),
          },
          s.tc,
        );
        expect(typeof b).toBe('string');
        expect(b).not.toContain('INTERNAL_ERROR');
        st = await readState(s.sDir);
        expect(st!.reviewAssurance!.obligations.find((o) => o.obligationId === oblId)!.status).toBe(
          'consumed',
        );
      });

      it('plan-to-implement segment: plan → validate → implement → archive', async () => {
        s = await boot(host, 'main');

        // Step 1: plan Mode A
        await writeStateWithArtifacts(s.sDir, makeState('TICKET', { ticket: TICKET }));
        const r1 = await plan.execute({ planText: '## Plan\n1. Fix auth' }, s.tc);
        expect(typeof r1).toBe('string');
        expect(r1).not.toContain('INTERNAL_ERROR');
        let st = await readState(s.sDir);
        expect(st!.plan).toBeTruthy();

        // Step 2: inject evidence + approve plan
        const { oblId: pid } = await inject(s.sDir, st!, host, 'plan', s.tc.sessionID);
        st = await readState(s.sDir);
        const po = st!.reviewAssurance!.obligations.find((o) => o.obligationId === pid)!;
        const r2 = await plan.execute(
          {
            reviewVerdict: 'approve',
            reviewFindings: f(po.obligationId, po.iteration, po.planVersion),
          },
          s.tc,
        );
        expect(typeof r2).toBe('string');
        expect(r2).not.toContain('INTERNAL_ERROR');

        // Step 3: validate — bootstrap at VALIDATION
        st = await readState(s.sDir);
        const currentPlan = st!.plan!;
        await writeStateWithArtifacts(
          s.sDir,
          makeState('VALIDATION', {
            ticket: TICKET,
            plan: currentPlan,
            reviewDecision: st!.reviewDecision,
            activeChecks: ['test_quality', 'rollback_safety'],
          }),
        );
        const rV = await validate.execute(
          {
            results: [
              { checkId: 'test_quality', passed: true, detail: 'All tests pass' },
              { checkId: 'rollback_safety', passed: true, detail: 'Safe to rollback' },
            ],
          },
          s.tc,
        );
        expect(typeof rV).toBe('string');
        expect(rV).not.toContain('INTERNAL_ERROR');

        // Step 4: implement Mode A
        st = await readState(s.sDir);
        // Bootstrap IMPLEMENTATION with evidence from validate
        await writeStateWithArtifacts(
          s.sDir,
          makeState('IMPLEMENTATION', {
            ticket: TICKET,
            plan: currentPlan,
            reviewDecision: st!.reviewDecision,
            validation: st!.validation,
            activeChecks: ['test_quality', 'rollback_safety'],
          }),
        );
        mkdirSync(path.join(s.worktree, 'src'), { recursive: true });
        writeFileSync(path.join(s.worktree, 'src', 'auth.ts'), 'export const auth = () => true;');
        execSync('git add src', { cwd: s.worktree, stdio: 'pipe' });
        const r3 = await implement.execute({}, s.tc);
        expect(typeof r3).toBe('string');
        expect(r3).not.toContain('INTERNAL_ERROR');
        st = await readState(s.sDir);
        expect(st!.implementation).toBeTruthy();

        // Step 5: inject impl evidence + approve
        const { oblId: iid } = await inject(s.sDir, st!, host, 'implement', s.tc.sessionID);
        st = await readState(s.sDir);
        const io = st!.reviewAssurance!.obligations.find((o) => o.obligationId === iid)!;
        const r4 = await implement.execute(
          {
            reviewVerdict: 'approve',
            reviewFindings: f(io.obligationId, io.iteration, io.planVersion),
          },
          s.tc,
        );
        expect(typeof r4).toBe('string');
        expect(r4).not.toContain('INTERNAL_ERROR');

        // Step 6: archive at terminal phase
        st = await readState(s.sDir);
        await writeStateWithArtifacts(
          s.sDir,
          makeState('COMPLETE', {
            ticket: TICKET,
            plan: currentPlan,
            implementation: st!.implementation,
            reviewAssurance: st!.reviewAssurance,
            reviewDecision: st!.reviewDecision,
            validation: st!.validation,
            activeChecks: ['test_quality', 'rollback_safety'],
          }),
        );
        const rA = await archive.execute({}, s.tc);
        expect(typeof rA).toBe('string');
        expect(rA).not.toContain('INTERNAL_ERROR');
        st = await readState(s.sDir);
        expect(st!.archiveStatus).toBeTruthy();
      });

      it('review: content → obligation → evidence → complete', async () => {
        s = await boot(host, 'review');
        await writeStateWithArtifacts(s.sDir, makeState('READY'));

        // Step 1: content-aware call creates review obligation
        const r1 = await review.execute(
          { inputOrigin: 'manual_text', text: 'E2E review content' },
          s.tc,
        );
        expect(typeof r1).toBe('string');
        expect(r1).toContain('CONTENT_ANALYSIS_REQUIRED');

        // Extract the obligation ID from the response
        const p1 = JSON.parse(r1 as string);
        const oblId = p1.requiredReviewAttestation?.toolObligationId as string;
        expect(oblId).toBeTruthy();

        // Step 2: complete with findings — review tool records its own evidence
        let st = await readState(s.sDir);
        const obl = st!.reviewAssurance!.obligations.find((o) => o.obligationId === oblId)!;
        const r2 = await review.execute(
          {
            inputOrigin: 'manual_text',
            text: 'E2E review content',
            reviewFindings: f(oblId, obl.iteration, obl.planVersion),
          },
          s.tc,
        );
        expect(typeof r2).toBe('string');
        expect(r2).not.toContain('INTERNAL_ERROR');
        st = await readState(s.sDir);
        expect(st!.phase).toBe('REVIEW_COMPLETE');
      });
    });
  }
});

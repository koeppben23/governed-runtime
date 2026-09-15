/**
 * @module integration/review-modeb-contract.test
 * @description Plan and architecture Mode-B review validation contract.
 *
 * Calls actual plan.execute() and architecture.execute() in review-verdict
 * mode (Mode B) with real git worktrees and persistence. Bootstraps state
 * at the correct phase with pre-built evidence and host-specific synthetic
 * review assurance, then invokes the tool to validate and consume.
 *
 * Host profiles: the single host-observed structured child-session evidence path
 * (sdk_session_prompt invocation with captured structured findings).
 * Does NOT test full E2E flows — only the review-verdict gate for plan and architecture.
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

import { plan } from './tools/plan.js';
import { architecture } from './tools/architecture.js';
import type { ToolContext } from './tools/helpers.js';
import type { ReviewFindings, ReviewObligation } from '../state/evidence.js';
import {
  artifactReviewSubjectScope,
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
} from '../fixtures.js';
import type { SessionState } from '../state/schema.js';
import { completedDispatchForInvocation } from '../state/evidence-test-constants.js';
import { hashCanonicalReviewContent } from '../shared/review-subject.js';

const NOW = () => new Date().toISOString();
const DECIDED_BY = 'reviewer-1';
const REVIEW_MATERIAL_CONTENT = '## Frozen Test Review Material\n\nMode B fixture.\n';
const REVIEW_MATERIAL_DIGEST = hashCanonicalReviewContent(REVIEW_MATERIAL_CONTENT);

function findings(oblId: string, iteration = 0, planVersion = 1): ReviewFindings {
  return {
    iteration,
    planVersion,
    reviewMode: 'subagent' as const,
    overallVerdict: 'accept' as const,
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    challenges: [],
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
  obligation: ReviewObligation,
  rawFindings: ReviewFindings,
  parentSessionId: string,
  invocationId: string,
) {
  const attemptId = randomUUID();
  const now = NOW();
  const invocation = {
    invocationId,
    obligationId: obligation.obligationId,
    obligationType: obligation.obligationType,
    parentSessionId,
    childSessionId: 'ses_reviewer',
    agentType: 'flowguard-reviewer' as const,
    invocationMode: 'sdk_session_prompt' as const,
    hostVisible: false,
    source: 'host-orchestrated' as const,
    promptHash: 'a'.repeat(64),
    mandateDigest: REVIEW_MANDATE_DIGEST,
    criteriaVersion: REVIEW_CRITERIA_VERSION,
    findingsHash: hashFindings(rawFindings),
    capturedRawFindings: rawFindings,
    invokedAt: now,
    fulfilledAt: now,
    consumedByObligationId: null,
    capturedVerdict: 'accept',
    reviewOutputMode: 'structured_output' as const,
    structuredOutputUsed: true as const,
    reviewAssuranceLevel: 'structured_high' as const,
    attemptId,
  };
  const fulfilled = {
    ...obligation,
    status: 'fulfilled' as const,
    invocationId,
    fulfilledAt: now,
    pluginHandshakeAt: now,
  };
  return appendInvocationEvidence(
    {
      assuranceSchemaVersion: 'review-assurance.v6' as const,
      obligations: [fulfilled],
      invocations: [],
      attempts: [
        {
          attemptId,
          obligationId: obligation.obligationId,
          obligationType: obligation.obligationType,
          subjectDigest: obligation.subjectDigest,
          ordinal: 1,
          childSessionId: 'ses_reviewer',
          status: 'bound' as const,
          origin: { kind: 'initial' as const },
          repositoryDiscovery: { kind: 'not_applicable' as const },
          observations: [],
          createdAt: NOW(),
          completedAt: NOW(),
        },
      ],
      dispatches: [completedDispatchForInvocation(invocation, { completedAt: now })],
    },
    invocation,
  );
}

interface E2ESession {
  rootDir: string;
  worktree: string;
  configDir: string;
  sessionId: string;
  sessDir: string;
  toolContext: ToolContext;
}

async function bootstrap(label: string): Promise<E2ESession> {
  const rootDir = mkdtempSync(path.join(tmpdir(), `fg-e2e-opencode-${label}-`));
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
  process.env.FLOWGUARD_HOST_PLATFORM = 'opencode';
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

describe('plan / architecture Mode-B review contract', () => {
  describe('opencode (structured host-observed evidence)', () => {
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
      session = await bootstrap('plan');

      const obl = {
        ...createReviewObligation({
          policySnapshot: {
            challengePolicy: {
              version: 'challenge-policy.v1',
              counts: { TRIVIAL: 0, STANDARD: 1, 'HIGH-RISK': 2 },
            },
            maxReviewerAttempts: 1,
          },
          obligationType: 'plan',
          repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
          iteration: 0,
          planVersion: 1,
          now: NOW(),
          subjectDigest: 'test',
          reviewMaterial: {
            content: REVIEW_MATERIAL_CONTENT,
            materialDigest: REVIEW_MATERIAL_DIGEST,
            subjectDigest: 'test',
          },
          reviewSubjectScope: artifactReviewSubjectScope('plan', '# Plan\nBody', 'test'),
          changedFiles: ['docs/test.md'],
        }),
        reviewMaterial: {
          content: REVIEW_MATERIAL_CONTENT,
          materialDigest: REVIEW_MATERIAL_DIGEST,
          subjectDigest: 'test',
        },
      };
      const f = findings(obl.obligationId);
      const assurance = buildAssuranceForObligation(
        obl,
        f,
        session.toolContext.sessionID,
        randomUUID(),
      );

      const state: SessionState = {
        ...makeState('PLAN', { ticket: TICKET, plan: PLAN_RECORD }),
        selfReview: SELF_REVIEW_CONVERGED,
        reviewAssurance: assurance,
      };
      await writeStateWithArtifacts(session.sessDir, state);

      const result = await plan.execute({ reviewVerdict: 'accept' }, session.toolContext);
      expect(typeof result).toBe('string');

      const after = await readState(session.sessDir);
      const consumed = after!.reviewAssurance!.obligations.find(
        (o) => o.obligationId === obl.obligationId,
      );
      expect(consumed!.status).toBe('consumed');
    });

    it('architecture Mode B: validates evidence and consumes obligation', async () => {
      session = await bootstrap('arch');

      const obl = {
        ...createReviewObligation({
          policySnapshot: {
            challengePolicy: {
              version: 'challenge-policy.v1',
              counts: { TRIVIAL: 0, STANDARD: 1, 'HIGH-RISK': 2 },
            },
            maxReviewerAttempts: 1,
          },
          obligationType: 'architecture',
          repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
          iteration: 0,
          planVersion: 1,
          now: NOW(),
          subjectDigest: 'test',
          reviewMaterial: {
            content: REVIEW_MATERIAL_CONTENT,
            materialDigest: REVIEW_MATERIAL_DIGEST,
            subjectDigest: 'test',
          },
          reviewSubjectScope: artifactReviewSubjectScope(
            'adr',
            '## Context\nC\n## Decision\nD',
            'test',
          ),
          changedFiles: ['docs/test.md'],
        }),
        reviewMaterial: {
          content: REVIEW_MATERIAL_CONTENT,
          materialDigest: REVIEW_MATERIAL_DIGEST,
          subjectDigest: 'test',
        },
      };
      const f = findings(obl.obligationId);
      const assurance = buildAssuranceForObligation(
        obl,
        f,
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

      const result = await architecture.execute({ reviewVerdict: 'accept' }, session.toolContext);
      expect(typeof result).toBe('string');

      const after = await readState(session.sessDir);
      const consumed = after!.reviewAssurance!.obligations.find(
        (o) => o.obligationId === obl.obligationId,
      );
      expect(consumed!.status).toBe('consumed');
    });
  });
});

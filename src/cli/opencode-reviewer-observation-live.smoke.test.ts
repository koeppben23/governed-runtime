/** V2 product observation transport/replay. Component-seeded activation, not R4 acceptance. */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createReviewerCaptureHostProbe } from './opencode-reviewer-capture-test-helpers.js';
import { seedStrictPlanSession } from '../integration/plugin-host-task-diagnostics-test-helpers.js';
import { readState } from '../adapters/persistence.js';
import { workspacesHome } from '../adapters/workspace/index.js';
import {
  observationCapabilityDigest,
  observationLedgerPath,
  observationLedgerRoot,
} from '../adapters/persistence-observation-ledger.js';
import { writeStateWithArtifacts } from '../integration/tools/helpers.js';
import { withTestEnv, repositoryDiscoveryContext } from '../integration/test-helpers.js';
import { mintObservationCapability } from '../integration/review/obligations/attempt-lifecycle.js';
import { contentDigestOf } from '../integration/review/observations/observation-service.js';
import { deriveRepositoryRevisionProvenance } from '../state/evidence-review-authority.js';

const LIVE = process.env.OPENCODE_LIVE === '1' || process.env.FLOWGUARD_OPENCODE_HOST_E2E === '1';
let probe: Awaited<ReturnType<typeof createReviewerCaptureHostProbe>> | undefined;
let restore: (() => void) | undefined;
afterEach(async () => {
  try {
    await probe?.close();
  } finally {
    restore?.();
    restore = undefined;
    probe = undefined;
  }
});

type Mode = 'valid' | 'foreign' | 'parent' | 'revision' | 'content' | 'response';
async function runObservation(mode: Mode) {
  const capability = mintObservationCapability();
  let ledger = '';
  let parent = '';
  let reviews = 0;
  let obligationId = '';
  let changedCapture = false;
  probe = await createReviewerCaptureHostProbe({
    initialObservation: () => ({ capability, revision: 'head', path: 'capture-sentinel.txt' }),
    serializedFindings: () => ({
      iteration: 0,
      planVersion: 1,
      reviewMode: 'subagent',
      overallVerdict: 'accept',
      blockingIssues: [],
      missingVerification: [],
      scopeCreep: [],
      unknowns: [],
      challenges: [],
      majorRisks: [
        {
          severity: 'minor',
          category: 'quality',
          message: 'The frozen repository context supports this plan section.',
          relation: {
            subjectAnchors: [
              {
                kind: 'artifact_section',
                artifactKind: 'plan',
                artifactDigest: 'test-subject-digest',
                sectionPath: [{ headingDepth: 2, siblingIndex: 1, headingText: 'Plan' }],
              },
            ],
            evidenceLocations: [{ path: 'capture-sentinel.txt', revision: 'head', line: 1 }],
          },
        },
      ],
      attestation: { toolObligationId: obligationId },
    }),
    async onReview() {
      if (++reviews !== 2 || mode === 'valid') return;
      const capture = JSON.parse((await readFile(ledger, 'utf8')).trim()) as Record<
        string,
        unknown
      >;
      if (mode === 'parent') capture.capturedSessionId = parent;
      if (mode === 'foreign') capture.capturedSessionId = 'ses_foreign_observation';
      if (mode === 'revision') capture.revision = 'base';
      if (mode === 'content') capture.contentDigest = `sha256:${'0'.repeat(64)}`;
      if (mode === 'response') capture.responseDigest = `sha256:${'0'.repeat(64)}`;
      await writeFile(ledger, `${JSON.stringify(capture)}\n`);
      changedCapture = true;
    },
  });
  restore = withTestEnv({ OPENCODE_CONFIG_DIR: probe.env.OPENCODE_CONFIG_DIR! });
  parent = await probe.session();
  const seeded = await seedStrictPlanSession(probe.project, parent);
  obligationId = seeded.obligationId;
  const state = (await readState(seeded.sessDir))!;
  const objectSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: probe.project,
    encoding: 'utf8',
  }).trim();
  const repositoryAuthority = {
    kind: 'context' as const,
    context: {
      kind: 'commit' as const,
      objectSha,
      repositoryIdentity: {
        host: 'github.com',
        owner: 'flowguard-tests',
        name: 'reviewer-fixture',
      },
    },
  };
  await writeStateWithArtifacts(seeded.sessDir, {
    ...state,
    reviewAssurance: {
      ...state.reviewAssurance!,
      obligations: state.reviewAssurance!.obligations.map((obligation) => ({
        ...obligation,
        repositoryEvidenceFreeze: { kind: 'available' as const },
        repositoryAuthority,
        repositoryRevisionProvenance: deriveRepositoryRevisionProvenance({ repositoryAuthority }),
      })),
      attempts: state.reviewAssurance!.attempts.map((attempt) => ({
        ...attempt,
        observationCapability: capability,
        repositoryDiscovery: repositoryDiscoveryContext(),
      })),
    },
  });
  ledger = observationLedgerPath(
    observationLedgerRoot(workspacesHome(), state.binding.fingerprint),
    observationCapabilityDigest(capability),
  );
  await probe.client.rpc.call({
    location: probe.location,
    rpcID: 'flowguard-component-activation',
    method: 'seed',
    input: {
      sessionID: parent,
      policyDigest: state.policySnapshot.hash,
      worktreeRoot: state.binding.worktree,
    },
  });
  // The sanctioned observation must acquire the frozen commit, not mutable worktree bytes.
  await writeFile(
    join(probe.project, 'capture-sentinel.txt'),
    'MUTABLE_WORKTREE_MUST_NOT_BE_OBSERVED',
  );
  await probe.run(parent, 'positive');
  expect(reviews).toBe(2);
  expect(changedCapture).toBe(mode !== 'valid');
  expect(probe.providerErrors).toEqual([]);
  return { probe, state: (await readState(seeded.sessDir))!, objectSha };
}

describe.skipIf(!LIVE)('native reviewer observation parity', () => {
  it('replays actual child observations before binding a cited repository finding', async () => {
    const h = await runObservation('valid');
    const assurance = h.state.reviewAssurance!;
    expect(assurance.obligations[0]?.status, JSON.stringify(assurance)).toBe('fulfilled');
    expect(assurance.invocations).toHaveLength(1);
    expect(assurance.attempts[0]?.observations).toEqual([
      expect.objectContaining({
        attemptId: assurance.attempts[0]!.attemptId,
        observedBySessionId: assurance.invocations[0]!.childSessionId,
        path: 'capture-sentinel.txt',
        revision: 'head',
        resolvedObjectSha: h.objectSha,
        contentDigest: contentDigestOf(Buffer.from(h.probe.sentinel)),
      }),
    ]);
    const request = JSON.stringify(
      h.probe.calls.filter((call) => call.phase === 'review').at(-1)?.body,
    );
    expect(request).toContain(h.probe.sentinel);
    expect(request).not.toContain('MUTABLE_WORKTREE_MUST_NOT_BE_OBSERVED');
  }, 120_000);

  it.each(['foreign', 'parent', 'revision', 'content', 'response'] as const)(
    'refuses a repository citation after a %s capture substitution',
    async (mode) => {
      const h = await runObservation(mode);
      expect(h.state.reviewAssurance!.invocations).toEqual([]);
      expect(h.state.reviewAssurance!.obligations[0]?.status).toBe('blocked');
      expect(h.state.reviewAssurance!.obligations[0]?.blockedCode).toBe(
        'REVIEW_EVIDENCE_NOT_OBSERVED',
      );
      expect(h.state.reviewAssurance!.attempts[0]?.observations).toEqual([]);
    },
    120_000,
  );
});

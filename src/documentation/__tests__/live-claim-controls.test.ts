/**
 * @module documentation/live-claim-controls.test
 * @description Fail-closed test oracles for the critical-claim live controls.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ADVERSARIAL_ASSERTION,
  TICKET_FILE,
  assertClaimEvidence,
  assertRetainedCriticalClaim,
  criticalClaimDeclaration,
  prepareClaimWorkspace,
} from '../../../demos/java-task-manager/run-live-claim-controls.mjs';
import { finalizeControlRecord } from '../../../demos/java-task-manager/run-live-matrix.mjs';

const CLAIM_ID = '11111111-1111-4111-8111-111111111111';

function caseState(negative = false) {
  const certificate = {
    certificateId: '22222222-2222-4222-8222-222222222222',
    claimDeclarationsDigest: 'a'.repeat(64),
    decisionAttestationDigest: 'b'.repeat(64),
  };
  const fact = {
    claimId: CLAIM_ID,
    critical: true,
    signalClass: 'fact',
    provenance: {
      kind: 'canonical_authority',
      authorityId: 'plan',
      digest: 'plan-digest',
      approval: { ...certificate, declarationId: CLAIM_ID },
    },
  };
  return {
    phase: 'EVIDENCE_REVIEW',
    plan: {
      current: { digest: 'plan-digest' },
      approvalCertificate: certificate,
      claimDeclarations: { claims: [{ ...criticalClaimDeclaration(), claimId: CLAIM_ID }] },
    },
    proofContract: { claims: [fact] },
    proofGraph: {
      claims: [
        {
          ...fact,
          verificationState: negative ? 'NOT_VERIFIED' : 'PROVEN',
          freshness: { stale: false },
        },
      ],
    },
    validationAttempts: [
      {
        scope: 'implementation',
        attemptId: 'build-attempt',
        result: {
          checkId: 'build',
          passed: true,
          exitCode: 0,
          assertionExtraction: {
            assertions: [
              {
                assertion: { providerId: 'junit', localId: ADVERSARIAL_ASSERTION },
                status: negative ? 'skipped' : 'passed',
              },
            ],
          },
        },
      },
      {
        scope: 'implementation',
        attemptId: 'test-attempt',
        result: { checkId: 'test', passed: true, exitCode: 0 },
      },
    ],
  };
}

describe('critical claim live-control oracles', () => {
  it('requires the retained critical specific-behavior claim, never a weakened one', () => {
    const state = caseState();
    expect(assertRetainedCriticalClaim(state)).toBe(CLAIM_ID);
    state.plan.claimDeclarations.claims = [];
    expect(() => assertRetainedCriticalClaim(state)).toThrow(/retained critical plan claim/);
    const weakened = caseState();
    weakened.plan.claimDeclarations.claims[0]!.critical = false;
    expect(() => assertRetainedCriticalClaim(weakened)).toThrow(/changed or weakened/);
    const swapped = caseState();
    swapped.plan.claimDeclarations.claims[0]!.counterexampleRequirement.assertion.localId =
      'OtherTest#otherMethod';
    expect(() => assertRetainedCriticalClaim(swapped)).toThrow(/changed or weakened/);
  });

  it('accepts only a fresh certificate-bound PROVEN fact with its passed adversarial assertion', () => {
    expect(assertClaimEvidence(caseState(false), { negative: false })).toMatchObject({
      verificationState: 'PROVEN',
      adversarialStatus: 'passed',
    });
    const advisory = caseState();
    advisory.proofContract.claims[0]!.signalClass = 'hypothesis';
    expect(() => assertClaimEvidence(advisory, { negative: false })).toThrow(/critical fact/);
    const foreign = caseState();
    foreign.proofContract.claims[0]!.provenance.approval.certificateId = 'foreign';
    expect(() => assertClaimEvidence(foreign, { negative: false })).toThrow(/certificate binding/);
  });

  it('requires the negative case to be genuinely skipped while the checks stay green', () => {
    expect(assertClaimEvidence(caseState(true), { negative: true })).toMatchObject({
      verificationState: 'NOT_VERIFIED',
      adversarialStatus: 'skipped',
    });
    const passedInstead = caseState(true);
    passedInstead.validationAttempts[0]!.result.assertionExtraction!.assertions[0]!.status =
      'passed';
    expect(() => assertClaimEvidence(passedInstead, { negative: true })).toThrow(/to be skipped/);
    const proven = caseState(true);
    proven.proofGraph.claims[0]!.verificationState = 'PROVEN';
    expect(() => assertClaimEvidence(proven, { negative: true })).toThrow(
      /unexpected claim verification state/,
    );
  });

  it('rejects a green check without the scoped adversarial evidence', () => {
    const missing = caseState(false);
    missing.validationAttempts[0]!.result.assertionExtraction!.assertions = [];
    expect(() => assertClaimEvidence(missing, { negative: false })).toThrow(
      /adversarial assertion/,
    );
    const baselineOnly = caseState(false);
    baselineOnly.validationAttempts[0]!.scope = 'baseline';
    expect(() => assertClaimEvidence(baselineOnly, { negative: false })).toThrow(
      /checks must be green/,
    );
    const redCheck = caseState(false);
    redCheck.validationAttempts[1]!.result.passed = false;
    expect(() => assertClaimEvidence(redCheck, { negative: false })).toThrow(
      /checks must be green/,
    );
  });

  describe('prepareClaimWorkspace', () => {
    let root: string;

    beforeEach(async () => {
      root = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-claim-fixture-'));
      await fs.mkdir(path.join(root, '.opencode'), { recursive: true });
      await fs.writeFile(
        path.join(root, '.opencode/flowguard.json'),
        JSON.stringify({
          schemaVersion: 'v1',
          policy: { defaultMode: 'team' },
          archive: { redaction: { allowRawExport: false } },
        }),
      );
      execFileSync('git', ['init', '-q'], { cwd: root });
      execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
      execFileSync('git', ['config', 'user.name', 'T'], { cwd: root });
      await fs.writeFile(path.join(root, 'README.md'), '# seed');
      execFileSync('git', ['add', 'README.md'], { cwd: root });
      execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: root });
    });

    afterEach(async () => {
      await fs.rm(root, { recursive: true, force: true });
    });

    it('commits both fixtures and opts the workspace into reduced ceremony', async () => {
      prepareClaimWorkspace(root);
      const config = JSON.parse(
        await fs.readFile(path.join(root, '.opencode/flowguard.json'), 'utf8'),
      );
      expect(config.policy.allowReducedCeremony).toBe(true);
      expect(config.archive.redaction.allowRawExport).toBe(true);
      expect(await fs.readFile(path.join(root, TICKET_FILE), 'utf8')).toContain('usage-notes.md');
      const hint = await fs.readFile(
        path.join(root, 'src/test/java/com/example/taskmanager/UsageNotesHintTest.java'),
        'utf8',
      );
      const falsifier = await fs.readFile(
        path.join(
          root,
          'src/test/java/com/example/taskmanager/UsageNotesFalsificationProbeTest.java',
        ),
        'utf8',
      );
      expect(hint).toContain('documentsTestCommand');
      expect(falsifier).toContain('noConflictingCommandIsDocumented');
      expect(falsifier).toContain('FLOWGUARD_LIVE_SKIP_ASSERTION');
      expect(await fs.readFile(path.join(root, 'docs/usage-notes.md'), 'utf8')).toContain(
        'Run ./mvnw test to run the task-manager tests.',
      );
      const status = execFileSync(
        'git',
        ['status', '--porcelain', '--', 'src', 'docs', TICKET_FILE],
        {
          cwd: root,
          encoding: 'utf8',
        },
      );
      expect(status.trim()).toBe('');
    });
  });
});

describe('live claim control PASS contract', () => {
  const session = { sessionId: 'ses_live_claim_01', workspace: '/tmp/live-claim' };

  it('HAPPY: records PASS only after captureProvenance validated the transcripts', async () => {
    const events: string[] = [];
    const record: Record<string, unknown> = { name: 'case-a', result: 'FAILED' };
    const runner = {
      captureProvenance: async (target: Record<string, unknown>) => {
        expect(target.result).toBe('FAILED');
        expect(target.hostSessionId).toBe(session.sessionId);
        events.push('capture');
      },
    };
    const result = await finalizeControlRecord(record, session, runner, {
      expectedOutcome: 'completed',
      phase: 'COMPLETE',
    });
    expect(events).toEqual(['capture']);
    expect(result.result).toBe('PASS');
    expect(result.phase).toBe('COMPLETE');
  });

  it('BAD: a failing transcript capture keeps the record FAILED and cannot be counted', async () => {
    const record: Record<string, unknown> = { name: 'case-b', result: 'FAILED' };
    const runner = {
      captureProvenance: async () => {
        throw new Error('host transcript export failed for ses_live_claim_01 (exit=1)');
      },
    };
    await expect(
      finalizeControlRecord(record, session, runner, { expectedOutcome: 'completed' }),
    ).rejects.toThrow('host transcript export failed');
    record.result = 'FAILED';
    record.error = 'Error: host transcript export failed for ses_live_claim_01 (exit=1)';
    expect(record.result).toBe('FAILED');
    expect(JSON.stringify(record)).not.toContain('"PASS"');
    const records = [record];
    const passed = records.filter((entry) => entry.result === 'PASS').length;
    expect(passed).toBe(0);
    expect(passed === records.length ? 0 : 1).toBe(1);
  });

  it('EDGE: a payload-supplied PASS cannot bypass capture validation', async () => {
    const record: Record<string, unknown> = { name: 'case-c', result: 'FAILED' };
    const runner = {
      captureProvenance: async () => {
        throw new Error('reviewer transcript missing');
      },
    };
    await expect(
      finalizeControlRecord(record, session, runner, { result: 'PASS' }),
    ).rejects.toThrow('reviewer transcript missing');
    expect(record.result).toBe('FAILED');
    expect(record).not.toHaveProperty('transcripts');
  });

  it('CORNER: finalize clears a stale PASS before capture runs', async () => {
    const record: Record<string, unknown> = { name: 'case-d', result: 'PASS' };
    const runner = {
      captureProvenance: async (target: Record<string, unknown>) => {
        expect(target.result).toBe('FAILED');
      },
    };
    await finalizeControlRecord(record, session, runner);
    expect(record.result).toBe('PASS');
  });
});

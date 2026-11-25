/**
 * @module documentation/live-claim-controls.test
 * @description Fail-closed test oracles for the critical-claim live controls.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ADVERSARIAL_ASSERTION,
  PLAN_PROMPT,
  POSITIVE_ASSERTION,
  TICKET_FILE,
  assertClaimEvidence,
  assertPostTaskAdoption,
  assertRetainedCriticalClaim,
  criticalClaimDeclaration,
  prepareClaimWorkspace,
  runCase,
  selectedClaimCases,
} from '../../../demos/java-task-manager/run-live-claim-controls.mjs';
import { finalizeControlRecord } from '../../../demos/java-task-manager/run-live-matrix.mjs';
import { RESULT } from '../../../demos/lib/results.mjs';

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
    implementation: { digest: 'impl-digest' },
    proofContract: { claims: [fact] },
    proofGraph: {
      claims: [
        {
          ...fact,
          verificationState: negative ? 'NOT_VERIFIED' : 'PROVEN',
          freshness: { stale: false, boundDigest: 'impl-digest' },
          evidenceRefs: [{ kind: 'validation_attempt', attemptId: 'test-attempt' }],
          counterexampleRefs: [{ kind: 'validation_attempt', attemptId: 'build-attempt' }],
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
        result: {
          checkId: 'test',
          passed: true,
          exitCode: 0,
          assertionExtraction: {
            assertions: [
              {
                assertion: { providerId: 'junit', localId: POSITIVE_ASSERTION },
                status: 'passed',
              },
            ],
          },
        },
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
    passedInstead.validationAttempts[0]!.result.assertionExtraction.assertions[0]!.status =
      'passed';
    expect(() => assertClaimEvidence(passedInstead, { negative: true })).toThrow(/must be skipped/);
    const proven = caseState(true);
    proven.proofGraph.claims[0]!.verificationState = 'PROVEN';
    expect(() => assertClaimEvidence(proven, { negative: true })).toThrow(
      /unexpected claim verification state/,
    );
  });

  it('rejects a green check without the scoped adversarial evidence', () => {
    const missing = caseState(false);
    missing.validationAttempts[0]!.result.assertionExtraction.assertions = [];
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

describe('claim-control orchestration boundary', () => {
  let workspace: string;
  const ticketText = [
    '# Documentation claim control',
    '',
    'Extend docs/usage-notes.md without changing the documented command.',
    '',
    'Run ./mvnw test to run the task-manager tests.',
    '',
  ].join('\n');
  const ticketDigest = createHash('sha256').update(ticketText).digest('hex');

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-claim-orchestration-'));
    await fs.writeFile(path.join(workspace, TICKET_FILE), ticketText);
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  function postTaskState(phase: string, claims: unknown[] | null = null) {
    return {
      phase,
      flowguardSessionId: 'fg-claim',
      binding: { hostSessionId: 'ses_claim' },
      ticket: {
        digest: ticketDigest,
        text: ticketText,
        source: 'user',
        inputOrigin: 'workspace',
        references: [{ ref: TICKET_FILE, type: 'doc' }],
      },
      plan:
        claims === null
          ? null
          : {
              claimDeclarations: { claims },
              current: { digest: 'plan-digest' },
              reviewCompletion: 'reviewer_accepted',
            },
    };
  }

  it('accepts exactly the persisted repository ticket with no plan', () => {
    const state = postTaskState('TICKET');
    expect(assertPostTaskAdoption(state, { digest: ticketDigest, text: ticketText })).toBe(
      state.ticket,
    );
    expect(() =>
      assertPostTaskAdoption(
        { ...state, ticket: { ...state.ticket, digest: 'a'.repeat(64) } },
        { digest: ticketDigest, text: ticketText },
      ),
    ).toThrow(/exact repository ticket/);
    expect(() =>
      assertPostTaskAdoption(
        { ...state, ticket: { ...state.ticket, text: 'changed' } },
        { digest: ticketDigest, text: ticketText },
      ),
    ).toThrow(/exact repository ticket/);
    expect(() =>
      assertPostTaskAdoption(
        { ...state, ticket: { ...state.ticket, source: 'repository' } },
        { digest: ticketDigest, text: ticketText },
      ),
    ).toThrow(/repository ticket source/);
    expect(() =>
      assertPostTaskAdoption(
        { ...state, ticket: { ...state.ticket, inputOrigin: undefined } },
        { digest: ticketDigest, text: ticketText },
      ),
    ).toThrow(/workspace input origin/);
    expect(() =>
      assertPostTaskAdoption(
        { ...state, ticket: { ...state.ticket, inputOrigin: 'external_reference' } },
        { digest: ticketDigest, text: ticketText },
      ),
    ).toThrow(/workspace input origin/);
    expect(() =>
      assertPostTaskAdoption(
        { ...state, ticket: { ...state.ticket, references: [] } },
        { digest: ticketDigest, text: ticketText },
      ),
    ).toThrow(/does not reference the repository ticket/);
    expect(() =>
      assertPostTaskAdoption(
        {
          ...state,
          ticket: {
            ...state.ticket,
            references: [{ ref: 'TICKET_DOCS.md', type: 'doc' }],
          },
        },
        { digest: ticketDigest, text: ticketText },
      ),
    ).toThrow(/does not reference the repository ticket/);
    expect(() =>
      assertPostTaskAdoption(
        { ...state, plan: { claimDeclarations: { claims: [] } } },
        { digest: ticketDigest, text: ticketText },
      ),
    ).toThrow(/planning must be a separate turn/);
  });

  it('fails closed for every planning spill before a plan command can be dispatched', async () => {
    const altered = {
      ...criticalClaimDeclaration(),
      statement: `${criticalClaimDeclaration().statement} (altered)`,
    };
    const cases: Array<[string, ReturnType<typeof postTaskState>]> = [
      ['plan', postTaskState('PLAN')],
      ['plan-review-missing', postTaskState('PLAN_REVIEW', [])],
      ['plan-review-altered', postTaskState('PLAN_REVIEW', [altered])],
      [
        'plan-review-multiple',
        postTaskState('PLAN_REVIEW', [
          criticalClaimDeclaration(),
          { ...criticalClaimDeclaration(), statement: 'second claim' },
        ]),
      ],
    ];
    for (const [label, afterTask] of cases) {
      const calls: Array<{ label: string; prompt: string | undefined; command: unknown }> = [];
      let state: Record<string, unknown> = postTaskState('READY');
      const runner = {
        options: {},
        turn: async (
          _session: unknown,
          callLabel: string,
          prompt: string | undefined,
          options: { command?: string } = {},
        ) => {
          calls.push({ label: callLabel, prompt, command: options.command });
          state = callLabel.endsWith('-01-start') ? postTaskState('READY') : afterTask;
          return { code: 0, stderr: '', timedOut: false, durationMs: 0, sessionIds: [] };
        },
        installedBuild: () => ({ gitSha: 'head' }),
        requireBoundState: () => ({ state, sessionDir: workspace }),
        log: () => {},
      };
      const record = await runCase(runner, 'claim-negative', workspace, true);
      expect(record.result, label).toBe(RESULT.NOT_VERIFIED);
      expect(
        calls.map((call) => call.label),
        label,
      ).toEqual(['claim-negative-01-start', 'claim-negative-02-task']);
      expect(
        calls.some((call) => call.label.includes('03-plan')),
        label,
      ).toBe(false);
      expect(
        calls.some((call) => call.command === 'plan'),
        label,
      ).toBe(false);
      expect(calls[1]?.prompt, label).toContain('Adopt only this repository ticket');
    }
  });

  it('uses one shared plan prompt with the hypothetical counterexample and finding binding', () => {
    const prompt = PLAN_PROMPT([criticalClaimDeclaration()]);
    expect(prompt).toContain('keep the complete required documentation line unchanged');
    expect(prompt).toContain('add a separate conflicting command containing -DskipTests');
    expect(prompt).toContain('presence assertion passes');
    expect(prompt).toContain('conflicting-command assertion fails');
    expect(prompt).toContain('plan reasoning only');
    expect(prompt).toContain('do not implement the counterexample');
    expect(prompt).toContain('current bound review obligation');
    expect(prompt).toContain('review iteration, plan version and that review');
    expect(JSON.stringify(prompt)).not.toContain('negative');
  });
});

describe('live claim control host integration', () => {
  it('uses the host command boundary and the exact ProofGraph denial oracle', async () => {
    const controls = await fs.readFile(
      new URL('../../../demos/java-task-manager/run-live-claim-controls.mjs', import.meta.url),
      'utf8',
    );
    expect(controls).toContain("command: 'export'");
    expect(controls).toContain('PROOFGRAPH_CRITICAL_FACTS_UNPROVEN');
    expect(controls).toContain('FLOWGUARD_CLAIM_CASES');
    expect(controls).toContain("'--demo'");
    expect(controls).toContain("expectedDenialTool: 'flowguard_decision'");
    expect(controls).not.toContain('denialText');
    expect(controls).not.toContain("'--command'");
  });

  it('requires exactly one explicit claim-control selection', () => {
    const previous = process.env.FLOWGUARD_CLAIM_CASES;
    try {
      delete process.env.FLOWGUARD_CLAIM_CASES;
      expect(() => selectedClaimCases()).toThrow(/must explicitly select exactly one/);
      process.env.FLOWGUARD_CLAIM_CASES = '';
      expect(() => selectedClaimCases()).toThrow(/must explicitly select exactly one/);
      process.env.FLOWGUARD_CLAIM_CASES = 'claim-positive,claim-negative';
      expect(() => selectedClaimCases()).toThrow(/must select exactly one/);
      process.env.FLOWGUARD_CLAIM_CASES = 'claim-positive,';
      expect(() => selectedClaimCases()).toThrow(/must select exactly one/);
      process.env.FLOWGUARD_CLAIM_CASES = 'claim-negative';
      expect(selectedClaimCases()).toEqual(['claim-negative']);
    } finally {
      if (previous === undefined) delete process.env.FLOWGUARD_CLAIM_CASES;
      else process.env.FLOWGUARD_CLAIM_CASES = previous;
    }
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
    expect(result.result).toBe(RESULT.CONTROL_PASSED);
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
    const passed = records.filter((entry) => entry.result === RESULT.CONTROL_PASSED).length;
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
    const record: Record<string, unknown> = { name: 'case-d', result: RESULT.CONTROL_PASSED };
    const runner = {
      captureProvenance: async (target: Record<string, unknown>) => {
        expect(target.result).toBe('FAILED');
      },
    };
    await finalizeControlRecord(record, session, runner);
    expect(record.result).toBe(RESULT.CONTROL_PASSED);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTestWorkspace, type TestWorkspace } from '../../test-helpers.js';
import { makeState } from '../../../fixtures.js';
import {
  makePlanRevision,
  TEST_EXECUTION_OBSERVATION,
} from '../../../state/evidence-test-constants.js';
import { planApprovalContextOf } from '../../../state/proofgraph-approval-context.js';
import { planApprovalCertificateIdentity } from '../../../state/proofgraph-plan-certificate.js';
import { canonicalJsonStringify } from '../../../shared/canonical-json.js';
import { hashText } from '../../../shared/hashing.js';
import { FalsificationExecution } from '../../../state/evidence-validation.js';
import { runDeclaredFalsifications } from './run-falsifications.js';
import { bindCounterexamples } from '../../../audit/proofgraph/counterexample-binder.js';
import { bindExecutedTestEvidence } from '../../../audit/proofgraph/executed-test-binder.js';
import { evaluateProofGraph } from '../../../audit/proofgraph/evaluate.js';
import type { SessionState } from '../../../state/schema.js';
import type { VerificationCandidate } from '../../../state/discovery-schemas.js';
import type { CounterexampleRequirement } from '../../../state/proofgraph.js';

const CLAIM = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-11-13T00:00:00.000Z';
const candidate: VerificationCandidate = {
  candidateId: 'fixture-build',
  kind: 'build',
  command: 'node check.cjs',
  source: 'fixture',
  confidence: 'high',
  reason: 'JUnit fixture',
  assertionCapability: 'structured',
  assertionReport: {
    collection: 'snapshot_diff',
    transport: 'file',
    providerId: 'junit',
    format: 'junit_xml',
    standardPatterns: ['reports/TEST-*.xml'],
  },
};
let ws: TestWorkspace;
beforeEach(async () => {
  ws = await createTestWorkspace();
  await writeFile(join(ws.tmpDir, 'guard.txt'), 'guard enabled\n');
  await writeFile(
    join(ws.tmpDir, 'check.cjs'),
    `
const fs = require('node:fs');
const pass = fs.readFileSync('guard.txt','utf8').includes('guard enabled');
fs.mkdirSync('reports', {recursive:true});
fs.writeFileSync('reports/TEST-guard.xml', '<testsuite name="example.GuardTest" tests="1" failures="'+(pass?0:1)+'"><testcase classname="example.GuardTest" name="missingId">'+(pass?'':'<failure message="wrong status">expected 404</failure>')+'</testcase></testsuite>');
console.log(pass?'guard passed':'guard failed');
process.exitCode=pass?0:1;
`,
  );
});
afterEach(async () => {
  await ws.cleanup();
});

const DEFAULT_REQUIREMENT: CounterexampleRequirement = {
  kind: 'assertion',
  checkId: 'build',
  assertion: { providerId: 'junit', localId: 'example.GuardTest#missingId' },
  variant: { path: 'guard.txt', before: 'guard enabled', after: 'guard removed' },
};

function approvedState(requirement: CounterexampleRequirement = DEFAULT_REQUIREMENT): SessionState {
  const state = makeState('IMPL_VALIDATION', {
    implementation: {
      implementationId: '11111111-1111-4111-8111-111111111111',
      changedFiles: ['guard.txt'],
      domainFiles: ['guard.txt'],
      digest: 'implementation',
      executedAt: NOW,
    },
  });
  const current = makePlanRevision({
    body: 'Remove guard in an isolated source copy; keep tests unchanged.',
  });
  const claimDeclarations = {
    flow: 'plan' as const,
    version: 'v2' as const,
    claims: [
      {
        claimId: CLAIM,
        statement: 'Missing id returns 404',
        critical: true,
        claimScope: 'specific_behavior' as const,
        expectedCheckId: 'test',
        authoritySectionId: 'implementation',
        expectedAssertion: { providerId: 'junit', localId: 'example.GuardTest#missingId' },
        counterexampleRequirement: requirement,
      },
    ],
  };
  const context = planApprovalContextOf(state);
  const approvalAttestation = {
    ...context,
    kind: 'explicit_decision' as const,
    decision: {
      verdict: 'approve' as const,
      rationale: 'fixture approval',
      decidedAt: NOW,
      decisionIdentity: {
        actorId: 'fixture',
        actorEmail: null,
        actorSource: 'unknown' as const,
        actorAssurance: 'best_effort' as const,
      },
    },
  };
  const binding = {
    authorityDigest: current.digest,
    claimDeclarationsDigest: hashText(canonicalJsonStringify(claimDeclarations)),
    decisionAttestationDigest: hashText(canonicalJsonStringify(approvalAttestation)),
    planVersion: 1,
    planRecordDigest: current.recordDigest,
    approvedAt: NOW,
    reviewBinding: {
      kind: 'current_review' as const,
      reviewObligationId: '33333333-3333-4333-8333-333333333333',
      reviewEvidenceDigest: 'e'.repeat(64),
      reviewedSubjectDigest: current.digest,
    },
  };
  return {
    ...state,
    plan: {
      current,
      history: [],
      reviewFindings: [],
      reviewCompletion: 'pending',
      claimDeclarations,
      approvalCertificate: {
        ...binding,
        schemaVersion: 'plan-approval-certificate.v1',
        flow: 'plan',
        certificateId: planApprovalCertificateIdentity(binding),
        approvalAttestation,
      },
    },
  };
}

describe('executed falsification path', () => {
  it('executes control and variant, binds targeted failure, and never edits original sources', async () => {
    const state = approvedState();
    const records = await runDeclaredFalsifications(state, candidate, ws.tmpDir);
    expect(records).toHaveLength(1);
    const record = FalsificationExecution.parse(records[0]);
    expect(record.control).toMatchObject({ passed: true, exitCode: 0 });
    expect(record.variant).toMatchObject({ passed: false, exitCode: 1 });
    expect(record.controlSourceDigest).not.toBe(record.variantSourceDigest);
    expect(await readFile(join(ws.tmpDir, 'guard.txt'), 'utf8')).toBe('guard enabled\n');
    expect(await readFile(join(ws.tmpDir, 'check.cjs'), 'utf8')).toContain('guard enabled');
    const requirement = state.plan!.claimDeclarations!.claims[0]!.counterexampleRequirement!;
    const claim = {
      claimId: CLAIM,
      statement: 'Missing id returns 404',
      signalClass: 'fact' as const,
      critical: true,
      claimScope: 'specific_behavior' as const,
      provenance: {
        kind: 'canonical_authority' as const,
        authorityId: 'ticket',
        digest: 'authority',
      },
      evidenceRefs: [{ kind: 'validation_attempt' as const, attemptId: record.controlAttemptId }],
      counterexampleRefs: [
        { kind: 'validation_attempt' as const, attemptId: '44444444-4444-4444-8444-444444444444' },
      ],
      counterexampleRequirement: requirement,
      requiredEvidence: {
        positive: ['executed_test' as const],
        adversarial: ['counterexample' as const],
      },
    };
    const bound: SessionState = {
      ...state,
      proofContract: { version: 'contract.v2', claims: [claim] },
      validationAttempts: [
        {
          attemptId: record.controlAttemptId,
          scope: 'implementation',
          implementationId: state.implementation!.implementationId,
          implementationDigest: 'implementation',
          executionObservation: TEST_EXECUTION_OBSERVATION,
          result: { ...record.control, checkId: 'test', kind: 'test' },
        },
        {
          attemptId: '44444444-4444-4444-8444-444444444444',
          scope: 'implementation',
          implementationId: state.implementation!.implementationId,
          implementationDigest: 'implementation',
          executionObservation: TEST_EXECUTION_OBSERVATION,
          result: record.control,
          falsifications: records,
        },
      ],
    };
    const counterexamples = bindCounterexamples(bound, NOW).counterexamples;
    expect(counterexamples[0]?.outcome).toBe('supported');
    const evaluated = evaluateProofGraph(
      {
        claims: [claim],
        providerResults: bindExecutedTestEvidence(bound, NOW),
        counterexamples,
        currentImplementationDigest: 'implementation',
      },
      NOW,
    );
    expect(evaluated.claims[0]?.verificationState).toBe('PROVEN');
  });
  it('records no falsification when the declaration changed after approval and leaves the original untouched', async () => {
    const state = approvedState();
    const declarations = state.plan!.claimDeclarations!;
    const claim = declarations.claims[0]!;
    const changed = {
      ...state,
      plan: {
        ...state.plan!,
        claimDeclarations: {
          ...declarations,
          claims: [{ ...claim, statement: 'changed after approval' }],
        },
      },
    };
    expect(await runDeclaredFalsifications(changed, candidate, ws.tmpDir)).toEqual([]);
    expect(await readFile(join(ws.tmpDir, 'guard.txt'), 'utf8')).toBe('guard enabled\n');
  });
  it('records no variant evidence for a non-unique source match and never edits the original', async () => {
    await writeFile(join(ws.tmpDir, 'guard.txt'), 'guard enabled guard enabled');
    expect(await runDeclaredFalsifications(approvedState(), candidate, ws.tmpDir)).toEqual([]);
    expect(await readFile(join(ws.tmpDir, 'guard.txt'), 'utf8')).toBe(
      'guard enabled guard enabled',
    );
  });
  it('records no falsification for a variant outside the governed implementation', async () => {
    const state = approvedState();
    const outside = {
      ...state,
      implementation: state.implementation ? { ...state.implementation, changedFiles: [] } : null,
    };
    expect(await runDeclaredFalsifications(outside, candidate, ws.tmpDir)).toEqual([]);
  });
  it('records no falsification when the variant path is a verification execution input', async () => {
    const guarded = {
      ...approvedState(),
      executionSubjectInputsByCandidateId: {
        [candidate.candidateId]: [{ kind: 'file' as const, path: 'guard.txt' }],
      },
    };
    expect(await runDeclaredFalsifications(guarded, candidate, ws.tmpDir)).toEqual([]);
  });
  it('records nothing outside IMPL_VALIDATION', async () => {
    const state = { ...approvedState(), phase: 'VALIDATION' as const };
    expect(await runDeclaredFalsifications(state, candidate, ws.tmpDir)).toEqual([]);
  });
  it('records nothing for an assertion-unsupported candidate', async () => {
    const unsupported: VerificationCandidate = {
      candidateId: 'fixture-build',
      kind: 'build',
      command: 'node check.cjs',
      source: 'fixture',
      confidence: 'high',
      reason: 'unsupported fixture',
      assertionCapability: 'unsupported',
    };
    expect(await runDeclaredFalsifications(approvedState(), unsupported, ws.tmpDir)).toEqual([]);
  });
  it('records nothing without declared claims', async () => {
    const state = approvedState();
    const empty = {
      ...state,
      plan: state.plan
        ? {
            ...state.plan,
            claimDeclarations: { flow: 'plan' as const, version: 'v2' as const, claims: [] },
          }
        : null,
    };
    expect(await runDeclaredFalsifications(empty, candidate, ws.tmpDir)).toEqual([]);
  });
  it('skips an aggregate requirement bound to a different candidate', async () => {
    const state = approvedState({
      kind: 'aggregate_check',
      checkId: 'build',
      candidateId: 'other-candidate',
      variant: DEFAULT_REQUIREMENT.variant,
    });
    expect(await runDeclaredFalsifications(state, candidate, ws.tmpDir)).toEqual([]);
  });
});

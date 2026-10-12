#!/usr/bin/env node
/**
 * @module run-live-risk-trigger-controls
 * @description Real-host controls for #1074 risk-trigger coverage.
 *
 * An isolated minimal Maven repository whose governed artifact lives under
 * `src/state/` (classification: HIGH-RISK + `state_integrity`). Two cases:
 *
 *  - uncovered: a valid certificate-authorized critical fact claim exists but
 *    does not cover the detected trigger. The real approval gate must deny with
 *    exactly PROOFGRAPH_RISK_TRIGGER_UNCOVERED (not an earlier precondition).
 *  - covered: the same claim carries `coversRiskTriggers: ['state_integrity']`
 *    inside the approved claim set, reaches PROVEN and passes ordinary approval.
 *
 * The coverage is part of the approved plan claim set; it is never declared after
 * approval. No runtime, demo or state edit.
 *
 * Usage:
 *   node demos/risk-trigger-fixture/run-live-risk-trigger-controls.mjs --root <dir> [--tarball <tgz>]
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  Runner,
  assertToolchain,
  finalizeControlRecord,
  parseArgs,
  readPins,
  sha256,
  verifyChecksumSidecar,
} from '../java-task-manager/run-live-matrix.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SCRIPT_DIR, '..', '..');
const SEED = path.join(REPO, 'demos', 'java-task-manager', 'seed');
const FIXTURE = SCRIPT_DIR;
const SKIP_ASSERTION_ENV = 'FLOWGUARD_LIVE_SKIP_ASSERTION';
const INVARIANT = 'The module must reject any write that omits the ownership field.';
export const POSITIVE_ASSERTION = 'fixture.StateNoteTest#documentsInvariant';
export const ADVERSARIAL_ASSERTION =
  'fixture.StateNoteFalsificationProbeTest#noRelaxedInvariantIsDocumented';

/** TRUE when the claim declares the detected trigger; FALSE keeps it uncovered. */
export function claimDeclaration(covered) {
  return {
    statement: `src/state/module-state.md documents the ownership invariant: ${INVARIANT}`,
    critical: true,
    authoritySectionId: 'Invariant',
    claimScope: 'specific_behavior',
    expectedCheckId: 'test',
    counterexampleRequirement: {
      kind: 'assertion',
      checkId: 'build',
      assertion: { providerId: 'junit', localId: ADVERSARIAL_ASSERTION },
    },
    ...(covered ? { coversRiskTriggers: ['state_integrity'] } : {}),
  };
}

/** Assert the trigger was detected from the real implementation change. */
export function assertStateIntegrityTrigger(state) {
  const triggers = state.implementationRiskAssessment?.riskTriggers ?? [];
  if (!triggers.includes('state_integrity')) {
    throw new Error(`state_integrity trigger not detected: [${triggers.join(', ')}]`);
  }
  return state.implementationRiskAssessment;
}

/** Reject withdrawal, weakening or a post-approval coverage declaration. */
export function assertRetainedClaim(state, covered) {
  const expected = claimDeclaration(covered);
  const claims = state.plan?.claimDeclarations?.claims;
  if (!Array.isArray(claims) || claims.length !== 1) {
    throw new Error('exactly one retained critical plan claim is required');
  }
  const { claimId, ...persisted } = claims[0];
  if (typeof claimId !== 'string' || claimId.length === 0) {
    throw new Error('the retained claim has no runtime-minted identity');
  }
  // Exact contract comparison, except the host-minted claimId: statement,
  // authority section, scope, positive check, adversarial check and the exact
  // coverage set must all match. A weakened or substituted claim fails closed.
  if (JSON.stringify(persisted) !== JSON.stringify(expected)) {
    throw new Error(
      `the retained critical claim no longer matches the control contract: ${JSON.stringify(persisted)}`,
    );
  }
  return claimId;
}

/**
 * The full pre-approval evidence contract, identical for both cases. The claim
 * must be a certificate-bound critical fact, fresh and PROVEN, with two DISTINCT
 * real implementation attempts for `test` and `build`, both passed, and the
 * adversarial assertion passed. Only after this holds may the cases differ by
 * `coversRiskTriggers`, so a denial proves coverage is the sole blocker.
 */
export function assertFullEvidence(state, covered) {
  const claimId = assertRetainedClaim(state, covered);
  const contract = state.proofContract?.claims?.find((claim) => claim.claimId === claimId);
  const projected = state.proofGraph?.claims?.find((claim) => claim.claimId === claimId);
  if (!contract || contract.signalClass !== 'fact' || !contract.critical) {
    throw new Error('the retained claim is not materialized as a governing critical fact');
  }
  const certificate = state.plan?.approvalCertificate;
  const authority = contract.provenance;
  if (
    !certificate ||
    authority?.kind !== 'canonical_authority' ||
    authority.authorityId !== 'plan' ||
    authority.digest !== state.plan.current.digest ||
    authority.approval?.certificateId !== certificate.certificateId ||
    authority.approval.declarationId !== claimId
  ) {
    throw new Error('the critical fact lacks its current plan certificate binding');
  }
  // Freshness is required, not merely "not stale": the projection must carry a
  // bound digest equal to the current implementation revision.
  if (
    !projected ||
    projected.verificationState !== 'PROVEN' ||
    projected.freshness === undefined ||
    projected.freshness.stale !== false ||
    projected.freshness.boundDigest !== state.implementation?.digest
  ) {
    throw new Error(
      `expected a fresh PROVEN claim bound to the current implementation, observed ${String(projected?.verificationState)}`,
    );
  }
  const attempts = (state.validationAttempts ?? []).filter((a) => a.scope === 'implementation');
  const build = attempts.filter((a) => a.result.checkId === 'build').at(-1);
  const test = attempts.filter((a) => a.result.checkId === 'test').at(-1);
  if (
    !build?.result.passed ||
    build.result.exitCode !== 0 ||
    !test?.result.passed ||
    test.result.exitCode !== 0
  ) {
    throw new Error('both real implementation checks must be green');
  }
  if (build.attemptId === test.attemptId) {
    throw new Error('positive and adversarial evidence must come from distinct attempts');
  }
  const assertionOf = (attempt, localId) =>
    attempt.result.assertionExtraction?.assertions?.find(
      (a) => a.assertion?.providerId === 'junit' && a.assertion.localId === localId,
    );
  // Both explicitly bound assertions must be observed as passed: the positive
  // assertion and the distinct adversarial falsification probe.
  if (assertionOf(test, POSITIVE_ASSERTION)?.status !== 'passed') {
    throw new Error('the bound positive assertion must be passed and fresh');
  }
  if (assertionOf(build, ADVERSARIAL_ASSERTION)?.status !== 'passed') {
    throw new Error('the bound adversarial assertion must be passed and fresh');
  }
  // Role-specific binding: the positive evidence refs must reference exactly the
  // `test` attempt and the counterexample refs exactly the `build` attempt. A
  // swapped, shared or missing binding fails closed instead of being accepted via
  // a union of both roles.
  const attemptIdsOf = (refs) =>
    (refs ?? []).filter((ref) => ref?.kind === 'validation_attempt').map((ref) => ref.attemptId);
  const evidenceAttemptIds = attemptIdsOf(projected.evidenceRefs);
  const counterexampleAttemptIds = attemptIdsOf(projected.counterexampleRefs);
  if (!evidenceAttemptIds.includes(test.attemptId)) {
    throw new Error('the positive evidence does not reference the checked test attempt');
  }
  if (!counterexampleAttemptIds.includes(build.attemptId)) {
    throw new Error('the counterexample evidence does not reference the checked build attempt');
  }
  if (
    evidenceAttemptIds.includes(build.attemptId) ||
    counterexampleAttemptIds.includes(test.attemptId)
  ) {
    throw new Error(
      'the evidence roles are not independent: a checked attempt is cross-referenced',
    );
  }
  return { claimId, buildAttemptId: build.attemptId, testAttemptId: test.attemptId };
}

/** The installed build must be the checked-out revision when built from it. */
export function assertInstalledBuildIdentity(installed, checkoutHead, builtFromCheckout) {
  if (builtFromCheckout && installed?.gitSha !== checkoutHead) {
    throw new Error(
      `installed artifact gitSha ${String(installed?.gitSha)} != checkout ${checkoutHead}`,
    );
  }
  return installed;
}

/** A denied approval must leave no completion package and no completion evidence. */
export function assertNoCompletionPackage(runner, session) {
  const snapshot = runner.requireBoundState(session);
  const archiveDir = path.join(path.dirname(snapshot.sessionDir), 'archive');
  const produced = fs.existsSync(archiveDir)
    ? fs.readdirSync(archiveDir).filter((file) => file.includes(session.sessionId))
    : [];
  if (produced.length > 0) {
    throw new Error(`a denied approval produced completion package(s): ${produced.join(', ')}`);
  }
  if (snapshot.state.exportCompletionEvidence != null) {
    throw new Error('a denied approval persisted export completion evidence');
  }
  return { archiveDir, produced };
}

async function runCase(runner, name, workspace, covered, context) {
  const record = { name, covered, workspace, result: 'FAILED' };
  const session = { workspace, terminal: 'COMPLETE' };
  const savedSkip = process.env[SKIP_ASSERTION_ENV];
  try {
    await runner.turn(session, `${name}-01-start`, '/start');
    assertInstalledBuildIdentity(
      runner.installedBuild(workspace),
      context.checkoutHead,
      context.builtFromCheckout,
    );
    const ticketText = fs.readFileSync(path.join(workspace, 'TICKET.md'), 'utf8');
    await runner.turn(session, `${name}-02-task`, ticketText, { command: 'task' });
    await runner.turn(session, `${name}-03-plan`, PLAN_PROMPT([claimDeclaration(covered)]), {
      command: 'plan',
    });
    assertRetainedClaim(runner.requireBoundState(session).state, covered);
    await runner.approve(session, `${name}-04-approve-plan`, 'PLAN_REVIEW');
    assertRetainedClaim(runner.requireBoundState(session).state, covered);

    delete process.env[SKIP_ASSERTION_ENV];
    await runner.turn(
      session,
      `${name}-05-implement`,
      'Implement only src/state/module-state.md as the ticket describes: add the ## Change log ' +
        'section and keep the documented invariant unchanged. Run every required check. Do not modify the ' +
        'test fixtures, the build, the active checks, assertion reports or the retained claim. Stop at the ' +
        'human evidence gate; do not approve, override or export.',
      { command: 'implement' },
    );
    const state = runner.requireBoundState(session).state;
    const assessment = assertStateIntegrityTrigger(state);
    if (state.phase !== 'EVIDENCE_REVIEW') {
      throw new Error(`expected EVIDENCE_REVIEW, observed ${state.phase}`);
    }
    // Identical full evidence contract in BOTH cases: the claim is a
    // certificate-bound, fresh, PROVEN critical fact with distinct passed
    // test/build attempts and the passed adversarial assertion. Only coverage
    // may differ, so a denial proves coverage is the sole blocker.
    const evidence = assertFullEvidence(state, covered);

    if (!covered) {
      const before = state;
      await runner.turn(
        session,
        `${name}-06-approve`,
        'Demo approval through the real command boundary.',
        {
          command: 'approve',
          expectedDenial: 'PROOFGRAPH_RISK_TRIGGER_UNCOVERED',
        },
      );
      const after = runner.requireBoundState(session).state;
      if (after.phase !== 'EVIDENCE_REVIEW') throw new Error(`phase changed to ${after.phase}`);
      assertRetainedClaim(after, covered);
      if (
        JSON.stringify(after.reviewDecision ?? null) !==
        JSON.stringify(before.reviewDecision ?? null)
      ) {
        throw new Error('the blocked approval changed the persisted review decision');
      }
      const absence = assertNoCompletionPackage(runner, session);
      Object.assign(record, {
        expectedOutcome: 'blocked_at_evidence_gate',
        denial: 'PROOFGRAPH_RISK_TRIGGER_UNCOVERED',
        riskTriggers: assessment.riskTriggers,
        claimId: evidence.claimId.slice(0, 8),
        buildAttemptId: evidence.buildAttemptId,
        testAttemptId: evidence.testAttemptId,
        archiveDirContents: absence.produced,
        phase: after.phase,
        packages: [],
      });
    } else {
      await runner.approve(session, `${name}-06-approve`, 'EVIDENCE_REVIEW');
      await runner.turn(session, `${name}-07-export`, undefined, { command: 'export' });
      const final = runner.requireBoundState(session).state;
      if (final.phase !== 'COMPLETE') throw new Error(`expected COMPLETE, observed ${final.phase}`);
      const claimId = assertRetainedClaim(final, true);
      const projected = final.proofGraph?.claims?.find((claim) => claim.claimId === claimId);
      if (projected?.verificationState !== 'PROVEN') {
        throw new Error(`expected PROVEN, observed ${String(projected?.verificationState)}`);
      }
      Object.assign(record, {
        expectedOutcome: 'completed',
        buildAttemptId: evidence.buildAttemptId,
        testAttemptId: evidence.testAttemptId,
        claimId: claimId.slice(0, 8),
        riskTriggers: assessment.riskTriggers,
        verificationState: projected.verificationState,
        phase: final.phase,
        packages: [runner.verifyPackage(session, 'export', 'development', 'EXPORT_READY', name)],
      });
    }
    // PASS only after the parent and every required reviewer transcript were
    // exported and validated; a capture failure keeps the record FAILED.
    await finalizeControlRecord(record, session, runner);
  } catch (error) {
    record.result = 'FAILED';
    record.error = String(error);
  } finally {
    if (savedSkip === undefined) delete process.env[SKIP_ASSERTION_ENV];
    else process.env[SKIP_ASSERTION_ENV] = savedSkip;
  }
  return record;
}

const PLAN_PROMPT = (claims) =>
  `Create a complete plan for the ticket in TICKET.md. Its ## Verification section must state that ` +
  `baseline and post-implementation validation execute every active check of this workspace (do not ` +
  `substitute, re-bind, add or omit checks). Use EXACTLY this claims array: ${JSON.stringify(claims)}. ` +
  `The assertion fixtures already exist. Retain this claim through every stage: do not withdraw, ` +
  `reclassify, replace or weaken it. Complete the full independent plan review.`;

/** Copy the fixture, the Maven wrapper and install FlowGuard into a fresh repo. */
export function prepareWorkspace(workspace, tarball) {
  fs.cpSync(FIXTURE, workspace, {
    recursive: true,
    filter: (source) =>
      !source.includes(`${path.sep}.git`) &&
      !source.endsWith('run-live-risk-trigger-controls.mjs') &&
      !source.endsWith('run-live-replan-recovery.mjs'),
  });
  for (const item of ['mvnw', 'mvnw.cmd', '.mvn', '.gitignore']) {
    fs.cpSync(path.join(SEED, item), path.join(workspace, item), { recursive: true });
  }
  fs.chmodSync(path.join(workspace, 'mvnw'), 0o755);
  execFileSync('git', ['init', '-q'], { cwd: workspace });
  execFileSync('git', ['add', '-A'], { cwd: workspace });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Control',
      '-c',
      'user.email=control@example.invalid',
      'commit',
      '-q',
      '-m',
      'seed: state invariant fixture',
    ],
    { cwd: workspace },
  );
  execFileSync(
    process.execPath,
    [
      path.join(REPO, 'dist/cli/install.js'),
      'install',
      '--install-scope',
      'repo',
      '--core-tarball',
      tarball,
    ],
    { cwd: workspace, stdio: 'inherit' },
  );
  return workspace;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const pins = readPins();
  console.log(`Pins: opencode ${pins.opencode}, node ${pins.node}`);
  assertToolchain(pins);
  if (options.check) {
    console.log('Toolchain check passed. No live run performed.');
    return;
  }
  if (process.argv.includes('--flows')) {
    throw new Error('risk-trigger controls always execute both cases; --flows is not supported');
  }
  const evidenceDir = path.join(options.root, 'evidence');
  const configDir = path.join(options.root, 'config');
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });

  const checkoutHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPO,
    encoding: 'utf8',
  }).trim();
  let tarball;
  let builtFromCheckout;
  if (options.tarball) {
    tarball = path.resolve(options.tarball);
    verifyChecksumSidecar(tarball, path.join(path.dirname(tarball), 'checksums.sha256'));
    builtFromCheckout = false;
  } else {
    execFileSync('npm', ['run', 'build'], { cwd: REPO, stdio: 'inherit' });
    execFileSync('npm', ['run', 'pack:checksums'], { cwd: REPO, stdio: 'inherit' });
    const version = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
    tarball = path.join(REPO, `flowguard-core-${version}.tgz`);
    verifyChecksumSidecar(tarball, path.join(REPO, 'checksums.sha256'));
    builtFromCheckout = true;
  }
  fs.writeFileSync(
    path.join(evidenceDir, 'metadata.json'),
    JSON.stringify(
      {
        startedAt: new Date().toISOString(),
        model: options.model,
        pins,
        checkoutHead,
        tarball,
        tarballSha256: sha256(tarball),
        tarballBuiltFromCheckout: builtFromCheckout,
        flows: ['risk-uncovered', 'risk-covered'],
        invariant: INVARIANT,
        assertions: { positive: POSITIVE_ASSERTION, adversarial: ADVERSARIAL_ASSERTION },
      },
      null,
      2,
    ),
  );

  const cases = [
    {
      name: 'risk-uncovered',
      covered: false,
      workspace: path.join(options.root, 'workspaces', 'risk-uncovered'),
    },
    {
      name: 'risk-covered',
      covered: true,
      workspace: path.join(options.root, 'workspaces', 'risk-covered'),
    },
  ];
  for (const item of cases) prepareWorkspace(item.workspace, tarball);

  const runner = new Runner(options.root, options, configDir);
  const records = [];
  for (const item of cases) {
    runner.log(`START ${item.name}`);
    const record = await runCase(runner, item.name, item.workspace, item.covered, {
      checkoutHead,
      builtFromCheckout,
    });
    records.push(record);
    runner.log(`${record.result} ${item.name}${record.error ? `: ${record.error}` : ''}`);
    fs.writeFileSync(
      path.join(evidenceDir, 'risk-trigger-controls.json'),
      JSON.stringify(records, null, 2),
    );
  }
  const passed = records.filter((r) => r.result === 'PASS').length;
  runner.log(`RISK TRIGGER CONTROLS: ${passed}/${records.length} PASS`);
  process.exitCode = passed === records.length ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(String(error));
    process.exitCode = 1;
  });
}

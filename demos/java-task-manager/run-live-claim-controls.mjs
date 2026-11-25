#!/usr/bin/env node
/**
 * @module run-live-claim-controls
 * @description Real-host controls for certificate-authorized critical claims.
 *
 * Two cases run on the same code path; only the adversarial check's own
 * falsifiable assertion differs:
 *
 *  - claim-positive: the retained critical claim reaches PROVEN with independent
 *    positive (`test`) and adversarial (`build`) executions and passes the
 *    ordinary evidence approval.
 *  - claim-negative: both overall checks stay green, but the adversarial
 *    assertion is genuinely skipped, so the claim is not PROVEN and the real
 *    approval gate denies with PROOFGRAPH_CRITICAL_FACTS_UNPROVEN.
 *
 * Nothing is simulated: the fixtures are committed before governance starts, the
 * skip is a JUnit annotation driven by an environment variable on the host
 * process, and Maven still executes and reports honestly. No claim withdrawal,
 * no non-critical replacement, no override, no state edit.
 *
 * Usage:
 *   FLOWGUARD_CLAIM_CASES=claim-positive node demos/java-task-manager/run-live-claim-controls.mjs --root <dir> [--tarball <tgz>]
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  Runner,
  enableRawArchiveInRepoConfig,
  finalizeControlRecord,
  parseArgs,
  sha256,
  verifyChecksumSidecar,
} from './run-live-matrix.mjs';
import { assertNoCompletionPackage, assertProofEvidence } from '../lib/control-oracles.mjs';
import { buildPlanCandidate, planCandidatePrompt } from './live-claim-plan-candidate.mjs';
import {
  PLAN_GATE,
  convergePlanGate,
  planGateNotConvergedReason,
} from '../lib/review-continuation.mjs';
import { DemoNotVerifiedError, RESULT, exitCodeForResults, resultLine } from '../lib/results.mjs';
import { isolatedInstallEnv, writeIsolatedHostConfig } from '../lib/host-config.mjs';
import { HARNESS_VERSION } from '../lib/harness-version.mjs';
import { SKIP_ASSERTION_ENV } from '../lib/service-lifecycle.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { readPins, assertToolchain } from '../lib/toolchain.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SCRIPT_DIR, '..', '..');

/** The JUnit identity the adversarial role is bound to. */
export const ADVERSARIAL_ASSERTION =
  'com.example.taskmanager.UsageNotesFalsificationProbeTest#noConflictingCommandIsDocumented';
/** The positive JUnit identity, used by the `test` check. */
export const POSITIVE_ASSERTION = 'com.example.taskmanager.UsageNotesHintTest#documentsTestCommand';
/** Exact documentation line both assertions act on. */
export const REQUIRED_HINT = 'Run ./mvnw test to run the task-manager tests.';
/** Repository-grounded start command for the ticket's Getting started section. */
export const REQUIRED_START_COMMAND = './mvnw spring-boot:run';
export { SKIP_ASSERTION_ENV };
export const TICKET_FILE = 'TICKET_CLAIM_CONTROL.md';

/** The one retained critical claim; ids/certificates/evidence stay runtime-owned. */
export function criticalClaimDeclaration() {
  return {
    statement: `docs/usage-notes.md documents the task-manager test command: ${REQUIRED_HINT}`,
    critical: true,
    authoritySectionId: 'Verification',
    claimScope: 'specific_behavior',
    expectedCheckId: 'test',
    counterexampleRequirement: {
      kind: 'assertion',
      checkId: 'build',
      assertion: { providerId: 'junit', localId: ADVERSARIAL_ASSERTION },
    },
  };
}

const HINT_TEST = `package com.example.taskmanager;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Positive assertion for the retained claim: the documented command is present. */
class UsageNotesHintTest {
    @Test
    void documentsTestCommand() throws Exception {
        Path notes = Path.of("docs", "usage-notes.md");
        assertTrue(Files.exists(notes), "usage notes must exist");
        assertTrue(Files.readString(notes).contains("${REQUIRED_HINT}"),
            "usage notes must document the test command");
    }
}
`;

const FALSIFICATION_TEST = `package com.example.taskmanager;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledIfEnvironmentVariable;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Adversarial falsification probe for the claim. It does not repeat the positive
 * assertion: it additionally requires that the documented command is not one that
 * silently skips the suite. When this passes, the attempted falsification did not
 * hold. The environment variable is a deliberate control hook for the negative
 * case and is never set for the positive run.
 */
class UsageNotesFalsificationProbeTest {
    @Test
    @DisabledIfEnvironmentVariable(named = "${SKIP_ASSERTION_ENV}", matches = "1")
    void noConflictingCommandIsDocumented() throws Exception {
        Path notes = Path.of("docs", "usage-notes.md");
        assertTrue(Files.exists(notes), "usage notes must exist");
        String text = Files.readString(notes);
        assertTrue(text.contains("${REQUIRED_HINT}"), "falsifier: the documented command is absent");
        assertFalse(text.contains("-DskipTests"), "falsifier: the documented command skips the suite");
    }
}
`;

const BASELINE_NOTES = `# Usage Notes

## Running the tests

Run the task-manager tests from the project root:

    ${REQUIRED_HINT}

## More information

The full guide is under construction.
`;

/**
 * Install both fixtures and the documentation ticket BEFORE any governed session
 * starts, so they are part of the frozen base rather than the implementation.
 */
export function prepareClaimWorkspace(workspace) {
  const testDir = path.join(workspace, 'src/test/java/com/example/taskmanager');
  fs.mkdirSync(testDir, { recursive: true });
  fs.writeFileSync(path.join(testDir, 'UsageNotesHintTest.java'), HINT_TEST);
  fs.writeFileSync(path.join(testDir, 'UsageNotesFalsificationProbeTest.java'), FALSIFICATION_TEST);
  fs.mkdirSync(path.join(workspace, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'docs/usage-notes.md'), BASELINE_NOTES);
  // The seed ships an unrelated docs ticket that targets the same file with
  // incompatible content; remove it so the frozen subject has exactly one ticket.
  fs.rmSync(path.join(workspace, 'TICKET_DOCS.md'), { force: true });
  fs.writeFileSync(
    path.join(workspace, TICKET_FILE),
    `# Documentation claim control\n\n` +
      `Extend \`docs/usage-notes.md\` with a short \`## Getting started\` section describing how\n` +
      `to start the application. Keep the existing documented test command unchanged:\n\n    ${REQUIRED_HINT}\n\n` +
      `Only \`docs/usage-notes.md\` may change during implementation. The pre-existing\n` +
      `\`UsageNotesHintTest\` and \`UsageNotesFalsificationProbeTest\` verify the documented\n` +
      `command through real Maven/Surefire execution; do not modify Java tests, the Maven\n` +
      `build, the active checks, assertion reports or the retained plan claim.\n`,
  );
  const configFile = path.join(workspace, '.opencode/flowguard.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  config.policy = config.policy ?? {};
  config.policy.allowReducedCeremony = true;
  fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  enableRawArchiveInRepoConfig(workspace);
  execFileSync('git', ['add', '--all'], { cwd: workspace });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Control',
      '-c',
      'user.email=control@example.invalid',
      'commit',
      '-m',
      'test: add the live claim-control fixtures',
    ],
    { cwd: workspace, stdio: 'inherit' },
  );
}

/**
 * The ticket-adoption turn must settle at exactly TICKET with the repository
 * ticket and no plan. Planning is a separate supported command.
 */
export function assertPostTaskAdoption(state, expected) {
  if (state?.phase !== 'TICKET') {
    throw new DemoNotVerifiedError(
      `task adoption ended in ${String(state?.phase)}; expected TICKET before planning`,
    );
  }
  const ticket = state.ticket;
  if (ticket?.digest !== expected.digest || ticket?.text !== expected.text) {
    throw new DemoNotVerifiedError('task adoption did not persist the exact repository ticket');
  }
  if (ticket?.source !== 'user') {
    throw new DemoNotVerifiedError('task adoption did not bind the repository ticket source');
  }
  if (ticket?.inputOrigin !== 'workspace') {
    throw new DemoNotVerifiedError('task adoption did not record the workspace input origin');
  }
  if (
    !Array.isArray(ticket.references) ||
    !ticket.references.some(
      (reference) => reference?.ref === TICKET_FILE && reference?.type === 'doc',
    )
  ) {
    throw new DemoNotVerifiedError(
      `task adoption does not reference the repository ticket ${TICKET_FILE}`,
    );
  }
  if (state.plan !== null && state.plan !== undefined) {
    throw new DemoNotVerifiedError(
      'task adoption created a plan; planning must be a separate turn',
    );
  }
  return ticket;
}

/** Read-only check of the ticket deliverable; never a FlowGuard check or claim. */
export function assertGettingStartedSection(workspace) {
  const file = path.join(workspace, 'docs/usage-notes.md');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new DemoNotVerifiedError('delivered usage notes are missing');
  }
  const lines = text.split('\n');
  const headingLines = lines
    .map((line, index) => (line.trim() === '## Getting started' ? index : -1))
    .filter((index) => index >= 0);
  const runningLines = lines
    .map((line, index) => (line.trim() === '## Running the tests' ? index : -1))
    .filter((index) => index >= 0);
  const gettingStarted =
    headingLines.length === 1 && runningLines.length === 1
      ? lines.slice(headingLines[0] + 1, runningLines[0]).join('\n')
      : '';
  if (
    headingLines.length !== 1 ||
    runningLines.length !== 1 ||
    headingLines[0] >= runningLines[0] ||
    !gettingStarted.includes(REQUIRED_START_COMMAND) ||
    !text.includes(REQUIRED_HINT) ||
    text.includes('-DskipTests')
  ) {
    throw new DemoNotVerifiedError(
      'delivered usage notes do not contain the required Getting started section',
    );
  }
  return { headingLine: headingLines[0], runningTestsLine: runningLines[0] };
}

/** Reject withdrawal, weakening, reclassification or replacement of the claim. */
export function assertRetainedCriticalClaim(state) {
  const expected = criticalClaimDeclaration();
  const claims = state.plan?.claimDeclarations?.claims;
  if (!Array.isArray(claims) || claims.length !== 1) {
    throw new Error('exactly one retained critical plan claim is required');
  }
  const claim = claims[0];
  const requirement = claim.counterexampleRequirement;
  if (
    claim.statement !== expected.statement ||
    claim.critical !== true ||
    claim.claimScope !== 'specific_behavior' ||
    claim.expectedCheckId !== 'test' ||
    claim.authoritySectionId !== expected.authoritySectionId ||
    requirement?.kind !== 'assertion' ||
    requirement.checkId !== 'build' ||
    requirement.assertion?.providerId !== 'junit' ||
    requirement.assertion.localId !== ADVERSARIAL_ASSERTION
  ) {
    throw new Error('the supplied critical assertion-bound claim was changed or weakened');
  }
  return claim.claimId;
}

/**
 * Case oracle. Positive: the adversarial assertion passed and the claim is PROVEN.
 * Negative: the adversarial assertion was genuinely skipped while both checks are
 * green and the claim is not PROVEN. Both require the certificate-bound fact and
 * delegate to the shared proof-evidence contract.
 */
export function assertClaimEvidence(state, { negative }) {
  const claimId = assertRetainedCriticalClaim(state);
  const proof = assertProofEvidence(state, {
    claimId,
    positiveAssertion: { providerId: 'junit', localId: POSITIVE_ASSERTION },
    adversarialAssertion: { providerId: 'junit', localId: ADVERSARIAL_ASSERTION },
    mode: negative ? 'negative' : 'positive',
  });
  return {
    ...proof,
    verificationState: state.proofGraph?.claims?.find((claim) => claim.claimId === claimId)
      ?.verificationState,
    adversarialStatus: negative ? 'skipped' : 'passed',
  };
}

export async function runCase(runner, name, workspace, negative) {
  const record = { name, negative, workspace, result: RESULT.FAILED };
  const session = { workspace, terminal: 'COMPLETE' };
  try {
    await runner.turn(session, `${name}-01-start`, undefined, { command: 'start' });
    const installed = runner.installedBuild(workspace);
    record.installedBuild = installed;
    if (runner.options.productSha !== undefined && installed.gitSha !== runner.options.productSha) {
      throw new Error(
        `installed artifact gitSha ${String(installed.gitSha)} != declared product ${runner.options.productSha}`,
      );
    }
    // Submit the ticket source through the /task prompt template. Adoption and
    // planning are deliberately separate supported commands: /task must settle
    // at TICKET with the exact repository ticket and no plan.
    const ticketPath = path.join(workspace, TICKET_FILE);
    const expectedTicket = {
      digest: sha256(ticketPath),
      text: fs.readFileSync(ticketPath, 'utf8'),
    };
    await runner.turn(
      session,
      `${name}-02-task`,
      `--file ${TICKET_FILE} Adopt only this repository ticket and stop after ticket capture; ` +
        'do not create, review or implement a plan.',
      { command: 'task' },
    );
    const afterTaskState = runner.requireBoundState(session).state;
    assertPostTaskAdoption(afterTaskState, expectedTicket);
    const candidates = afterTaskState.verificationCandidates ?? [];
    const buildCandidate = candidates.find((candidate) => candidate.kind === 'build');
    const testCandidate = candidates.find((candidate) => candidate.kind === 'test');
    if (!buildCandidate || !testCandidate) {
      throw new DemoNotVerifiedError(
        'claim control has no canonical build/test verification candidates',
      );
    }
    const claim = criticalClaimDeclaration();
    const planText = buildPlanCandidate({
      ticketFile: TICKET_FILE,
      claim,
      positiveAssertion: POSITIVE_ASSERTION,
      buildCandidateId: buildCandidate.candidateId,
      testCandidateId: testCandidate.candidateId,
    });
    await runner.turn(session, `${name}-03-plan`, planCandidatePrompt(planText, [claim]), {
      command: 'plan',
    });
    const gate = await convergePlanGate({ runner, session, label: `${name}-03-plan` });
    if (gate.outcome !== PLAN_GATE.ACCEPTED) {
      const reason = planGateNotConvergedReason(gate.outcome);
      throw new DemoNotVerifiedError(`${name}: ${reason}; the control proof is NOT_VERIFIED`);
    }
    assertRetainedCriticalClaim(runner.requireBoundState(session).state);
    await runner.approve(session, `${name}-04-approve-plan`, 'PLAN_REVIEW');
    assertRetainedCriticalClaim(runner.requireBoundState(session).state);

    await runner.turn(
      session,
      `${name}-05-implement`,
      'Implement only docs/usage-notes.md as the ticket describes: add the ## Getting started ' +
        'section and keep the documented test command unchanged. Run every required check. Do not modify the ' +
        'test fixtures, the build, the active checks, assertion reports or the retained claim. Stop at the ' +
        'human evidence gate; do not approve, override or export. Report any missing scoped evidence honestly.',
      { command: 'implement' },
    );
    record.gettingStartedCheck = assertGettingStartedSection(workspace);
    const evidence = assertClaimEvidence(runner.requireBoundState(session).state, { negative });

    if (negative) {
      const before = runner.requireBoundState(session).state;
      await runner.turn(session, `${name}-06-approve`, undefined, {
        command: 'approve',
        expectedDenial: 'PROOFGRAPH_CRITICAL_FACTS_UNPROVEN',
        expectedDenialTool: 'flowguard_decision',
      });
      const after = runner.requireBoundState(session).state;
      assertClaimEvidence(after, { negative: true });
      if (after.phase !== 'EVIDENCE_REVIEW') {
        throw new Error(`the blocked approval left EVIDENCE_REVIEW: ${String(after.phase)}`);
      }
      if (
        JSON.stringify(after.reviewDecision ?? null) !==
        JSON.stringify(before.reviewDecision ?? null)
      ) {
        throw new Error('the blocked approval changed the persisted review decision');
      }
      const absence = assertNoCompletionPackage(runner, session);
      Object.assign(record, evidence, {
        expectedOutcome: 'blocked_at_evidence_gate',
        denial: 'PROOFGRAPH_CRITICAL_FACTS_UNPROVEN',
        phase: after.phase,
        packages: [],
        archiveDirContents: absence.produced,
      });
    } else {
      await runner.approve(session, `${name}-06-approve`, 'EVIDENCE_REVIEW');
      await runner.turn(session, `${name}-07-export`, undefined, { command: 'export' });
      const final = runner.requireBoundState(session).state;
      if (final.phase !== 'COMPLETE') throw new Error(`expected COMPLETE, observed ${final.phase}`);
      assertRetainedCriticalClaim(final);
      Object.assign(record, evidence, {
        expectedOutcome: 'completed',
        phase: final.phase,
        packages: [runner.verifyPackage(session, 'export', 'development', 'EXPORT_READY', name)],
      });
    }
    // Evidence kinds are assigned only after the parent and every required
    // reviewer transcript were exported and validated; a capture failure keeps
    // the record FAILED.
    await finalizeControlRecord(
      record,
      session,
      runner,
      {},
      negative ? RESULT.CONTROL_PASSED : RESULT.COMPLETE,
    );
  } catch (error) {
    if (error instanceof DemoNotVerifiedError || error?.code === 'DEMO_NOT_VERIFIED') {
      record.result = RESULT.NOT_VERIFIED;
      record.error = String(error);
    } else {
      record.result = RESULT.FAILED;
      record.error = String(error);
      if (error?.code === 'HOST_COMMAND_UNKNOWN_OUTCOME') record.errorCode = error.code;
    }
  }
  return record;
}

export function selectedClaimCases() {
  const raw = process.env.FLOWGUARD_CLAIM_CASES;
  if (raw === undefined || raw.trim() === '') {
    throw new Error(
      'FLOWGUARD_CLAIM_CASES must explicitly select exactly one claim control per invocation',
    );
  }
  const value = raw.trim();
  if (value !== 'claim-positive' && value !== 'claim-negative') {
    throw new Error(
      'FLOWGUARD_CLAIM_CASES must select exactly one of claim-positive or claim-negative',
    );
  }
  return [value];
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
    throw new Error(
      'claim controls require FLOWGUARD_CLAIM_CASES to select one case; --flows is not supported',
    );
  }
  const selected = selectedClaimCases();
  const [name] = selected;
  const negative = name === 'claim-negative';
  const evidenceDir = path.join(options.root, 'evidence');
  const configDir = path.join(options.root, 'config');
  fs.mkdirSync(options.root, { recursive: true });
  fs.mkdirSync(evidenceDir, { mode: 0o700 });
  fs.mkdirSync(configDir, { recursive: true });
  writeIsolatedHostConfig(configDir);

  const checkoutHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPO,
    encoding: 'utf8',
  }).trim();
  const tarball = options.tarball
    ? path.resolve(options.tarball)
    : (() => {
        execFileSync('npm', ['run', 'build'], { cwd: REPO, stdio: 'inherit' });
        execFileSync('npm', ['run', 'pack:checksums'], { cwd: REPO, stdio: 'inherit' });
        const version = JSON.parse(
          fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'),
        ).version;
        return path.join(REPO, `flowguard-core-${version}.tgz`);
      })();
  verifyChecksumSidecar(tarball, path.join(path.dirname(tarball), 'checksums.sha256'));
  fs.writeFileSync(
    path.join(evidenceDir, 'metadata.json'),
    JSON.stringify(
      {
        startedAt: new Date().toISOString(),
        model: options.model,
        harnessVersion: HARNESS_VERSION,
        pins,
        checkoutHead,
        tarball,
        tarballSha256: sha256(tarball),
        productSha: options.productSha ?? null,
        flows: selected,
        claim: criticalClaimDeclaration(),
        positiveAssertion: POSITIVE_ASSERTION,
        adversarialAssertion: ADVERSARIAL_ASSERTION,
        skipEnvironment: SKIP_ASSERTION_ENV,
      },
      null,
      2,
    ),
    { flag: 'wx' },
  );

  execFileSync(
    path.join(REPO, 'run-demo-setup.sh'),
    [
      '--install',
      '--install-scope',
      'repo',
      '--tarball',
      tarball,
      '--demo',
      'main',
      path.join(options.root, 'workspaces'),
    ],
    {
      cwd: REPO,
      stdio: 'inherit',
      env: isolatedInstallEnv(configDir),
    },
  );
  const workspace = path.join(options.root, 'workspaces', name);
  fs.cpSync(path.join(options.root, 'workspaces', 'java-task-manager'), workspace, {
    recursive: true,
  });
  prepareClaimWorkspace(workspace);

  const runner = new Runner(options.root, options, configDir);
  runner.log(`START ${name}`);
  const record = await runner.withHost(() => runCase(runner, name, workspace, negative), {
    skipAssertion: negative,
  });
  const records = [record];
  runner.log(`${record.result} ${name}${record.error ? `: ${record.error}` : ''}`);
  fs.writeFileSync(
    path.join(evidenceDir, 'claim-controls.json'),
    JSON.stringify(records, null, 2),
    { flag: 'wx' },
  );
  const code = exitCodeForResults(records);
  runner.log(resultLine(records, 'CLAIM CONTROLS'));
  process.exitCode = code;
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(String(error));
    process.exitCode = 1;
  });
}

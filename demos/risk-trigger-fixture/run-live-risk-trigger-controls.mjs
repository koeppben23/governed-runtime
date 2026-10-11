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
import { Runner, parseArgs, readPins } from '../java-task-manager/run-live-matrix.mjs';

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
  const claims = state.plan?.claimDeclarations?.claims;
  if (!Array.isArray(claims) || claims.length !== 1) {
    throw new Error('exactly one retained critical plan claim is required');
  }
  const claim = claims[0];
  const requirement = claim.counterexampleRequirement;
  if (
    claim.critical !== true ||
    claim.claimScope !== 'specific_behavior' ||
    claim.expectedCheckId !== 'test' ||
    requirement?.kind !== 'assertion' ||
    requirement.checkId !== 'build' ||
    requirement.assertion?.localId !== ADVERSARIAL_ASSERTION
  ) {
    throw new Error('the retained critical claim was changed or weakened');
  }
  const declared = claim.coversRiskTriggers ?? [];
  if (covered && !declared.includes('state_integrity')) {
    throw new Error('the approved claim set does not cover state_integrity');
  }
  if (!covered && declared.includes('state_integrity')) {
    throw new Error('the uncovered case must not declare coverage');
  }
  return claim.claimId;
}

async function runCase(runner, name, workspace, covered) {
  const record = { name, covered, workspace, result: 'FAILED' };
  const session = { workspace, terminal: 'COMPLETE' };
  const savedSkip = process.env[SKIP_ASSERTION_ENV];
  try {
    await runner.turn(session, `${name}-01-start`, '/start');
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
    assertRetainedClaim(state, covered);
    const assessment = assertStateIntegrityTrigger(state);
    if (state.phase !== 'EVIDENCE_REVIEW') {
      throw new Error(`expected EVIDENCE_REVIEW, observed ${state.phase}`);
    }

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
      Object.assign(record, {
        expectedOutcome: 'blocked_at_evidence_gate',
        denial: 'PROOFGRAPH_RISK_TRIGGER_UNCOVERED',
        riskTriggers: assessment.riskTriggers,
        phase: after.phase,
        packages: [],
        result: 'PASS',
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
        claimId: claimId.slice(0, 8),
        riskTriggers: assessment.riskTriggers,
        verificationState: projected.verificationState,
        phase: final.phase,
        packages: [runner.verifyPackage(session, 'export', 'development', 'EXPORT_READY', name)],
        result: 'PASS',
      });
    }
    record.hostSessionId = session.sessionId;
    await runner.captureProvenance(record, session);
  } catch (error) {
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
      !source.includes(`${path.sep}.git`) && !source.endsWith('run-live-risk-trigger-controls.mjs'),
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
  fs.writeFileSync(
    path.join(evidenceDir, 'metadata.json'),
    JSON.stringify(
      {
        startedAt: new Date().toISOString(),
        model: options.model,
        pins,
        checkoutHead,
        tarball,
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
    const record = await runCase(runner, item.name, item.workspace, item.covered);
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

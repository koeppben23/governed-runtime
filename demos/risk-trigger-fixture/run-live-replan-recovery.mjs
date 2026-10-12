#!/usr/bin/env node
/**
 * Real OpenCode two-session recovery (#1079). No state injection, simulated
 * reviewer evidence or automatic session reset. Every turn is a real host
 * command; the runner records an explicit operator abort and governed reapply.
 * Usage: node demos/risk-trigger-fixture/run-live-replan-recovery.mjs --root <fresh-dir>
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  Runner,
  assertToolchain,
  parseArgs,
  readPins,
  sha256,
  verifyChecksumSidecar,
} from '../java-task-manager/run-live-matrix.mjs';
import {
  prepareWorkspace,
  claimDeclaration,
  assertFullEvidence,
  assertStateIntegrityTrigger,
  assertInstalledBuildIdentity,
  assertNoCompletionPackage,
} from './run-live-risk-trigger-controls.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const SUBJECT = 'src/state/module-state.md';

function git(workspace, ...args) {
  return execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
}

function snapshot(runner, session, label) {
  const current = runner.requireBoundState(session);
  const file = path.join(runner.evidenceDir, `${label}-state.json`);
  if (fs.existsSync(file)) throw new Error(`evidence already exists: ${file}`);
  fs.writeFileSync(file, JSON.stringify(current.state, null, 2));
  return { ...current, file, sha256: sha256(file) };
}

async function planAndApprove(runner, session, prefix, covered) {
  await runner.turn(session, `${prefix}-01-start`, undefined, { command: 'start' });
  await runner.turn(
    session,
    `${prefix}-02-ticket`,
    fs.readFileSync(path.join(session.workspace, 'TICKET.md'), 'utf8'),
    { command: 'task' },
  );
  await runner.turn(
    session,
    `${prefix}-03-plan`,
    `Plan only the ticket. Declare exactly ${JSON.stringify([claimDeclaration(covered)])}. ` +
      'This is a controlled coverage-recovery probe; retain the declaration without withdrawal, weakening or post-approval edits. ' +
      'Execute every active check for baseline and implementation and complete independent review.',
    { command: 'plan' },
  );
  await runner.approve(session, `${prefix}-04-approve-plan`, 'PLAN_REVIEW');
}

export function assertRecoveryIdentities(oldState, newState) {
  if (oldState.phase !== 'ABORTED') throw new Error('old session must be terminal ABORTED');
  if (newState.phase !== 'READY') throw new Error('new session must start at READY');
  if (oldState.binding.hostSessionId === newState.binding.hostSessionId)
    throw new Error('host binding was reused');
  if (oldState.flowguardSessionId === newState.flowguardSessionId)
    throw new Error('FlowGuard identity was reused');
  if (
    newState.implementationBaseline.dirtyFiles === null ||
    newState.implementationBaseline.controlPlaneMarker === null
  ) {
    throw new Error('new implementation baseline is unavailable');
  }
  if (newState.implementationBaseline.dirtyFiles?.some((file) => file.path === SUBJECT)) {
    throw new Error('old implementation bytes were imported before the new baseline');
  }
  if (newState.validationAttempts.length !== 0 || newState.proofGraph.claims.length !== 0) {
    throw new Error('old attempts or projections were carried into the new session');
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  assertToolchain(readPins());
  if (options.check) return;
  const evidenceDir = path.join(options.root, 'evidence');
  if (fs.existsSync(evidenceDir))
    throw new Error('use a fresh --root; recovery evidence is never overwritten');
  fs.mkdirSync(evidenceDir, { recursive: true });
  const configDir = path.join(options.root, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  const checkoutHead = git(REPO, 'rev-parse', 'HEAD');
  let tarball = options.tarball && path.resolve(options.tarball);
  if (!tarball) {
    execFileSync('npm', ['run', 'build'], { cwd: REPO, stdio: 'inherit' });
    execFileSync('npm', ['run', 'pack:checksums'], { cwd: REPO, stdio: 'inherit' });
    const version = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
    tarball = path.join(REPO, `flowguard-core-${version}.tgz`);
  }
  verifyChecksumSidecar(tarball, path.join(path.dirname(tarball), 'checksums.sha256'));
  const runner = new Runner(options.root, options, configDir);
  const record = {
    name: 'replan-recovery',
    checkoutHead,
    tarballSha256: sha256(tarball),
    result: 'FAILED',
    snapshots: {},
  };
  try {
    const oldWorkspace = path.join(options.root, 'workspaces', 'old');
    prepareWorkspace(oldWorkspace, tarball);
    const base = git(oldWorkspace, 'rev-parse', 'HEAD');
    const original = fs.readFileSync(path.join(oldWorkspace, SUBJECT), 'utf8');
    const oldSession = { workspace: oldWorkspace, terminal: 'ABORTED' };
    await planAndApprove(runner, oldSession, 'old', false);
    assertInstalledBuildIdentity(
      runner.installedBuild(oldWorkspace),
      checkoutHead,
      !options.tarball,
    );
    await runner.turn(
      oldSession,
      'old-05-implement',
      'Add the ticket change log only in src/state/module-state.md; preserve its invariant. ' +
        'Complete governed mutation, recording, every active check and independent review. Stop at EVIDENCE_REVIEW.',
      { command: 'implement' },
    );
    const deniedBasis = runner.requireBoundState(oldSession).state;
    assertStateIntegrityTrigger(deniedBasis);
    assertFullEvidence(deniedBasis, false);
    await runner.turn(oldSession, 'old-06-denial', 'Explicit operator approval probe.', {
      command: 'approve',
      expectedDenial: 'PROOFGRAPH_RISK_TRIGGER_UNCOVERED',
    });
    assertNoCompletionPackage(runner, oldSession);
    const repaired = fs.readFileSync(path.join(oldWorkspace, SUBJECT), 'utf8');
    record.snapshots.denied = snapshot(runner, oldSession, 'denied').sha256;
    await runner.turn(
      oldSession,
      'old-07-abort',
      'Explicit operator instruction: abort this session for new-session authority recovery; preserve its evidence.',
      { command: 'abort' },
    );
    const aborted = snapshot(runner, oldSession, 'aborted');
    const oldAuditFile = path.join(aborted.sessionDir, 'audit.jsonl');
    const oldAudit = fs
      .readFileSync(oldAuditFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    if (!oldAudit.some((event) => event.event === 'transition:ABORT'))
      throw new Error('old abort has no durable audit transition');
    fs.copyFileSync(oldAuditFile, path.join(evidenceDir, 'old-aborted-audit.jsonl'));
    record.oldAuditSha256 = sha256(oldAuditFile);
    if (JSON.stringify(aborted.state.plan) !== JSON.stringify(deniedBasis.plan))
      throw new Error('abort changed old plan authority');
    const oldDigest = runner.currentStateDigest(oldSession);
    await runner.turn(oldSession, 'old-08-hydrate-readonly', undefined, { command: 'hydrate' });
    if (runner.currentStateDigest(oldSession) !== oldDigest)
      throw new Error('terminal hydrate changed old state');

    const newWorkspace = path.join(options.root, 'workspaces', 'new');
    git(oldWorkspace, 'worktree', 'add', '--detach', newWorkspace, base);
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
      { cwd: newWorkspace, stdio: 'inherit' },
    );
    if (fs.readFileSync(path.join(newWorkspace, SUBJECT), 'utf8') !== original)
      throw new Error('untrusted recovery base');
    const newSession = { workspace: newWorkspace, terminal: 'COMPLETE' };
    await runner.turn(newSession, 'new-01-start', undefined, { command: 'start' });
    const fresh = snapshot(runner, newSession, 'fresh');
    assertRecoveryIdentities(aborted.state, fresh.state);
    assertInstalledBuildIdentity(
      runner.installedBuild(newWorkspace),
      checkoutHead,
      !options.tarball,
    );
    await runner.turn(
      newSession,
      'new-02-ticket',
      fs.readFileSync(path.join(newWorkspace, 'TICKET.md'), 'utf8'),
      { command: 'task' },
    );
    await runner.turn(
      newSession,
      'new-03-plan',
      `Create the complete recovery plan using exactly ${JSON.stringify([claimDeclaration(true)])}. ` +
        'Complete independent review; do not transfer certificates, evidence or verdicts from the old session.',
      { command: 'plan' },
    );
    await runner.approve(newSession, 'new-04-approve-plan', 'PLAN_REVIEW');
    const approved = snapshot(runner, newSession, 'new-approved');
    if (
      approved.state.plan.approvalCertificate.certificateId ===
      aborted.state.plan.approvalCertificate.certificateId
    )
      throw new Error('certificate reused');
    await runner.turn(
      newSession,
      'new-05-governed-reapply',
      `In this authorized implementation step, write ONLY ${SUBJECT} with exactly this UTF-8 content: ${JSON.stringify(repaired)}. ` +
        'Use the regular governed host mutation tool, record with flowguard_implement, execute every active check and complete independent review. ' +
        'Do not git-apply outside the workflow, edit tests/reports, copy attempts or change the approved claim. Stop at EVIDENCE_REVIEW.',
      { command: 'implement' },
    );
    const current = snapshot(runner, newSession, 'new-evidence');
    assertFullEvidence(current.state, true);
    if (current.state.implementation.digest !== deniedBasis.implementation.digest)
      throw new Error('implementation bytes/scope differ');
    const oldAttempts = new Set(
      aborted.state.validationAttempts.map((attempt) => attempt.attemptId),
    );
    if (current.state.validationAttempts.some((attempt) => oldAttempts.has(attempt.attemptId)))
      throw new Error('attempt reused');
    if (
      !current.state.mutationEpisodes.some(
        (episode) =>
          episode.evidenceStatus === 'eligible' &&
          episode.implementationDigest === current.state.implementation.digest,
      )
    )
      throw new Error('reapplication has no eligible host-mutation provenance');
    await runner.approve(newSession, 'new-06-approve-evidence', 'EVIDENCE_REVIEW');
    await runner.turn(newSession, 'new-07-export', undefined, { command: 'export' });
    if (runner.requireBoundState(newSession).state.phase !== 'COMPLETE')
      throw new Error('recovery did not complete');
    record.snapshots.completed = snapshot(runner, newSession, 'completed').sha256;
    record.package = runner.verifyPackage(
      newSession,
      'export',
      'development',
      'EXPORT_READY',
      'replan-recovery',
    );
    if (runner.currentStateDigest(oldSession) !== oldDigest)
      throw new Error('old authority changed during recovery');
    const oldProvenance = { name: 'old-session' };
    const newProvenance = { name: 'new-session' };
    await runner.captureProvenance(oldProvenance, oldSession);
    await runner.captureProvenance(newProvenance, newSession);
    Object.assign(record, {
      result: 'PASS',
      base,
      oldProvenance,
      newProvenance,
      hostSessionIds: [oldSession.sessionId, newSession.sessionId],
    });
  } catch (error) {
    record.error = String(error);
  }
  fs.writeFileSync(path.join(evidenceDir, 'replan-recovery.json'), JSON.stringify(record, null, 2));
  runner.log(`${record.result} replan-recovery${record.error ? `: ${record.error}` : ''}`);
  process.exitCode = record.result === 'PASS' ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(String(error));
    process.exitCode = 1;
  });
}

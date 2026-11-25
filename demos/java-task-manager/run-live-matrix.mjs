#!/usr/bin/env node
/**
 * @module run-live-matrix
 * @description Reproducible live demo matrix runner for the Java Task Manager
 * demo. It drives the five demo flows plus the architecture negative probe
 * through headless `opencode run` and native session commands against freshly
 * installed workspaces and records verifiable evidence per flow.
 *
 * This runner contains NO governance logic and changes no product behavior:
 * - toolchain pins are READ from the canonical repository files
 *   (`.sdk-baselines/opencode/cli-candidate.json` and `.node-version`); no version is
 *   hardcoded here;
 * - every command runs with an explicit working directory and matching `PWD`; the
 *   persisted host-session and worktree binding are verified before a flow is
 *   accepted;
 * - a flow stops at the first unexpected host failure, tool-level block,
 *   missing gate, or unexpected terminal phase; it never force-advances past a
 *   gate. A transport-level block observed after the session already reached the
 *   flow's persisted terminal phase is recorded (`terminalBlocks`), not fatal:
 *   the terminal phase plus package verification stay the outcome authority;
 * - the architecture negative probe uses a controlled denial step: the exact
 *   expected reason code must be observed and nothing may be persisted before
 *   the allowed recovery continues;
 * - an implementation review the author left at IMPL_REVIEW is resumed with a
 *   BOUNDED number of canonical /implement turns; every resume must prove
 *   persisted state progress and the evidence gate must be reached within the
 *   bound, otherwise the flow stays blocked;
 * - parent and reviewer-child host transcripts are exported and hashed; the
 *   installed build identity is recorded from the installed package;
 * - evidence files are written once per step; a failed run is preserved and a
 *   rerun must use a fresh `--root`; a matrix with any incomplete flow exits
 *   non-zero;
 * - the isolated raw-export grant lives in the run-local OPENCODE_CONFIG_DIR
 *   and is removed again on exit.
 *
 * Usage:
 *   node demos/java-task-manager/run-live-matrix.mjs --root <work-root> [options]
 *
 * Options:
 *   --root <dir>       Work root for workspaces, config, and evidence (required).
 *   --model <id>       OpenCode model (default `deepseek/deepseek-flash`).
 *   --tarball <path>   Use an existing tarball (+ checksums.sha256) instead of
 *                      building and packing the current tree.
 *   --flows <list>     Comma-separated subset of the default flow set.
 *   --check            Toolchain/preflight check only; performs no live run.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DemoNotVerifiedError, RESULT, resultLine } from '../lib/results.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { HARNESS_VERSION } from '../lib/harness-version.mjs';
import { isolatedInstallEnv, writeIsolatedHostConfig } from '../lib/host-config.mjs';
import { readPins, assertToolchain } from '../lib/toolchain.mjs';
import {
  enableRawArchiveInRepoConfig,
  parseArgs,
  readContractVersion,
  REPO,
  SCRIPT_DIR,
  sha256,
  tarballFor,
  withRawExportGrant,
} from './live-matrix-setup.mjs';
import { matrixExitCode, NEGATIVE_PROBE_WORKSPACE, runFlows } from './live-matrix-scenarios.mjs';
import { Runner } from './live-runner.mjs';
import { captureFailureProvenance } from './live-session-evidence.mjs';
import { PLAN_REVIEW_CORRECTION_CODE } from './live-turn-recovery.mjs';

export { Runner } from './live-runner.mjs';
export {
  DEFAULT_FLOWS,
  enableRawArchiveInRepoConfig,
  parseArgs,
  readContractVersion,
  sha256,
  verificationFlowFor,
  verifyChecksumSidecar,
  withRawExportGrant,
} from './live-matrix-setup.mjs';
export {
  CONTROLLED_NEGATIVE_STEPS,
  NEGATIVE_PROBE_WORKSPACE,
  architectureProbeMutated,
  assertArchitectureProbePrecondition,
  matrixExitCode,
  runFlows,
} from './live-matrix-scenarios.mjs';
export {
  assertSessionBinding,
  canonicalPath,
  captureFailureProvenance,
  finalizeControlRecord,
  lastAuditSequence,
  taskChildSessionIds,
  transcriptTargets,
} from './live-session-evidence.mjs';
export {
  DENIAL_BASELINE,
  MAX_IMPLEMENT_REVIEW_RESUMES,
  NEXT_STEP_RECOVERY_CODES,
  PLAN_REVIEW_CORRECTION_CODE,
  RECOVERABLE_DENIAL_CODES,
  REVIEW_STAGE_INCOMPLETE_CODES,
  classifyRearmEvent,
  classifyUnexpectedBlock,
  hostTurnWasNoOp,
  isRecoverableFamily,
  persistedReviewExhausted,
  planCorrectionGateDecision,
  planReviewSameTurnCorrection,
  settleRearmObservation,
  unexpectedDenialCodes,
} from './live-turn-recovery.mjs';
export {
  assertExpectedDenial,
  authorizedRetryEvents,
  captureRetryCodes,
  captureRetryEvents,
  captureRetryHints,
  deniedToolForCode,
  eventsOf,
  governedToolEvents,
  parseHostPayload,
  sameTurnRecoveryProofs,
  structuredRearmSupersedesTerminal,
  toolDenialCodes,
  toolDenialEvents,
  toolDenialOccurrenceCounts,
  transcriptTrust,
} from '../lib/transcript.mjs';
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const pins = readPins();
  console.log(`Pins: opencode ${pins.opencode}, node ${pins.node}`);
  assertToolchain(pins);
  if (options.check) {
    console.log('Toolchain check passed. No live run performed.');
    return;
  }

  const evidenceDir = path.join(options.root, 'evidence');
  const configDir = path.join(options.root, 'config');
  const workspaces = path.join(options.root, 'workspaces');
  fs.mkdirSync(options.root, { recursive: true });
  fs.mkdirSync(evidenceDir, { mode: 0o700 });
  fs.mkdirSync(configDir, { recursive: true });
  writeIsolatedHostConfig(configDir);

  const checkoutHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPO,
    encoding: 'utf8',
  }).trim();
  const { tarball, sidecar, builtFromCheckout } = tarballFor(options);
  fs.writeFileSync(
    path.join(evidenceDir, 'metadata.json'),
    JSON.stringify(
      {
        startedAt: new Date().toISOString(),
        model: options.model,
        harnessVersion: HARNESS_VERSION,
        contractVersion: readContractVersion(),
        pins,
        checkoutHead,
        tarball,
        tarballBuiltFromCheckout: builtFromCheckout,
        tarballSha256: sha256(tarball),
        sidecarSha256: sha256(sidecar),
        flows: options.flows,
      },
      null,
      2,
    ),
    { flag: 'wx' },
  );

  execFileSync(
    path.join(REPO, 'run-demo-setup.sh'),
    ['--install', '--install-scope', 'repo', '--tarball', tarball, workspaces],
    {
      cwd: REPO,
      stdio: 'inherit',
      env: isolatedInstallEnv(configDir),
    },
  );
  // The installer writes allowRawExport=false into the repo config, which
  // restricts the effective policy; the documented raw-auditor flow needs the
  // repo opt-in as well as the isolated global grant.
  enableRawArchiveInRepoConfig(path.join(workspaces, 'java-task-manager'));
  // Copy the pristine seed for the negative probe before any flow mutates the
  // main workspace.
  if (options.flows.includes('architecture-negative')) {
    fs.cpSync(
      path.join(workspaces, 'java-task-manager'),
      path.join(workspaces, NEGATIVE_PROBE_WORKSPACE),
      { recursive: true },
    );
  }

  const runner = new Runner(options.root, options, configDir);
  const runMatrix = async () => {
    const flows = await runFlows(runner);
    for (const name of options.flows) {
      const flow = flows[name];
      const record = { name, workspace: flow.workspace, result: RESULT.FAILED };
      runner.flows.push(record);
      runner.log(`START ${name}`);
      const session = { workspace: flow.workspace, terminal: flow.terminal };
      try {
        await runner.turn(session, `${name}-01-start`, undefined, { command: 'start' });
        const installed = runner.installedBuild(flow.workspace);
        record.installedBuild = installed;
        if (options.productSha !== undefined && installed.gitSha !== options.productSha) {
          throw new Error(
            `installed artifact gitSha ${String(installed.gitSha)} != declared product ${options.productSha}`,
          );
        }
        if (builtFromCheckout && installed.gitSha !== checkoutHead) {
          throw new Error(
            `installed artifact gitSha ${String(installed.gitSha)} != checkout ${checkoutHead}`,
          );
        }
        if (flow.preflight) {
          execFileSync(
            path.join(SCRIPT_DIR, 'run-reduced-ceremony-demo-setup.sh'),
            flow.preflight,
            {
              cwd: REPO,
              stdio: 'inherit',
              env: { ...isolatedInstallEnv(configDir), OPENCODE_CONFIG_DIR: configDir },
            },
          );
        }
        await flow.run(session);
        if (session.awaitingRecovery) {
          throw new Error(
            `pending recovery [${session.awaitingRecovery.codes.join(', ')}] was not demonstrated by a following step`,
          );
        }
        if (session.pendingPlanReviewCorrection) {
          throw new Error(
            `unproven ${PLAN_REVIEW_CORRECTION_CODE} correction at [${session.pendingPlanReviewCorrection.steps.join(', ')}]`,
          );
        }
        if (session.pendingReviewRecovery) {
          throw new Error(
            `unproven reviewer recovery [${session.pendingReviewRecovery.codes.join(', ')}] at [${session.pendingReviewRecovery.steps.join(', ')}]`,
          );
        }
        const snapshot = runner.requireBoundState(session);
        record.phase = snapshot.state.phase;
        record.hostSessionId = session.sessionId;
        record.flowguardSessionId = snapshot.state.flowguardSessionId;
        if (session.negativeOutcome) {
          if (!(flow.negativeOutcomes ?? []).includes(session.negativeOutcome)) {
            throw new Error(
              `unexpected negative outcome '${session.negativeOutcome}' for flow ${name}`,
            );
          }
          record.negativeOutcome = session.negativeOutcome;
          record.result = RESULT.CONTROL_PASSED;
        } else if (snapshot.state.phase !== flow.terminal) {
          throw new Error(`expected terminal ${flow.terminal}, observed ${snapshot.state.phase}`);
        } else {
          record.result = RESULT.COMPLETE;
        }
        await runner.captureProvenance(record, session);
        record.packages = session.packages ?? [];
        record.recoveredDenials = session.recoveredDenials ?? [];
        record.terminalBlocks = session.terminalBlocks ?? [];
        record.resumedSteps = session.resumedSteps ?? [];
      } catch (error) {
        if (error instanceof DemoNotVerifiedError || error?.code === 'DEMO_NOT_VERIFIED') {
          record.result = RESULT.NOT_VERIFIED;
          record.error = String(error);
          runner.log(`NOT_VERIFIED ${name}: ${error}`);
        } else {
          record.result = RESULT.FAILED;
          record.error = String(error);
          runner.log(`BLOCKED ${name}: ${error}`);
        }
        if (error?.code === 'HOST_COMMAND_UNKNOWN_OUTCOME') {
          record.errorCode = error.code;
          break;
        }
        // Evidence capture must survive the failure path: a failed or
        // discarded reviewer child is exactly what a forensic pass needs.
        await captureFailureProvenance(record, session, runner);
      }
    }
    fs.writeFileSync(path.join(evidenceDir, 'flows.json'), JSON.stringify(runner.flows, null, 2), {
      flag: 'wx',
    });
    fs.writeFileSync(
      path.join(evidenceDir, 'host-sessions.json'),
      JSON.stringify(
        runner.flows.map(
          ({ name, hostSessionId, flowguardSessionId, transcripts, packages, installedBuild }) => ({
            flow: name,
            hostSessionId: hostSessionId ?? null,
            flowguardSessionId: flowguardSessionId ?? null,
            transcripts: transcripts ?? null,
            packages: packages ?? [],
            installedBuild: installedBuild ?? null,
          }),
        ),
        null,
        2,
      ),
      { flag: 'wx' },
    );
    return matrixExitCode(runner.flows);
  };
  const exitCode = await withRawExportGrant(configDir, () => runner.withHost(runMatrix));

  runner.log('raw-export grant removed from the isolated config dir');
  runner.log(resultLine(runner.flows, 'MATRIX RESULT'));
  if (exitCode !== 0) {
    runner.log('MATRIX INCOMPLETE: at least one scenario did not produce accepted evidence');
  }
  process.exitCode = exitCode;
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(String(error));
    process.exitCode = 1;
  });
}

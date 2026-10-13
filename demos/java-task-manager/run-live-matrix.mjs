#!/usr/bin/env node
/**
 * @module run-live-matrix
 * @description Reproducible live demo matrix runner for the Java Task Manager
 * demo. It drives the five demo flows plus the architecture negative probe
 * through real headless `opencode run` processes against freshly installed
 * workspaces and records verifiable evidence per flow.
 *
 * This runner contains NO governance logic and changes no product behavior:
 * - toolchain pins are READ from the canonical repository files
 *   (`src/cli/opencode-runtime-compat.ts` and `.node-version`); no version is
 *   hardcoded here;
 * - every command runs with an explicit `--dir` and a matching `PWD`; the
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

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportHostTranscript } from './live-host-export.mjs';
import {
  assertExpectedDenial,
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
  transcriptTrust,
} from '../lib/transcript.mjs';
import { DemoNotVerifiedError, RESULT, exitCodeForResults, resultLine } from '../lib/results.mjs';
import { expectRecovery, recoveryPersisted } from '../lib/recovery-state.mjs';

export {
  assertExpectedDenial,
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
  transcriptTrust,
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SCRIPT_DIR, '..', '..');

export const DEFAULT_FLOWS = [
  'architecture',
  'development',
  'peer-review',
  'reduced-on',
  'reduced-off',
  'architecture-negative',
];

/** Dedicated, untouched seed copy the architecture negative probe governs. */
export const NEGATIVE_PROBE_WORKSPACE = 'java-task-manager-architecture-negative';

/**
 * Verifier flow identity per matrix scenario. The reduced-ceremony scenarios
 * are development flows; their scenario names are never verifier flow names.
 */
export function verificationFlowFor(flowName) {
  if (flowName === 'reduced-on' || flowName === 'reduced-off') return 'development';
  if (flowName === 'architecture' || flowName === 'development' || flowName === 'peer-review') {
    return flowName;
  }
  throw new Error(`no verifier flow for scenario: ${flowName}`);
}

/** Non-zero when any requested flow did not produce accepted evidence. */
export function matrixExitCode(flows) {
  return exitCodeForResults(flows);
}

/**
 * Reviewer capture/consistency blocks. The product fail-closed is correct, but
 * a positive proof that never reaches its gate is NOT_VERIFIED, not a demo
 * contract violation. The evidence is preserved either way.
 */
export const REVIEW_STAGE_INCOMPLETE_CODES = new Set([
  'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION',
  'SUBAGENT_CHALLENGE_EVIDENCE_MISSING',
  'SUBAGENT_UNABLE_TO_REVIEW',
  'SUBAGENT_FINDINGS_VERDICT_MISMATCH',
  'REVIEW_FINDING_SUBJECT_ANCHOR_OUT_OF_SCOPE',
  'REVIEW_EVIDENCE_NOT_OBSERVED',
  'REVIEW_ATTEMPT_UNAVAILABLE',
]);

export function classifyUnexpectedBlock(codes) {
  if (codes.length > 0 && codes.every((code) => REVIEW_STAGE_INCOMPLETE_CODES.has(code))) {
    return 'not_verified';
  }
  return 'failed';
}

/** The persisted review loop ended without reviewer acceptance. */
export function persistedReviewExhausted(state) {
  return (
    state?.plan?.reviewCompletion === 'review_exhausted' ||
    state?.architecture?.reviewCompletion === 'review_exhausted'
  );
}

export function parseArgs(argv) {
  const options = { check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
      index += 1;
      return value;
    };
    if (flag === '--root') options.root = next();
    else if (flag === '--model') options.model = next();
    else if (flag === '--tarball') options.tarball = next();
    else if (flag === '--product-sha') options.productSha = next();
    else if (flag === '--flows')
      options.flows = next()
        .split(',')
        .map((flow) => flow.trim());
    else if (flag === '--check') options.check = true;
    else throw new Error(`unknown option: ${flag}`);
  }
  if (!options.root) throw new Error('--root <work-root> is required');
  options.root = path.resolve(options.root);
  options.model ??= 'deepseek/deepseek-flash';
  options.flows ??= DEFAULT_FLOWS;
  for (const flow of options.flows) {
    if (!DEFAULT_FLOWS.includes(flow)) throw new Error(`unknown flow: ${flow}`);
  }
  return options;
}

/** Canonical toolchain pins, read from the repository authorities. */
export function readPins() {
  const compat = fs.readFileSync(
    path.join(REPO, 'src', 'cli', 'opencode-runtime-compat.ts'),
    'utf8',
  );
  const hostMatch = /export const TESTED_OPENCODE_HOST_VERSION = '([^']+)'/.exec(compat);
  if (!hostMatch) {
    throw new Error('TESTED_OPENCODE_HOST_VERSION not found in the canonical compat authority');
  }
  const nodePin = fs.readFileSync(path.join(REPO, '.node-version'), 'utf8').trim();
  if (!nodePin) throw new Error('.node-version is empty');
  return { opencode: hostMatch[1], node: nodePin };
}

export function assertToolchain(pins) {
  const problems = [];
  const nodeVersion = process.versions.node;
  if (nodeVersion !== pins.node) {
    problems.push(`node ${nodeVersion} != pinned ${pins.node} (.node-version)`);
  }
  const opencodeVersion = execFileSync('opencode', ['--version'], { encoding: 'utf8' }).trim();
  if (opencodeVersion !== pins.opencode) {
    problems.push(
      `opencode ${opencodeVersion} != tested ${pins.opencode} (opencode-runtime-compat.ts)`,
    );
  }
  if (problems.length > 0) {
    throw new Error(`toolchain pin mismatch:\n- ${problems.join('\n- ')}`);
  }
  return { nodeVersion, opencodeVersion };
}

/**
 * Verify a tarball against its `checksums.sha256` sidecar using the canonical
 * `pack-with-checksums` contract (`<sha256>  <basename>`). A missing, malformed,
 * name-mismatched, or digest-mismatched sidecar fails closed: the installer
 * must never run against a tarball whose recorded checksum does not match.
 */
export function verifyChecksumSidecar(tarball, sidecar) {
  const content = fs.readFileSync(sidecar, 'utf8').trim();
  const match = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(content);
  if (!match) throw new Error(`checksums.sha256 is malformed: ${sidecar}`);
  const [, expected, recordedName] = match;
  const actualName = path.basename(tarball);
  if (recordedName !== actualName) {
    throw new Error(
      `checksums.sha256 records '${recordedName}', but the tarball is '${actualName}'`,
    );
  }
  const actual = sha256(tarball);
  if (actual !== expected) {
    throw new Error(`checksum mismatch for ${actualName}: ${actual} != ${expected}`);
  }
  return { sha256: actual, name: actualName };
}

function tarballFor(options) {
  if (options.tarball) {
    const tarball = path.resolve(options.tarball);
    const sidecar = path.join(path.dirname(tarball), 'checksums.sha256');
    if (!fs.existsSync(tarball)) throw new Error(`tarball not found: ${tarball}`);
    if (!fs.existsSync(sidecar)) {
      throw new Error(`checksums.sha256 is required next to the tarball: ${sidecar}`);
    }
    verifyChecksumSidecar(tarball, sidecar);
    return { tarball, sidecar, builtFromCheckout: false };
  }
  execFileSync('npm', ['run', 'build'], { cwd: REPO, stdio: 'inherit' });
  execFileSync('npm', ['run', 'pack:checksums'], { cwd: REPO, stdio: 'inherit' });
  const version = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
  const tarball = path.join(REPO, `flowguard-core-${version}.tgz`);
  const sidecar = path.join(REPO, 'checksums.sha256');
  if (!fs.existsSync(tarball)) throw new Error(`pack did not produce ${tarball}`);
  if (!fs.existsSync(sidecar)) throw new Error('pack did not produce checksums.sha256');
  verifyChecksumSidecar(tarball, sidecar);
  return { tarball, sidecar, builtFromCheckout: true };
}

export function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env, PWD: options.cwd },
      stdio: ['ignore', options.stdout ?? 'pipe', options.stderr ?? 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
      },
      options.timeoutMs ?? 30 * 60_000,
    );
    child.stdout?.on('data', (chunk) => (stdout += chunk));
    child.stderr?.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
  });
}

/**
 * Typed, recoverable denials the governed agent is expected to recover from
 * in-session (fail-fast admission, call-shape corrections). Run 8/9 evidence
 * shows these occur on normal successful flows; they are recorded but do not
 * stop the flow. Every other denial stays flow-stopping.
 */
export const RECOVERABLE_DENIAL_CODES = new Set([
  'PROOFGRAPH_CLAIM_NOT_DECLARED',
  'PROOFGRAPH_CLAIM_UNSATISFIABLE',
  'PROOFGRAPH_CLAIM_CONTRACT_INCOMPLETE',
  'PROOFGRAPH_CLAIM_EVIDENCE_UNRESOLVED',
  'ADR_SUBMISSION_MIXED_INPUTS',
  'ADR_REVIEW_IN_PROGRESS',
  'ARCHITECTURE_CLAIM_INVALID',
  'TICKET_SOURCE_CONFLICT',
  'CONTENT_ANALYSIS_REQUIRED',
  'REVISED_PLAN_CLAIMS_REQUIRED',
  // Typed command-input validation: the author corrects the call and resubmits
  // in-session (Run 11: an architecture session reached ARCH_COMPLETE after
  // EMPTY_ADR_TITLE, and the negative probe continued after EMPTY_ADR_TEXT).
  'EMPTY_ADR_TITLE',
  'EMPTY_ADR_TEXT',
  // Run 13: a plan revision submission omitted planText; the author corrected
  // the call in the same turn and the plan was accepted.
  'REVISED_PLAN_REQUIRED',
]);

/**
 * Recoverable denials whose correction is NOT a same-turn retry of the denied
 * tool but the immediately following explicit runner step. `CONTINUE_AMBIGUOUS`
 * is an admissibility signal that mutates nothing and demands an explicit flow
 * choice; the runner's next step performs exactly that. Such a denial is recorded
 * as `pending_recovery` and only becomes `recovered` when the next required step
 * completes with a demonstrable state transition. There is no blanket allowance:
 * without that proof the flow is blocked.
 */
export const NEXT_STEP_RECOVERY_CODES = new Set(['CONTINUE_AMBIGUOUS']);

/**
 * A plan submission during an ACTIVE review loop is corrected by resuming the
 * bound review in the same turn. The correction is never accepted as a bare
 * retry: the same-turn proof here is paired with the persisted gate proof
 * ({@link planReviewCorrectionProven}) before the flow may continue to the
 * plan approval step.
 */
export const PLAN_REVIEW_CORRECTION_CODE = 'PLAN_REVIEW_IN_PROGRESS';

/**
 * Bounded resume budget for an author that ends the /implement turn at
 * IMPL_REVIEW without the reviewer dispatch. Each resume is a canonical
 * /implement command turn and must prove state progress; the evidence gate is
 * never bypassed and the independent review is never weakened.
 */
export const MAX_IMPLEMENT_REVIEW_RESUMES = 2;

/** Same-turn proof: the planner was denied and then succeeded later in the turn. */
export function planReviewSameTurnCorrection(output) {
  const proof = sameTurnRecoveryProofs(output).recovered.find(
    (candidate) => candidate.code === PLAN_REVIEW_CORRECTION_CODE,
  );
  return proof?.tool === 'flowguard_plan';
}

/**
 * Persisted proof required before the plan gate: the correction actually
 * resumed the SAME bound review loop (consistent iteration) to a recorded
 * reviewer acceptance. An unproven correction keeps the flow blocked.
 */
export function planReviewCorrectionProven(state) {
  const plan = state.plan;
  const selfReview = state.selfReview;
  if (!plan || !selfReview) return false;
  const iterationConsistent =
    Number.isInteger(selfReview.iteration) &&
    Number.isInteger(selfReview.maxIterations) &&
    selfReview.iteration <= selfReview.maxIterations;
  return (
    plan.reviewCompletion === 'reviewer_accepted' &&
    selfReview.verdict === 'accept' &&
    iterationConsistent
  );
}

/** Recoverable-family denial: corrected in-session or by the required next step. */
export function isRecoverableFamily(code) {
  return RECOVERABLE_DENIAL_CODES.has(code) || NEXT_STEP_RECOVERY_CODES.has(code);
}

/** Denials observed in a step that must stop the flow (never recovered in-session). */
export function unexpectedDenialCodes(output) {
  return toolDenialCodes(output).filter((code) => !isRecoverableFamily(code));
}

/**
 * Opt the installed repository config into raw auditor archives, mirroring the
 * documented demo setup. The isolated global config remains the admin ceiling;
 * the repository config can only restrict, so both layers must allow raw
 * export for `/archive redactionMode=none includeRaw=true`.
 */
export function enableRawArchiveInRepoConfig(workspace) {
  const file = path.join(workspace, '.opencode', 'flowguard.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.archive = config.archive ?? {};
  config.archive.redaction = config.archive.redaction ?? {};
  config.archive.redaction.allowRawExport = true;
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

export function assertArchitectureProbeNotPersisted(state) {
  if (state.architecture !== null) {
    throw new Error('the rejected architecture probe declaration was persisted');
  }
}

export function canonicalPath(target) {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

/** The persisted session must be bound to the observed host session and worktree. */
export function assertSessionBinding(state, hostSessionId, workspace) {
  const boundHost = state.binding?.hostSessionId;
  if (boundHost !== hostSessionId) {
    throw new Error(`persisted host binding '${String(boundHost)}' != observed '${hostSessionId}'`);
  }
  const boundWorktree = state.binding?.worktree;
  if (
    typeof boundWorktree !== 'string' ||
    canonicalPath(boundWorktree) !== canonicalPath(workspace)
  ) {
    throw new Error(
      `persisted worktree binding '${String(boundWorktree)}' != delivered workspace '${workspace}'`,
    );
  }
}

/**
 * A live control record may become PASS ONLY after provenance capture has
 * validated every required parent/reviewer transcript, and the payload can
 * never supply `result` itself. Any failure keeps the record FAILED so the
 * aggregate cannot count a falsely passing case.
 */
export async function finalizeControlRecord(
  record,
  session,
  runner,
  payload = {},
  result = RESULT.CONTROL_PASSED,
) {
  record.result = RESULT.FAILED;
  record.hostSessionId = session.sessionId;
  await runner.captureProvenance(record, session);
  const { result: _rejected, ...safePayload } = payload;
  Object.assign(record, safePayload, { result });
  return record;
}

/** Sessions whose transcripts belong to one flow's evidence: parent + reviewers. */
export function transcriptTargets(state) {
  const reviewers = [
    ...new Set(
      (state.reviewAssurance?.invocations ?? [])
        .map((invocation) => invocation.childSessionId)
        .filter((sessionId) => typeof sessionId === 'string' && sessionId.length > 0),
    ),
  ].filter((sessionId) => sessionId !== state.binding?.hostSessionId);
  return { parent: state.binding?.hostSessionId ?? null, reviewers };
}

function sessionStateDir(configDir, sessionId) {
  const workspacesRoot = path.join(configDir, 'workspaces');
  if (!fs.existsSync(workspacesRoot)) return null;
  for (const fingerprint of fs.readdirSync(workspacesRoot)) {
    const statePath = path.join(
      workspacesRoot,
      fingerprint,
      'sessions',
      sessionId,
      'session-state.json',
    );
    if (fs.existsSync(statePath)) return { statePath, sessionDir: path.dirname(statePath) };
  }
  return null;
}

function readState(configDir, sessionId) {
  const found = sessionStateDir(configDir, sessionId);
  if (!found) return null;
  return {
    state: JSON.parse(fs.readFileSync(found.statePath, 'utf8')),
    sessionDir: found.sessionDir,
  };
}

function assertHostCallOk(result, label) {
  if (result.timedOut) throw new Error(`${label}: host process timed out`);
  if (result.code !== 0) throw new Error(`${label}: host exit code ${String(result.code)}`);
  const hostErrors = eventsOf(result.stdout).filter((event) => event.type === 'error');
  if (hostErrors.length > 0) throw new Error(`${label}: host error event observed`);
}

export class Runner {
  constructor(root, options, configDir) {
    this.root = root;
    this.options = options;
    this.configDir = configDir;
    this.workspaces = path.join(root, 'workspaces');
    this.evidenceDir = path.join(root, 'evidence');
    this.logFile = path.join(this.evidenceDir, 'driver.log');
    this.flows = [];
  }

  log(message) {
    const line = `${new Date().toISOString()} ${message}`;
    console.log(line);
    fs.appendFileSync(this.logFile, `${line}\n`);
  }

  async hostStep(label, workspace, args, timeoutMs = 30 * 60_000) {
    const stdoutPath = path.join(this.evidenceDir, `${label}.jsonl`);
    const stderrPath = path.join(this.evidenceDir, `${label}.err`);
    if (fs.existsSync(stdoutPath) || fs.existsSync(stderrPath)) {
      throw new Error(`evidence file already exists for ${label}; use a fresh --root`);
    }
    const stdoutFd = fs.openSync(stdoutPath, 'w');
    const stderrFd = fs.openSync(stderrPath, 'w');
    const result = await run('opencode', args, {
      cwd: workspace,
      env: { OPENCODE_CONFIG_DIR: this.configDir, OPENCODE_DISABLE_AUTOUPDATE: '1' },
      stdout: stdoutFd,
      stderr: stderrFd,
      timeoutMs,
    });
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
    const output = fs.readFileSync(stdoutPath, 'utf8');
    const sessionIds = [
      ...new Set(
        eventsOf(output)
          .map((event) => event.sessionID)
          .filter(Boolean),
      ),
    ];
    this.log(`${label}: exit=${String(result.code)} time=${Math.round(result.durationMs / 1000)}s`);
    return { ...result, stdout: output, sessionIds };
  }

  async turn(session, label, prompt, options = {}) {
    const phaseBefore = this.currentPhase(session);
    const args = ['run', '--dir', session.workspace, '-m', this.options.model, '--format', 'json'];
    if (session.sessionId) args.push('--session', session.sessionId);
    if (options.command) args.push('--command', options.command);
    if (prompt) args.push(prompt);
    const result = await this.hostStep(label, session.workspace, args);
    assertHostCallOk(result, label);
    const observed = result.sessionIds.at(-1);
    if (session.sessionId && observed && observed !== session.sessionId) {
      throw new Error(`${label}: session continuity changed (${observed})`);
    }
    session.sessionId = session.sessionId ?? observed;
    if (!session.sessionId) throw new Error(`${label}: no host session id observed`);
    if (options.expectedDenial) {
      assertExpectedDenial(result.stdout, options.expectedDenial);
      return result;
    }

    const trust = transcriptTrust(result.stdout);
    if (!trust.readable) {
      session.transcriptWarnings = session.transcriptWarnings ?? [];
      session.transcriptWarnings.push({ step: label, ...trust });
      this.log(
        `${label}: untrustworthy transcript (${trust.framingLosses.length} framing loss(es), ` +
          `${trust.unreadable.length} unreadable governed tool output(s)); no proof can be credited`,
      );
      throw new DemoNotVerifiedError(
        `${label}: transcript is not trustworthy (${trust.framingLosses.length} framing loss(es), ` +
          `${trust.unreadable.length} unreadable governed tool output(s)); the proof is NOT_VERIFIED`,
      );
    }
    if (session.awaitingRecovery) {
      const pending = session.awaitingRecovery;
      const command = options.command ?? /^\/([a-z-]+)/.exec(prompt ?? '')?.[1];
      const after = this.requireBoundState(session).state;
      if (!recoveryPersisted(pending.expected, after, command)) {
        throw new DemoNotVerifiedError(
          `${label}: pending recovery [${pending.codes.join(', ')}] was not demonstrated ` +
            'by the authorized affected-operation transition; stopping the flow',
        );
      }
      session.recoveredDenials = session.recoveredDenials ?? [];
      session.recoveredDenials.push({
        step: pending.step,
        codes: pending.codes,
        evidence: `next_step_operation_transition:${label}`,
        expected: pending.expected,
      });
      this.log(
        `${pending.step}: recovered by the authorized ${command} operation on its bound subject`,
      );
      session.awaitingRecovery = null;
    }
    const recoverable = [...new Set(toolDenialCodes(result.stdout).filter(isRecoverableFamily))];
    const proofs = sameTurnRecoveryProofs(result.stdout);
    const recoverableProofs = proofs.recovered.filter((proof) => isRecoverableFamily(proof.code));
    const operationRecovered = [
      ...new Set(
        recoverableProofs
          .filter((proof) => proof.binding === 'operation')
          .map((proof) => proof.code),
      ),
    ];
    const laterSuccessOnly = [
      ...new Set(
        recoverableProofs.filter((proof) => proof.binding === 'tool').map((proof) => proof.code),
      ),
    ];
    // Only an OPERATION-bound correction resolves the denial in-turn. A later
    // success without an operation binding is an observation; resolving it
    // requires an independent persisted proof from the next required step.
    const sameTurnRecovered = operationRecovered;
    const unprovenOccurrences = [...new Set(proofs.unproven.map((proof) => proof.code))];
    const retryRecovered = captureRetryCodes(result.stdout);
    const retryHints = captureRetryHints(result.stdout);
    if (retryHints.length > 0) {
      session.retryHints = [...(session.retryHints ?? []), { step: label, events: retryHints }];
      this.log(
        `${label}: retryable host hint observed without complete review identities; no re-arm proof credited`,
      );
    }
    session.recoveredDenials = session.recoveredDenials ?? [];
    if (operationRecovered.length > 0) {
      session.recoveredDenials.push({
        step: label,
        codes: operationRecovered,
        evidence: 'same_turn_operation_recovery',
      });
      this.log(
        `${label}: recovered via same-turn operation recovery [${operationRecovered.join(', ')}]`,
      );
    }
    if (laterSuccessOnly.length > 0) {
      session.recoveredDenials.push({
        step: label,
        codes: laterSuccessOnly,
        evidence: 'later_tool_success',
      });
      this.log(
        `${label}: later success of the same tool recorded without an operation binding ` +
          `[${laterSuccessOnly.join(', ')}]; the next required step must prove a persisted transition`,
      );
    }
    if (retryRecovered.length > 0) {
      session.recoveredDenials.push({
        step: label,
        codes: retryRecovered,
        evidence: 'structured_rearm',
      });
      this.log(`${label}: recovered via structured re-arm [${retryRecovered.join(', ')}]`);
    }
    const pendingCodes = [
      ...new Set([
        ...recoverable.filter(
          (code) => NEXT_STEP_RECOVERY_CODES.has(code) && !sameTurnRecovered.includes(code),
        ),
        ...laterSuccessOnly,
      ]),
    ];
    const unproven = unprovenOccurrences.filter(
      (code) => isRecoverableFamily(code) && !NEXT_STEP_RECOVERY_CODES.has(code),
    );
    if (unproven.length > 0) {
      throw new Error(
        `${label}: recoverable denial occurrence(s) without a later proven correction (${unproven.join(', ')}); stopping the flow`,
      );
    }
    if (pendingCodes.length > 0) {
      session.awaitingRecovery = {
        step: label,
        codes: pendingCodes,
        expected: expectRecovery(
          this.requireBoundState(session).state,
          [
            ...new Set(
              toolDenialEvents(result.stdout)
                .filter((event) => pendingCodes.includes(event.code))
                .map((event) => event.tool),
            ),
          ],
          session.terminal,
          recoverableProofs
            .filter((proof) => proof.binding === 'tool')
            .map((proof) => proof.denialIdentity),
        ),
      };
      this.log(
        `${label}: pending recovery [${pendingCodes.join(', ')}]; the next required step must prove the bound operation`,
      );
    }

    const supersededTerminals = unexpectedDenialCodes(result.stdout).filter((code) =>
      structuredRearmSupersedesTerminal(result.stdout, code),
    );
    if (supersededTerminals.length > 0) {
      session.pendingReviewRecovery = {
        steps: [...(session.pendingReviewRecovery?.steps ?? []), label],
        codes: supersededTerminals,
      };
      this.log(
        `${label}: terminal block(s) [${supersededTerminals.join(', ')}] superseded by a later structured re-arm; the persisted review outcome is proven at the gate`,
      );
    }

    const planReviewDenied = toolDenialCodes(result.stdout).includes(PLAN_REVIEW_CORRECTION_CODE);
    if (planReviewDenied && !planReviewSameTurnCorrection(result.stdout)) {
      throw new Error(
        `${label}: ${PLAN_REVIEW_CORRECTION_CODE} without a same-turn flowguard_plan correction; stopping the flow`,
      );
    }
    if (planReviewDenied) {
      session.pendingPlanReviewCorrection = {
        steps: [...(session.pendingPlanReviewCorrection?.steps ?? []), label],
      };
      this.log(
        `${label}: ${PLAN_REVIEW_CORRECTION_CODE} corrected in-session; reviewer_accepted and iteration consistency are proven at the plan gate`,
      );
    }

    const unexpected = unexpectedDenialCodes(result.stdout).filter(
      (code) =>
        !(planReviewDenied && code === PLAN_REVIEW_CORRECTION_CODE) &&
        !supersededTerminals.includes(code),
    );
    if (unexpected.length > 0) {
      // The persisted terminal phase is FlowGuard's outcome authority: when the
      // session already reached it, the transport-level block is recorded — never
      // hidden — instead of discarding the completed flow. `denialAfterTerminal`
      // is `true` only when the terminal phase was already persisted BEFORE this
      // turn, which causally places the denial after the transition; otherwise it
      // stays `null` and the ordering is not claimed. Package verification still
      // runs and fails the flow if the required artifact is absent.
      const phaseAfter = this.currentPhase(session);
      if (phaseAfter === session.terminal) {
        session.terminalBlocks = session.terminalBlocks ?? [];
        session.terminalBlocks.push({
          step: label,
          codes: unexpected,
          phaseBefore,
          phaseAfter,
          denialAfterTerminal: phaseBefore === session.terminal ? true : null,
        });
        this.log(
          `${label}: terminal block(s) recorded (phaseBefore=${String(phaseBefore)}, phaseAfter=${String(phaseAfter)}) [${unexpected.join(', ')}]`,
        );
      } else {
        let reviewExhausted = false;
        try {
          reviewExhausted = persistedReviewExhausted(this.requireBoundState(session).state);
        } catch {
          reviewExhausted = false;
        }
        if (reviewExhausted && unexpected.includes('GOVERNANCE_OVERRIDE_REQUIRED')) {
          throw new DemoNotVerifiedError(
            `${label}: independent review exhausted its budget without acceptance ` +
              `(${unexpected.join(', ')}); the positive proof is NOT_VERIFIED`,
          );
        }
        if (classifyUnexpectedBlock(unexpected) === 'not_verified') {
          throw new DemoNotVerifiedError(
            `${label}: review-stage evidence is incomplete (${unexpected.join(', ')}); ` +
              'the positive proof is NOT_VERIFIED',
          );
        }
        throw new Error(
          `${label}: unexpected tool-level block observed (${unexpected.join(', ')}); stopping the flow`,
        );
      }
    }
    return result;
  }

  /** Best-effort persisted phase; `null` when the state is unreadable. */
  currentPhase(session) {
    try {
      return this.requireBoundState(session).state.phase;
    } catch {
      return null;
    }
  }

  /** Digest of the persisted session state; `null` when unreadable. */
  currentStateDigest(session) {
    try {
      const snapshot = this.requireBoundState(session);
      return sha256(path.join(snapshot.sessionDir, 'session-state.json'));
    } catch {
      return null;
    }
  }

  async approve(session, label, expectedPhase) {
    const snapshot = this.requireBoundState(session);
    if (snapshot.state.phase !== expectedPhase) {
      throw new Error(
        `${label}: expected gate ${expectedPhase}, observed ${String(snapshot.state.phase)}`,
      );
    }
    if (session.pendingReviewRecovery) {
      const proven =
        expectedPhase === 'PLAN_REVIEW'
          ? planReviewCorrectionProven(snapshot.state)
          : expectedPhase === 'ARCH_REVIEW' &&
            snapshot.state.architecture?.reviewCompletion === 'reviewer_accepted';
      if (!proven) {
        throw new Error(
          `${label}: superseded reviewer block(s) [${session.pendingReviewRecovery.codes.join(', ')}] were not proven by a converged review; stopping the flow`,
        );
      }
      session.recoveredDenials = session.recoveredDenials ?? [];
      session.recoveredDenials.push({
        step: session.pendingReviewRecovery.steps.join(', '),
        codes: session.pendingReviewRecovery.codes,
        evidence: 'structured_rearm_after_terminal_failure',
      });
      this.log(
        `${label}: superseded reviewer block(s) [${session.pendingReviewRecovery.codes.join(', ')}] proven by the converged review`,
      );
      session.pendingReviewRecovery = null;
    }
    if (expectedPhase === 'PLAN_REVIEW' && session.pendingPlanReviewCorrection) {
      if (!planReviewCorrectionProven(snapshot.state)) {
        throw new Error(
          `${label}: ${PLAN_REVIEW_CORRECTION_CODE} correction did not persist a consistent reviewer_accepted plan; stopping the flow`,
        );
      }
      session.recoveredDenials = session.recoveredDenials ?? [];
      session.recoveredDenials.push({
        step: session.pendingPlanReviewCorrection.steps.join(', '),
        codes: [PLAN_REVIEW_CORRECTION_CODE],
        evidence: 'same_turn_correction_and_reviewer_accepted',
      });
      this.log(
        `${label}: ${PLAN_REVIEW_CORRECTION_CODE} correction proven by reviewer_accepted at the plan gate`,
      );
      session.pendingPlanReviewCorrection = null;
    }
    await this.turn(session, label, 'Demo approval through the real command boundary.', {
      command: 'approve',
    });
  }

  /**
   * Drive an outstanding implementation review to EVIDENCE_REVIEW with a
   * BOUNDED number of canonical /implement resumes. The author may end the
   * /implement turn at IMPL_REVIEW without dispatching the reviewer task
   * (observed live); this helper re-enters the real command boundary instead
   * of failing the flow outright. Fail-closed: only IMPL_REVIEW may be
   * resumed, every resume must prove persisted state progress, and the gate
   * must be reached within the bound.
   */
  async completeImplementationReview(session, label, maxResumes = MAX_IMPLEMENT_REVIEW_RESUMES) {
    for (let attempt = 1; attempt <= maxResumes; attempt += 1) {
      const phase = this.currentPhase(session);
      if (phase === 'EVIDENCE_REVIEW') return;
      if (phase !== 'IMPL_REVIEW') {
        throw new Error(
          `${label}: expected IMPL_REVIEW or EVIDENCE_REVIEW, observed ${String(phase)}`,
        );
      }
      const stepLabel = `${label}-resume-${attempt}`;
      const digestBefore = this.currentStateDigest(session);
      await this.turn(session, stepLabel, '/implement');
      const digestAfter = this.currentStateDigest(session);
      if (digestAfter === null || digestAfter === digestBefore) {
        throw new Error(
          `${stepLabel}: bounded implementation review resume produced no state progress; stopping the flow`,
        );
      }
      session.resumedSteps = session.resumedSteps ?? [];
      session.resumedSteps.push({ step: label, attempt, evidence: 'bounded_resume' });
      this.log(
        `${stepLabel}: implementation review resumed (bounded attempt ${attempt}; state progressed)`,
      );
    }
    const phase = this.currentPhase(session);
    if (phase !== 'EVIDENCE_REVIEW') {
      throw new Error(
        `${label}: implementation review did not reach EVIDENCE_REVIEW within ${maxResumes} bounded resume(s); stopping the flow`,
      );
    }
  }

  requireBoundState(session) {
    const snapshot = readState(this.configDir, session.sessionId);
    if (!snapshot) throw new Error(`no persisted state for ${session.sessionId}`);
    assertSessionBinding(snapshot.state, session.sessionId, session.workspace);
    return snapshot;
  }

  installedBuild(workspace) {
    const buildInfoPath = path.join(
      workspace,
      '.opencode',
      'node_modules',
      '@flowguard',
      'core',
      'dist',
      'build-info.json',
    );
    if (!fs.existsSync(buildInfoPath)) {
      throw new Error(`installed build info missing: ${buildInfoPath}`);
    }
    return JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'));
  }

  async exportTranscript(label, sessionId, workspace, parentSessionId) {
    const file = await exportHostTranscript({
      label,
      sessionId,
      workspace,
      parentSessionId,
      evidenceDir: this.evidenceDir,
      configDir: this.configDir,
    });
    return { sessionId, file: path.relative(this.evidenceDir, file), sha256: sha256(file) };
  }

  async captureProvenance(flow, session) {
    flow.retryHints = session.retryHints ?? [];
    const snapshot = this.requireBoundState(session);
    const targets = transcriptTargets(snapshot.state);
    if (targets.parent !== session.sessionId) {
      throw new Error(`${flow}: persisted host binding is not the observed session`);
    }
    const parent = await this.exportTranscript(flow.name, targets.parent, session.workspace);
    const reviewers = [];
    for (const childSessionId of targets.reviewers) {
      reviewers.push(
        await this.exportTranscript(flow.name, childSessionId, session.workspace, targets.parent),
      );
    }
    flow.transcripts = { parent, reviewers };
    flow.installedBuild = this.installedBuild(session.workspace);
  }

  verifyPackage(session, kind, expectFlow, expectPhase, label) {
    const snapshot = this.requireBoundState(session);
    const archiveDir = path.join(path.dirname(snapshot.sessionDir), 'archive');
    const file =
      kind === 'export'
        ? path.join(archiveDir, `export-${session.sessionId}.tar.gz`)
        : path.join(archiveDir, `${session.sessionId}.tar.gz`);
    if (!fs.existsSync(file)) throw new Error(`${label}: ${kind} package missing`);
    const verification = execFileSync(
      process.execPath,
      [
        path.join(SCRIPT_DIR, 'verify-evidence-package.mjs'),
        file,
        '--expect-session',
        session.sessionId,
        '--expect-flow',
        verificationFlowFor(expectFlow),
        '--expect-phase',
        expectPhase,
      ],
      { cwd: REPO, encoding: 'utf8' },
    );
    if (!/result: VERIFIED/.test(verification)) {
      throw new Error(`${label}: package verification failed`);
    }
    this.log(`${label}: ${kind} package VERIFIED (${sha256(file).slice(0, 12)}…)`);
    return { kind, file: path.relative(this.evidenceDir, file), sha256: sha256(file) };
  }
}

async function runDevelopment(runner, session) {
  await runner.turn(session, 'development-02-task', '/task --file TICKET.md');
  await runner.turn(session, 'development-03-plan', '/plan');
  await runner.approve(session, 'development-04-approve-plan', 'PLAN_REVIEW');
  await runner.turn(session, 'development-05-implement', '/implement');
  await runner.completeImplementationReview(session, 'development-05-implement');
  await runner.approve(session, 'development-06-approve-impl', 'EVIDENCE_REVIEW');
  await runner.turn(session, 'development-07-finish', '/finish');
  await runner.turn(session, 'development-08-export', '/export');
  const first = runner.verifyPackage(
    session,
    'export',
    'development',
    'EXPORT_READY',
    'development',
  );
  await runner.turn(session, 'development-09-archive', '/archive');
  const after = runner.verifyPackage(
    session,
    'export',
    'development',
    'EXPORT_READY',
    'development',
  );
  if (first.sha256 !== after.sha256) throw new Error('development: export changed after /archive');
  session.packages = [after];
}

async function runReduced(runner, session, label, ticket) {
  await runner.turn(session, `${label}-02-task`, `/task --file ${ticket}`);
  await runner.turn(session, `${label}-03-plan`, '/plan');
  await runner.approve(session, `${label}-04-approve-plan`, 'PLAN_REVIEW');
  await runner.turn(session, `${label}-05-implement`, '/implement');
  await runner.completeImplementationReview(session, `${label}-05-implement`);
  await runner.approve(session, `${label}-06-approve-impl`, 'EVIDENCE_REVIEW');
  await runner.turn(session, `${label}-07-export`, '/export');
  session.packages = [
    runner.verifyPackage(session, 'export', 'development', 'EXPORT_READY', label),
  ];
}

export async function runFlows(runner) {
  const { workspaces, configDir } = runner;
  const mainWorkspace = path.join(workspaces, 'java-task-manager');
  const reducedRoot = path.join(workspaces, 'reduced-ceremony');
  // The negative probe reviews against the untouched seed. The development flow
  // modifies the main workspace, so the probe gets its own pristine copy: a
  // reviewer comparing a post-fix ADR against the frozen base would otherwise
  // reject a correct decision.
  const negativeWorkspace = path.join(workspaces, NEGATIVE_PROBE_WORKSPACE);

  const flows = {
    architecture: {
      workspace: mainWorkspace,
      terminal: 'ARCH_COMPLETE',
      run: async (session) => {
        await runner.turn(
          session,
          'architecture-02-architecture',
          '/architecture Read ADR_TICKET.md and TICKET.md, then create an ADR based on them. Record ProofGraph claims using the architecture claim fields (statement, critical, authoritySectionId, requiredReviewEvidence). If a claim submission is rejected, read the recovery guidance and resubmit corrected claims.',
        );
        await runner.approve(session, 'architecture-03-approve', 'ARCH_REVIEW');
        await runner.turn(
          session,
          'architecture-04-archive',
          '/archive redactionMode=none includeRaw=true',
        );
        session.packages = [
          runner.verifyPackage(session, 'archive', 'architecture', 'ARCH_COMPLETE', 'architecture'),
        ];
      },
    },
    development: {
      workspace: mainWorkspace,
      terminal: 'COMPLETE',
      run: (session) => runDevelopment(runner, session),
    },
    'peer-review': {
      workspace: mainWorkspace,
      terminal: 'PEER_REVIEW_COMPLETE',
      run: async (session) => {
        await runner.turn(session, 'peer-review-02-review', '/review branch=feature/add-due-date');
        await runner.turn(
          session,
          'peer-review-03-archive',
          '/archive redactionMode=none includeRaw=true',
        );
        session.packages = [
          runner.verifyPackage(
            session,
            'archive',
            'peer-review',
            'PEER_REVIEW_COMPLETE',
            'peer-review',
          ),
        ];
      },
    },
    'reduced-on': {
      workspace: path.join(reducedRoot, 'reduced-on'),
      terminal: 'COMPLETE',
      preflight: ['--verify-session', path.join(reducedRoot, 'reduced-on')],
      run: (session) => runReduced(runner, session, 'reduced-on', 'TICKET_DOCS.md'),
    },
    'reduced-off': {
      workspace: path.join(reducedRoot, 'reduced-off'),
      terminal: 'COMPLETE',
      preflight: ['--verify-session', path.join(reducedRoot, 'reduced-off')],
      run: (session) => runReduced(runner, session, 'reduced-off', 'TICKET_DOCS.md'),
    },
    'architecture-negative': {
      workspace: negativeWorkspace,
      terminal: 'ARCH_COMPLETE',
      run: async (session) => {
        // Controlled negative step: the exact typed denial must be observed and
        // nothing may be persisted before the allowed recovery continues.
        await runner.turn(
          session,
          'architecture-negative-02-probe',
          'Call flowguard_architecture exactly once with a minimal ADR (title Negative-Path Probe, adrText with the sections ## Context, ## Decision, ## Consequences) and EXACTLY this intentionally invalid plan-shaped claims array: [{"statement":"probe plan-shaped claim","claimScope":"specific_behavior","expectedCheckId":"probe","critical":true}]. Report the typed rejection code, do not resubmit in this step, and stop.',
          { expectedDenial: 'ARCHITECTURE_CLAIM_INVALID' },
        );
        const probed = runner.requireBoundState(session);
        assertArchitectureProbeNotPersisted(probed.state);
        await runner.turn(
          session,
          'architecture-negative-03-recovery',
          '/architecture Read ADR_TICKET.md and TICKET.md and create a complete ticket-aligned Service-Layer Null-Safety ADR, including the required options, trade-offs, consequences and falsifiable validation path. Submit schema-valid architecture claims about that ADR using statement, critical, authoritySectionId and requiredReviewEvidence. The preceding invalid-claim probe is separate runner evidence, not the ADR subject and not repository evidence for its claims. Complete the full fresh independent review normally; correct substantive blocking findings and stop at the ordinary approval gate. Do not use a governance override.',
        );
        const afterRecovery = runner.requireBoundState(session);
        if (afterRecovery.state.architecture?.reviewCompletion === 'review_exhausted') {
          // Negative contract: an exhausted independent review must NOT be
          // approvable by a plain /approve, and the refusal must not mutate
          // the gate. A successful recovery to ARCH_COMPLETE is a different
          // proof and stays on the converged branch below.
          await runner.turn(
            session,
            'architecture-negative-04-approve',
            'Demo approval through the real command boundary.',
            { command: 'approve', expectedDenial: 'GOVERNANCE_OVERRIDE_REQUIRED' },
          );
          const refused = runner.requireBoundState(session);
          if (
            refused.state.phase !== 'ARCH_REVIEW' ||
            refused.state.architecture?.status === 'accepted'
          ) {
            throw new Error('the refused plain approve mutated the exhausted architecture gate');
          }
          session.negativeOutcome = 'exhausted_plain_approve_refused';
          return;
        }
        await runner.approve(session, 'architecture-negative-04-approve', 'ARCH_REVIEW');
        await runner.turn(
          session,
          'architecture-negative-05-archive',
          '/archive redactionMode=none includeRaw=true',
        );
        session.packages = [
          runner.verifyPackage(
            session,
            'archive',
            'architecture',
            'ARCH_COMPLETE',
            'architecture-negative',
          ),
        ];
      },
      negativeOutcomes: ['exhausted_plain_approve_refused'],
    },
  };
  return flows;
}

/**
 * Run `task` with the temporary raw-export grant present in the isolated
 * config dir, and remove the grant in a `finally` — including when
 * initialization fails. The grant never touches the global user config.
 */
export async function withRawExportGrant(configDir, task) {
  const globalConfig = path.join(configDir, 'flowguard.json');
  fs.writeFileSync(
    globalConfig,
    JSON.stringify({ schemaVersion: 'v1', archive: { redaction: { allowRawExport: true } } }),
  );
  try {
    return await task();
  } finally {
    fs.rmSync(globalConfig, { force: true });
  }
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

  const evidenceDir = path.join(options.root, 'evidence');
  const configDir = path.join(options.root, 'config');
  const workspaces = path.join(options.root, 'workspaces');
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });

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
  );

  execFileSync(
    path.join(REPO, 'run-demo-setup.sh'),
    ['--install', '--tarball', tarball, workspaces],
    {
      cwd: REPO,
      stdio: 'inherit',
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
  const exitCode = await withRawExportGrant(configDir, async () => {
    const flows = await runFlows(runner);
    for (const name of options.flows) {
      const flow = flows[name];
      const record = { name, workspace: flow.workspace, result: RESULT.FAILED };
      runner.flows.push(record);
      runner.log(`START ${name}`);
      try {
        const session = { workspace: flow.workspace, terminal: flow.terminal };
        await runner.turn(session, `${name}-01-start`, '/start');
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
              env: { ...process.env, OPENCODE_CONFIG_DIR: configDir },
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
      }
      fs.writeFileSync(path.join(evidenceDir, 'flows.json'), JSON.stringify(runner.flows, null, 2));
      fs.writeFileSync(
        path.join(evidenceDir, 'host-sessions.json'),
        JSON.stringify(
          runner.flows.map(
            ({
              name,
              hostSessionId,
              flowguardSessionId,
              transcripts,
              packages,
              installedBuild,
            }) => ({
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
      );
    }
    return matrixExitCode(runner.flows);
  });

  runner.log('raw-export grant removed from the isolated config dir');
  runner.log(resultLine(runner.flows, 'MATRIX RESULT'));
  if (exitCode !== 0) {
    runner.log('MATRIX INCOMPLETE: at least one scenario did not produce accepted evidence');
  }
  process.exitCode = exitCode;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(String(error));
    process.exitCode = 1;
  });
}

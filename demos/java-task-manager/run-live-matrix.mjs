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

/** Non-zero when any requested flow did not complete. */
export function matrixExitCode(flows) {
  return flows.every((flow) => flow.result === 'COMPLETE') ? 0 : 1;
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

function assertToolchain(pins) {
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

export function eventsOf(output) {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** Reason codes of every blocked/denied tool output in a host transcript. */
export function toolDenialCodes(output) {
  const codes = new Set();
  for (const event of eventsOf(output)) {
    const part = event.part?.state?.output ?? '';
    if (!/"error":true/.test(part)) continue;
    const match = /"code":"([A-Z0-9_]+)"/.exec(part);
    if (match) codes.add(match[1]);
  }
  return [...codes];
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
 * Successful reviewer capture re-arms are NOT error blocks: the transport
 * projects a structured `reviewRetry` outcome (reviewDispatch.completed=false,
 * no `error:true`) for the SAME code that a terminal block carries as
 * `error:true`. Only the structured re-arm counts as recovered; the terminal
 * block stays flow-stopping.
 */
export function captureRetryCodes(output) {
  const codes = new Set();
  for (const event of eventsOf(output)) {
    const part = event.part?.state?.output ?? '';
    if (/"error":true/.test(part)) continue;
    if (!/"reviewRetry"/.test(part)) continue;
    try {
      const parsed = JSON.parse(part);
      const code = parsed?.reviewRetry?.code;
      if (typeof code === 'string') codes.add(code);
    } catch {
      // Not the structured retry projection.
    }
  }
  return [...codes];
}

/** Denials observed in a step that must stop the flow (never recovered in-session). */
export function unexpectedDenialCodes(output) {
  return toolDenialCodes(output).filter((code) => !RECOVERABLE_DENIAL_CODES.has(code));
}

/** The controlled negative probe: exactly the expected denial, nothing else. */
export function assertExpectedDenial(output, expectedCode) {
  const codes = toolDenialCodes(output);
  if (!codes.includes(expectedCode)) {
    throw new Error(`expected denial ${expectedCode}, observed [${codes.join(', ') || 'none'}]`);
  }
  const unexpected = codes.filter((code) => code !== expectedCode);
  if (unexpected.length > 0) {
    throw new Error(`unexpected denial(s) alongside ${expectedCode}: ${unexpected.join(', ')}`);
  }
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
    } else {
      const recovered = [
        ...new Set([
          ...toolDenialCodes(result.stdout).filter((code) => RECOVERABLE_DENIAL_CODES.has(code)),
          ...captureRetryCodes(result.stdout),
        ]),
      ];
      if (recovered.length > 0) {
        session.recoveredDenials = session.recoveredDenials ?? [];
        session.recoveredDenials.push({ step: label, codes: recovered });
        this.log(`${label}: recovered typed denial(s) [${recovered.join(', ')}]`);
      }
      const unexpected = unexpectedDenialCodes(result.stdout);
      if (unexpected.length > 0) {
        // The persisted terminal phase is FlowGuard's outcome authority. When a
        // flow already reached that phase (for example: a reviewer capture was
        // blocked on one obligation and the continuation completed a fresh one),
        // the transport-level block is recorded — never hidden — instead of
        // discarding an already-completed flow. Package verification still runs
        // and fails the flow if the required artifact is absent.
        if (this.reachedFlowTerminal(session)) {
          session.terminalBlocks = session.terminalBlocks ?? [];
          session.terminalBlocks.push({ step: label, codes: unexpected });
          this.log(
            `${label}: terminal block(s) recorded after ${session.terminal} [${unexpected.join(', ')}]`,
          );
        } else {
          throw new Error(
            `${label}: unexpected tool-level block observed (${unexpected.join(', ')}); stopping the flow`,
          );
        }
      }
    }
    return result;
  }

  /**
   * Whether the session already reached its flow's persisted terminal phase.
   * A missing or unreadable state is never treated as terminal.
   */
  reachedFlowTerminal(session) {
    if (typeof session.terminal !== 'string') return false;
    try {
      return this.requireBoundState(session).state.phase === session.terminal;
    } catch {
      return false;
    }
  }

  async approve(session, label, expectedPhase) {
    const snapshot = this.requireBoundState(session);
    if (snapshot.state.phase !== expectedPhase) {
      throw new Error(
        `${label}: expected gate ${expectedPhase}, observed ${String(snapshot.state.phase)}`,
      );
    }
    await this.turn(session, label, 'Demo approval through the real command boundary.', {
      command: 'approve',
    });
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
      workspace: mainWorkspace,
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

  const runner = new Runner(options.root, options, configDir);
  const exitCode = await withRawExportGrant(configDir, async () => {
    const flows = await runFlows(runner);
    for (const name of options.flows) {
      const flow = flows[name];
      const record = { name, workspace: flow.workspace, result: 'BLOCKED' };
      runner.flows.push(record);
      runner.log(`START ${name}`);
      try {
        const session = { workspace: flow.workspace, terminal: flow.terminal };
        await runner.turn(session, `${name}-01-start`, '/start');
        const installed = runner.installedBuild(flow.workspace);
        record.installedBuild = installed;
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
        const snapshot = runner.requireBoundState(session);
        record.phase = snapshot.state.phase;
        record.hostSessionId = session.sessionId;
        record.flowguardSessionId = snapshot.state.flowguardSessionId;
        if (snapshot.state.phase !== flow.terminal) {
          throw new Error(`expected terminal ${flow.terminal}, observed ${snapshot.state.phase}`);
        }
        await runner.captureProvenance(record, session);
        record.packages = session.packages ?? [];
        record.recoveredDenials = session.recoveredDenials ?? [];
        record.terminalBlocks = session.terminalBlocks ?? [];
        record.result = 'COMPLETE';
      } catch (error) {
        record.error = String(error);
        runner.log(`BLOCKED ${name}: ${error}`);
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
  const completed = runner.flows.filter((flow) => flow.result === 'COMPLETE').length;
  runner.log(`MATRIX RESULT: ${completed}/${runner.flows.length} flows COMPLETE`);
  if (exitCode !== 0) {
    runner.log('MATRIX FAILED: at least one flow did not complete');
  }
  process.exitCode = exitCode;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(String(error));
    process.exitCode = 1;
  });
}

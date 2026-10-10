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
 *   gate;
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
    else if (flag === '--flows') options.flows = next().split(',').map((flow) => flow.trim());
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

function tarballFor(options) {
  if (options.tarball) {
    const tarball = path.resolve(options.tarball);
    const sidecar = path.join(path.dirname(tarball), 'checksums.sha256');
    if (!fs.existsSync(tarball)) throw new Error(`tarball not found: ${tarball}`);
    if (!fs.existsSync(sidecar)) {
      throw new Error(`checksums.sha256 is required next to the tarball: ${sidecar}`);
    }
    return { tarball, sidecar, builtFromCheckout: false };
  }
  execFileSync('npm', ['run', 'build'], { cwd: REPO, stdio: 'inherit' });
  execFileSync('npm', ['run', 'pack:checksums'], { cwd: REPO, stdio: 'inherit' });
  const version = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
  const tarball = path.join(REPO, `flowguard-core-${version}.tgz`);
  const sidecar = path.join(REPO, 'checksums.sha256');
  if (!fs.existsSync(tarball)) throw new Error(`pack did not produce ${tarball}`);
  if (!fs.existsSync(sidecar)) throw new Error('pack did not produce checksums.sha256');
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
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
    }, options.timeoutMs ?? 30 * 60_000);
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
  if (typeof boundWorktree !== 'string' || canonicalPath(boundWorktree) !== canonicalPath(workspace)) {
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

function allToolOutputs(result) {
  return eventsOf(result.stdout)
    .map((event) => event.part?.state?.output ?? '')
    .join('\n');
}

class Runner {
  constructor(root, options, configDir) {
    this.options = options;
    this.configDir = configDir;
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
      ...new Set(eventsOf(output).map((event) => event.sessionID).filter(Boolean)),
    ];
    this.log(`${label}: exit=${String(result.code)} time=${Math.round(result.durationMs / 1000)}s`);
    return { ...result, stdout: output, sessionIds };
  }

  async turn(session, label, prompt, options = {}) {
    const args = [
      'run',
      '--dir',
      session.workspace,
      '-m',
      this.options.model,
      '--format',
      'json',
    ];
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
    } else if (/"error":true|"kind":"blocked"/.test(allToolOutputs(result))) {
      throw new Error(`${label}: unexpected tool-level block observed; stopping the flow`);
    }
    return result;
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

  async exportTranscript(label, sessionId, workspace) {
    const result = await run('opencode', ['export', sessionId], {
      cwd: workspace,
      env: { OPENCODE_CONFIG_DIR: this.configDir, OPENCODE_DISABLE_AUTOUPDATE: '1' },
      timeoutMs: 5 * 60_000,
    });
    if (result.timedOut || result.code !== 0 || result.stdout.trim().length === 0) {
      throw new Error(`${label}: host transcript export failed for ${sessionId}`);
    }
    const file = path.join(this.evidenceDir, `${label}-host-${sessionId}.json`);
    if (fs.existsSync(file)) throw new Error(`transcript already exists: ${file}`);
    fs.writeFileSync(file, result.stdout);
    return { sessionId, file: path.relative(this.evidenceDir, file), sha256: sha256(file) };
  }

  async captureProvenance(flow, session) {
    const snapshot = this.requireBoundState(session);
    const targets = transcriptTargets(snapshot.state);
    if (targets.parent !== session.sessionId) {
      throw new Error(`${flow}: persisted host binding is not the observed session`);
    }
    const parent = await this.exportTranscript(flow, targets.parent, session.workspace);
    const reviewers = [];
    for (const childSessionId of targets.reviewers) {
      reviewers.push(await this.exportTranscript(flow, childSessionId, session.workspace));
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
  const first = runner.verifyPackage(session, 'export', 'development', 'EXPORT_READY', 'development');
  await runner.turn(session, 'development-09-archive', '/archive');
  const after = runner.verifyPackage(session, 'export', 'development', 'EXPORT_READY', 'development');
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

async function runFlows(runner) {
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
        await runner.turn(session, 'architecture-04-archive', '/archive redactionMode=none includeRaw=true');
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
        await runner.turn(session, 'peer-review-03-archive', '/archive redactionMode=none includeRaw=true');
        session.packages = [
          runner.verifyPackage(session, 'archive', 'peer-review', 'PEER_REVIEW_COMPLETE', 'peer-review'),
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
          'Resubmit the ADR with one schema-valid architecture claim (statement: "the negative probe boundary is typed", critical: true, authoritySectionId: "decision", requiredReviewEvidence: ["architecture boundary probe"]) and complete the independent review normally.',
        );
        await runner.approve(session, 'architecture-negative-04-approve', 'ARCH_REVIEW');
        await runner.turn(session, 'architecture-negative-05-archive', '/archive redactionMode=none includeRaw=true');
        session.packages = [
          runner.verifyPackage(session, 'archive', 'architecture', 'ARCH_COMPLETE', 'architecture-negative'),
        ];
      },
    },
  };
  return flows;
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

  const checkoutHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
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

  execFileSync(path.join(REPO, 'run-demo-setup.sh'), ['--install', '--tarball', tarball, workspaces], {
    cwd: REPO,
    stdio: 'inherit',
  });

  const globalConfig = path.join(configDir, 'flowguard.json');
  fs.writeFileSync(
    globalConfig,
    JSON.stringify({ schemaVersion: 'v1', archive: { redaction: { allowRawExport: true } } }),
  );

  const runner = new Runner(options.root, options, configDir);
  const flows = await runFlows(runner);
  try {
    for (const name of options.flows) {
      const flow = flows[name];
      const record = { name, workspace: flow.workspace, result: 'BLOCKED' };
      runner.flows.push(record);
      runner.log(`START ${name}`);
      try {
        const session = { workspace: flow.workspace };
        await runner.turn(session, `${name}-01-start`, '/start');
        const installed = runner.installedBuild(flow.workspace);
        record.installedBuild = installed;
        if (builtFromCheckout && installed.gitSha !== checkoutHead) {
          throw new Error(
            `installed artifact gitSha ${String(installed.gitSha)} != checkout ${checkoutHead}`,
          );
        }
        if (flow.preflight) {
          execFileSync(path.join(SCRIPT_DIR, 'run-reduced-ceremony-demo-setup.sh'), flow.preflight, {
            cwd: REPO,
            stdio: 'inherit',
            env: { ...process.env, OPENCODE_CONFIG_DIR: configDir },
          });
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
        record.result = 'COMPLETE';
      } catch (error) {
        record.error = String(error);
        runner.log(`BLOCKED ${name}: ${error}`);
      }
      fs.writeFileSync(path.join(evidenceDir, 'flows.json'), JSON.stringify(runner.flows, null, 2));
      fs.writeFileSync(
        path.join(evidenceDir, 'host-sessions.json'),
        JSON.stringify(
          runner.flows.map(({ name, hostSessionId, flowguardSessionId, transcripts, packages, installedBuild }) => ({
            flow: name,
            hostSessionId: hostSessionId ?? null,
            flowguardSessionId: flowguardSessionId ?? null,
            transcripts: transcripts ?? null,
            packages: packages ?? [],
            installedBuild: installedBuild ?? null,
          })),
          null,
          2,
        ),
      );
    }
  } finally {
    fs.rmSync(globalConfig, { force: true });
    runner.log('raw-export grant removed from the isolated config dir');
  }

  const completed = runner.flows.filter((flow) => flow.result === 'COMPLETE').length;
  runner.log(`MATRIX RESULT: ${completed}/${runner.flows.length} flows COMPLETE`);
  const exitCode = matrixExitCode(runner.flows);
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

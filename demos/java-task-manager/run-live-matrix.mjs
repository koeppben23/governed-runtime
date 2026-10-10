#!/usr/bin/env node
/**
 * @module run-live-matrix
 * @description Reproducible live demo matrix runner for the Java Task Manager
 * demo. It drives the five demo flows plus the architecture negative probe
 * through real headless `opencode run` processes against freshly installed
 * workspaces and records verified evidence per flow.
 *
 * This runner contains NO governance logic and changes no product behavior:
 * - toolchain pins are READ from the canonical repository files
 *   (`src/cli/opencode-runtime-compat.ts` and `.node-version`); no version is
 *   hardcoded here;
 * - every command runs with an explicit `--dir` and a matching `PWD`; the
 *   observed host session is checked against the real persisted runtime state;
 * - the flow stops at the first host failure, tool-level block, missing gate,
 *   or unexpected terminal phase; it never force-advances past a gate;
 * - evidence files are written once per step; a failed run is preserved and a
 *   rerun must use a fresh `--root`;
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

const DEFAULT_FLOWS = [
  'architecture',
  'development',
  'peer-review',
  'reduced-on',
  'reduced-off',
  'architecture-negative',
];

function parseArgs(argv) {
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
function readPins() {
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
    return { tarball, sidecar };
  }
  execFileSync('npm', ['run', 'build'], { cwd: REPO, stdio: 'inherit' });
  execFileSync('npm', ['run', 'pack:checksums'], { cwd: REPO, stdio: 'inherit' });
  const version = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
  const tarball = path.join(REPO, `flowguard-core-${version}.tgz`);
  const sidecar = path.join(REPO, 'checksums.sha256');
  if (!fs.existsSync(tarball)) throw new Error(`pack did not produce ${tarball}`);
  if (!fs.existsSync(sidecar)) throw new Error('pack did not produce checksums.sha256');
  return { tarball, sidecar };
}

function sha256(file) {
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

function eventsOf(output) {
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
  return { state: JSON.parse(fs.readFileSync(found.statePath, 'utf8')), sessionDir: found.sessionDir };
}

function assertHostCallOk(result, label) {
  if (result.timedOut) throw new Error(`${label}: host process timed out`);
  if (result.code !== 0) throw new Error(`${label}: host exit code ${String(result.code)}`);
  const hostErrors = eventsOf(result.stdout).filter((event) => event.type === 'error');
  if (hostErrors.length > 0) throw new Error(`${label}: host error event observed`);
}

function toolOutputs(result) {
  return eventsOf(result.stdout)
    .map((event) => event.part?.state?.output ?? '')
    .join('\n');
}

function assertNoToolBlock(result, label) {
  if (/"error":true|"kind":"blocked"/.test(toolOutputs(result))) {
    throw new Error(`${label}: tool-level block observed; stopping the flow`);
  }
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

  async turn(session, label, prompt, command) {
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
    if (command) args.push('--command', command);
    if (prompt) args.push(prompt);
    const result = await this.hostStep(label, session.workspace, args);
    assertHostCallOk(result, label);
    const observed = result.sessionIds.at(-1);
    if (session.sessionId && observed && observed !== session.sessionId) {
      throw new Error(`${label}: session continuity changed (${observed})`);
    }
    session.sessionId = session.sessionId ?? observed;
    if (!session.sessionId) throw new Error(`${label}: no host session id observed`);
    assertNoToolBlock(result, label);
    return result;
  }

  async approve(session, label, expectedPhase) {
    const snapshot = readState(this.configDir, session.sessionId);
    if (snapshot?.state.phase !== expectedPhase) {
      throw new Error(
        `${label}: expected gate ${expectedPhase}, observed ${String(snapshot?.state.phase)}`,
      );
    }
    await this.turn(session, label, 'Demo approval through the real command boundary.', 'approve');
  }

  verifyPackage(session, kind, flow, phase) {
    const snapshot = readState(this.configDir, session.sessionId);
    if (!snapshot) throw new Error(`${flow}: no persisted state for verification`);
    const archiveDir = path.join(path.dirname(snapshot.sessionDir), 'archive');
    const file =
      kind === 'export'
        ? path.join(archiveDir, `export-${session.sessionId}.tar.gz`)
        : path.join(archiveDir, `${session.sessionId}.tar.gz`);
    if (!fs.existsSync(file)) throw new Error(`${flow}: ${kind} package missing`);
    const verification = execFileSync(
      process.execPath,
      [path.join(SCRIPT_DIR, 'verify-evidence-package.mjs'), file, '--expect-session', session.sessionId, '--expect-flow', flow, '--expect-phase', phase],
      { cwd: REPO, encoding: 'utf8' },
    );
    if (!/result: VERIFIED/.test(verification)) {
      throw new Error(`${flow}: package verification failed`);
    }
    this.log(`${flow}: ${kind} package VERIFIED (${sha256(file).slice(0, 12)}…)`);
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
  runner.verifyPackage(session, 'export', 'development', 'EXPORT_READY');
  await runner.turn(session, 'development-09-archive', '/archive');
  runner.verifyPackage(session, 'export', 'development', 'EXPORT_READY');
}

async function runReduced(runner, session, prefix, ticket) {
  await runner.turn(session, `${prefix}-02-task`, `/task --file ${ticket}`);
  await runner.turn(session, `${prefix}-03-plan`, '/plan');
  await runner.approve(session, `${prefix}-04-approve-plan`, 'PLAN_REVIEW');
  await runner.turn(session, `${prefix}-05-implement`, '/implement');
  await runner.approve(session, `${prefix}-06-approve-impl`, 'EVIDENCE_REVIEW');
  await runner.turn(session, `${prefix}-07-export`, '/export');
  runner.verifyPackage(session, 'export', prefix, 'EXPORT_READY');
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

  const { tarball, sidecar } = tarballFor(options);
  fs.writeFileSync(
    path.join(evidenceDir, 'metadata.json'),
    JSON.stringify(
      {
        startedAt: new Date().toISOString(),
        model: options.model,
        pins,
        tarball,
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
        runner.verifyPackage(session, 'archive', 'architecture', 'ARCH_COMPLETE');
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
        runner.verifyPackage(session, 'archive', 'peer-review', 'PEER_REVIEW_COMPLETE');
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
        await runner.turn(
          session,
          'architecture-negative-02-probe',
          '/architecture First call flowguard_architecture with a minimal ADR and EXACTLY this intentionally plan-shaped claims array: [{"statement":"probe plan-shaped claim","claimScope":"specific_behavior","expectedCheckId":"probe","critical":true}]. It is intentionally invalid. After the typed block, read the recovery guidance and resubmit the same ADR with one schema-valid architecture claim (statement, critical, authoritySectionId: "decision", requiredReviewEvidence: ["architecture boundary probe"]). Complete the independent review normally.',
        );
        await runner.approve(session, 'architecture-negative-03-approve', 'ARCH_REVIEW');
        await runner.turn(session, 'architecture-negative-04-archive', '/archive redactionMode=none includeRaw=true');
        runner.verifyPackage(session, 'archive', 'architecture', 'ARCH_COMPLETE');
      },
    },
  };

  try {
    for (const name of options.flows) {
      const flow = flows[name];
      const record = { name, workspace: flow.workspace, result: 'BLOCKED' };
      runner.flows.push(record);
      runner.log(`START ${name}`);
      try {
        const session = { workspace: flow.workspace };
        await runner.turn(session, `${name}-01-start`, '/start');
        if (flow.preflight) {
          execFileSync(path.join(SCRIPT_DIR, 'run-reduced-ceremony-demo-setup.sh'), flow.preflight, {
            cwd: REPO,
            stdio: 'inherit',
          });
        }
        await flow.run(session);
        const snapshot = readState(configDir, session.sessionId);
        if (!snapshot) throw new Error('no persisted session state');
        record.phase = snapshot.state.phase;
        record.hostSessionId = session.sessionId;
        record.flowguardSessionId = snapshot.state.flowguardSessionId;
        if (snapshot.state.phase !== flow.terminal) {
          throw new Error(`expected terminal ${flow.terminal}, observed ${snapshot.state.phase}`);
        }
        record.result = 'COMPLETE';
      } catch (error) {
        record.error = String(error);
        runner.log(`BLOCKED ${name}: ${error}`);
      }
      fs.writeFileSync(path.join(evidenceDir, 'flows.json'), JSON.stringify(runner.flows, null, 2));
    }
    runner.log('MATRIX FINISHED');
  } finally {
    fs.rmSync(globalConfig, { force: true });
    runner.log('raw-export grant removed from the isolated config dir');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(String(error));
    process.exitCode = 1;
  });
}

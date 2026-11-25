/** Matrix configuration and setup; no workflow or host decision authority. */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(SCRIPT_DIR, '..', '..');

/**
 * The product's canonical ProofGraph contract version, read from the product
 * source the same way the pinned toolchain reads its pins. Recorded so every
 * measurement names the product contract it was produced under.
 */
export function readContractVersion() {
  try {
    const source = fs.readFileSync(
      path.join(REPO, 'src', 'state', 'proofgraph-contract.ts'),
      'utf8',
    );
    return /PROOFGRAPH_CONTRACT_VERSION\s*=\s*'([^']+)'/.exec(source)?.[1] ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

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
    else if (flag === '--evidence-out') options.evidenceOut = path.resolve(next());
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

export function tarballFor(options) {
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

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...(options.env ?? process.env), PWD: options.cwd },
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
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
  });
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
    { flag: 'wx', mode: 0o600 },
  );
  try {
    return await task();
  } finally {
    fs.rmSync(globalConfig, { force: true });
  }
}

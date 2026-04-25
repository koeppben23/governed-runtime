import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const workspaceRoot = process.cwd();
const tmpDir = mkdtempSync(path.join(tmpdir(), 'fg-independent-review-'));
const outputFile = path.join(tmpDir, 'vitest-independent-review.json');

const testFiles = [
  'src/integration/plugin.test.ts',
  'src/integration/tools-execute.test.ts',
  'src/integration/tools/review-validation.test.ts',
];

const mustPassTestTitles = [
  'fulfills strict obligation and mutates output when attestation is valid',
  'accepts when strict evidence and attestation match',
  'blocks when strict attestation is missing',
  'blocks when strict obligation is blocked',
  'Mode B changes_requested keeps selfReviewIteration aligned with next iteration metadata',
];

const testTitleFilter = mustPassTestTitles
  .map((title) => title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

const run = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  [
    'vitest',
    'run',
    ...testFiles,
    '--testNamePattern',
    `(${testTitleFilter})`,
    '--reporter=json',
    `--outputFile=${outputFile}`,
    '--passWithNoTests=false',
  ],
  {
    cwd: workspaceRoot,
    stdio: 'inherit',
    env: { ...process.env, FORCE_COLOR: '0' },
  },
);

if (run.status !== 0) {
  rmSync(tmpDir, { recursive: true, force: true });
  process.exit(run.status ?? 1);
}

let report;
try {
  report = JSON.parse(readFileSync(outputFile, 'utf-8'));
} catch (error) {
  console.error('Failed to parse Vitest JSON report:', error);
  rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
}

const assertionResults = [];
for (const testResult of report.testResults ?? []) {
  for (const assertion of testResult.assertionResults ?? []) {
    assertionResults.push(assertion);
  }
}

const failedRequired = mustPassTestTitles.filter((title) => {
  const match = assertionResults.find((assertion) => assertion.title === title);
  return !match || match.status !== 'passed';
});

if (failedRequired.length > 0) {
  console.error('Independent-review strict verification failed. Required tests missing/pending:');
  for (const title of failedRequired) {
    console.error(` - ${title}`);
  }
  rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
}

function runRequired(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    stdio: 'pipe',
    encoding: 'utf-8',
    env: { ...process.env, FORCE_COLOR: '0' },
    ...options,
  });
  if (result.status !== 0) {
    const rendered = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`Command failed: ${command} ${args.join(' ')}\n${rendered}`);
  }
  return result.stdout.trim();
}

function resolveOpenCodeCommand() {
  const direct = spawnSync('opencode', ['--version'], { stdio: 'pipe', encoding: 'utf-8' });
  if (direct.status === 0) return { command: 'opencode', argsPrefix: [] };
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  runRequired(npx, ['-y', 'opencode-ai', '--version']);
  return { command: npx, argsPrefix: ['-y', 'opencode-ai'] };
}

function waitForOpenCodeServer(proc, timeoutMs) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Timed out waiting for OpenCode server. Output:\n${output}`));
    }, timeoutMs);

    const onData = (chunk) => {
      output += chunk.toString();
      for (const line of output.split('\n')) {
        if (line.startsWith('opencode server listening')) {
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
          if (!match) continue;
          clearTimeout(timer);
          resolve(match[1]);
        }
      }
    };

    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`OpenCode server exited with code ${code}. Output:\n${output}`));
    });
  });
}

function stopOpenCodeServer(proc) {
  if (!proc || proc.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        if (process.platform !== 'win32' && proc.pid) process.kill(-proc.pid, 'SIGKILL');
        else proc.kill('SIGKILL');
      } catch {
        // Process already exited.
      }
      resolve();
    }, 5000);
    proc.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      if (process.platform !== 'win32' && proc.pid) process.kill(-proc.pid, 'SIGTERM');
      else proc.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function verifyOpenCodeRuntimeE2E() {
  const distInstaller = path.join(workspaceRoot, 'dist', 'cli', 'install.js');
  if (!existsSync(distInstaller)) {
    throw new Error(
      'dist/cli/install.js missing. Run npm run build before independent-review e2e.',
    );
  }

  const runtimeDir = mkdtempSync(path.join(tmpdir(), 'fg-independent-review-runtime-'));
  const projectDir = path.join(runtimeDir, 'project');
  const packDir = path.join(runtimeDir, 'pack');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(packDir, { recursive: true });

  let server;
  try {
    writeFileSync(
      path.join(projectDir, 'package.json'),
      JSON.stringify({ name: 'flowguard-independent-review-runtime-e2e', private: true }, null, 2),
    );

    const packOutput = runRequired('npm', ['pack', '--pack-destination', packDir, '--silent']);
    const tarballName = packOutput
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    if (!tarballName) throw new Error(`npm pack did not return a tarball name: ${packOutput}`);

    runRequired(
      process.execPath,
      [
        distInstaller,
        'install',
        '--install-scope',
        'repo',
        '--policy-mode',
        'team-ci',
        '--core-tarball',
        path.join(packDir, tarballName),
        '--force',
      ],
      { cwd: projectDir },
    );
    runRequired('npm', ['install', '--ignore-scripts', '--silent'], { cwd: projectDir });

    const opencodeJson = JSON.parse(readFileSync(path.join(projectDir, 'opencode.json'), 'utf-8'));
    const taskPermission = opencodeJson.agent?.build?.permission?.task;
    if (taskPermission?.['*'] !== 'deny' || taskPermission?.['flowguard-reviewer'] !== 'allow') {
      throw new Error('opencode.json task permissions are not default-deny + reviewer-allow');
    }

    const reviewerAgent = readFileSync(
      path.join(projectDir, '.opencode', 'agents', 'flowguard-reviewer.md'),
      'utf-8',
    );
    if (!reviewerAgent.includes('mode: subagent') || !reviewerAgent.includes('hidden: true')) {
      throw new Error('flowguard-reviewer agent is not installed as hidden subagent');
    }

    const { command, argsPrefix } = resolveOpenCodeCommand();
    const port = 4200 + Math.floor(Math.random() * 1000);
    const serverPassword = 'flowguard-independent-review-e2e';
    server = spawn(command, [...argsPrefix, 'serve', '--hostname=127.0.0.1', `--port=${port}`], {
      cwd: projectDir,
      env: { ...process.env, FORCE_COLOR: '0', OPENCODE_SERVER_PASSWORD: serverPassword },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const baseUrl = await waitForOpenCodeServer(server, 30000);
    const directory = encodeURIComponent(projectDir);
    const authHeaders = {
      Authorization: `Basic ${Buffer.from(`opencode:${serverPassword}`).toString('base64')}`,
    };

    const commands = await fetchJson(`${baseUrl}/command?directory=${directory}`, authHeaders);
    const commandNames = new Set(commands.map((commandInfo) => commandInfo.name ?? commandInfo.id));
    for (const expected of ['plan', 'implement', 'continue']) {
      if (!commandNames.has(expected))
        throw new Error(`OpenCode runtime did not expose /${expected}`);
    }

    const toolIds = await fetchJson(
      `${baseUrl}/experimental/tool/ids?directory=${directory}`,
      authHeaders,
    );
    const ids = Array.isArray(toolIds) ? toolIds : (toolIds.ids ?? []);
    for (const expected of ['flowguard_plan', 'flowguard_implement']) {
      if (!ids.includes(expected)) throw new Error(`OpenCode runtime did not expose ${expected}`);
    }
  } finally {
    await stopOpenCodeServer(server);
    rmSync(runtimeDir, { recursive: true, force: true });
  }
}

await verifyOpenCodeRuntimeE2E();

console.log('Independent-review e2e verification passed.');
rmSync(tmpDir, { recursive: true, force: true });

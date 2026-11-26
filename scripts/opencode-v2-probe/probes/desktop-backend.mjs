#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const outDir =
  process.env.FG_PROBE_OUT ??
  join(process.cwd(), 'scripts/opencode-v2-probe/evidence/desktop-backend');
await mkdir(outDir, { recursive: true });

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 30_000,
    ...options,
  }).trim();
}

function processTable() {
  return run('ps', ['-axo', 'pid=,ppid=,command='])
    .split('\n')
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      return match ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] } : null;
    })
    .filter(Boolean);
}

function ancestors(pid, table) {
  const byPid = new Map(table.map((entry) => [entry.pid, entry]));
  const result = [];
  let current = byPid.get(pid);
  for (let i = 0; i < 8 && current; i++) {
    result.push(current);
    current = byPid.get(current.ppid);
  }
  return result;
}

const result = {
  at: new Date().toISOString(),
  desktop: {},
  sharedService: {},
  serverInfo: null,
  processChain: [],
  sessionsTouched: false,
  passed: false,
};

try {
  result.desktop.version = run('defaults', [
    'read',
    '/Applications/OpenCode.app/Contents/Info.plist',
    'CFBundleShortVersionString',
  ]);
  result.desktop.build = run('defaults', [
    'read',
    '/Applications/OpenCode.app/Contents/Info.plist',
    'CFBundleVersion',
  ]);
  const asar = await readFile('/Applications/OpenCode.app/Contents/Resources/app.asar');
  result.desktop.appAsarSha256 = createHash('sha256').update(asar).digest('hex');
  result.desktop.appAsarBytes = asar.byteLength;
  const codesign = spawnSync('codesign', ['-dv', '--verbose=2', '/Applications/OpenCode.app'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  result.desktop.signature = (codesign.stderr || codesign.stdout || '').trim();
  result.sharedService.status = run('opencode', ['service', 'status']);
  result.serverInfo = JSON.parse(run('opencode', ['api', 'server.info']));
  const table = processTable();
  result.processChain = ancestors(result.serverInfo.pid, table);
  result.serverProcess = table.find((entry) => entry.pid === result.serverInfo.pid) ?? null;
  result.desktopMain = result.processChain.find((entry) =>
    entry.command.includes('/Applications/OpenCode.app/Contents/MacOS/OpenCode'),
  );
  result.desktopBackendCommand = result.serverProcess?.command ?? null;
  result.passed =
    result.desktop.version === result.serverInfo.version &&
    result.desktopBackendCommand?.includes('opencode-cli serve') === true &&
    result.desktopMain !== undefined &&
    result.sessionsTouched === false;
} catch (error) {
  result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
}
await writeFile(join(outDir, 'report.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;

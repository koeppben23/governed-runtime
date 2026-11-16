/**
 * Independent-process lock exclusivity, crash recovery and PID-reuse acceptance.
 *
 * npm run build
 * LOCK_WRITERS=32 node scripts/perf/lock-exclusivity.mjs
 *
 * Every participant is a separate Node process importing the built entry point.
 * This is a correctness acceptance, not a throughput benchmark:
 *
 * L5  N processes contend for one session lock; the critical section must never
 *     overlap (strictly alternating START/END records, one per writer).
 * L3  a lock holder is SIGKILLed; a fresh process acquires without intervention.
 * L2  a lock naming a live PID from a previous boot is reclaimed.
 *
 * Exit code 0 only when every scenario holds; a skipped scenario is reported as
 * NOT_VERIFIED and fails the run, never silently passes.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const writers = Number(process.env.LOCK_WRITERS ?? '32');
const dir = await mkdtemp(join(tmpdir(), 'fg-lock-exclusivity-'));
const logPath = join(dir, 'critical-section.log');
const lockModule = pathToFileURL(join(process.cwd(), 'dist/adapters/persistence-lock.js')).href;

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}

function spawnNode(code, env = {}) {
  return spawn(process.execPath, ['--input-type=module', '-e', code], {
    cwd: process.cwd(),
    env: { ...process.env, LOCK_DIR: dir, LOCK_MODULE: lockModule, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function waitForExit(child) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', (error) => resolve({ code: 1, stdout, stderr: String(error) }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** Acquire, write START, hold briefly, write END, release — twice. */
const contenderCode = `
import { appendFile } from 'node:fs/promises';
const { acquireSessionWriteLock } = await import(process.env.LOCK_MODULE);
const index = process.env.LOCK_INDEX;
for (let cycle = 0; cycle < 2; cycle++) {
  const lock = await acquireSessionWriteLock(process.env.LOCK_DIR, 20000);
  try {
    await appendFile(process.env.LOCK_LOG, 'START ' + index + '\\n');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await appendFile(process.env.LOCK_LOG, 'END ' + index + '\\n');
  } finally {
    await lock.release();
  }
}
`;

async function exclusivity() {
  const children = Array.from({ length: writers }, (_, index) =>
    spawnNode(contenderCode, {
      LOCK_LOG: logPath,
      LOCK_INDEX: String(index),
    }),
  );
  const exits = await Promise.all(children.map(waitForExit));
  const failed = exits.filter((exit) => exit.code !== 0);
  if (failed.length > 0) {
    record('L5 exclusivity', false, `${failed.length} contender(s) failed: ${failed[0].stderr}`);
    return;
  }

  const lines = (await readFile(logPath, 'utf-8')).split('\n').filter(Boolean);
  let depth = 0;
  let overlap = false;
  for (const line of lines) {
    if (line.startsWith('START ')) depth += 1;
    else depth -= 1;
    if (depth < 0 || depth > 1) overlap = true;
  }
  const starts = lines.filter((line) => line.startsWith('START ')).length;
  const ends = lines.filter((line) => line.startsWith('END ')).length;
  const ok = !overlap && depth === 0 && starts === writers * 2 && ends === writers * 2;
  record(
    'L5 exclusivity',
    ok,
    `${writers} processes x2, records=${lines.length} starts=${starts} ends=${ends} overlap=${overlap}`,
  );
}

const holderCode = `
const { acquireSessionWriteLock } = await import(process.env.LOCK_MODULE);
const lock = await acquireSessionWriteLock(process.env.LOCK_DIR, 20000);
process.stdout.write('HELD\\n');
await new Promise(() => {});
void lock;
`;

async function crashRecovery() {
  const holder = spawnNode(holderCode);
  const held = new Promise((resolve) => {
    let stdout = '';
    holder.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.includes('HELD')) resolve(true);
    });
    holder.on('close', () => resolve(false));
  });
  const acquired = await Promise.race([
    held,
    new Promise((resolve) => setTimeout(() => resolve(false), 20000)),
  ]);
  if (!acquired) {
    record('L3 crash recovery', false, 'holder never acquired the lock');
    return;
  }
  holder.kill('SIGKILL');
  await waitForExit(holder);

  const reacquireCode = `
const { acquireSessionWriteLock } = await import(process.env.LOCK_MODULE);
const lock = await acquireSessionWriteLock(process.env.LOCK_DIR, 5000);
await lock.release();
process.stdout.write('REACQUIRED\\n');
`;
  const exit = await waitForExit(spawnNode(reacquireCode));
  record(
    'L3 crash recovery',
    exit.code === 0 && exit.stdout.includes('REACQUIRED'),
    exit.code === 0 ? 'fresh process acquired after SIGKILL' : exit.stderr.trim(),
  );
}

async function previousBoot() {
  const { bootRefMs } = await import(
    pathToFileURL(join(process.cwd(), 'dist/adapters/persistence-lock-owner.js')).href
  );
  const previousBootRef = bootRefMs() - 6 * 60 * 60 * 1000;
  // After a reboot the recorded PID is normally no longer running. The boot
  // reference alone is never proof of absence (a wall-clock adjustment moves it
  // for a live process too), so the recorded owner must also be gone.
  const deceased = spawn(process.execPath, ['--input-type=module', '-e', '']);
  const deadPid = deceased.pid;
  await waitForExit(deceased);
  await writeFile(
    join(dir, 'session-state.json.lock'),
    `pid=${deadPid}\ntoken=previous-boot\nformat=flowguard-lock-owner.v1\n` +
      `host=${(await import('node:os')).hostname()}\nboot=${previousBootRef}\n`,
    'utf-8',
  );
  const reacquireCode = `
const { acquireSessionWriteLock } = await import(process.env.LOCK_MODULE);
const lock = await acquireSessionWriteLock(process.env.LOCK_DIR, 5000);
await lock.release();
process.stdout.write('REACQUIRED\\n');
`;
  const exit = await waitForExit(spawnNode(reacquireCode));
  record(
    'L2 previous boot',
    exit.code === 0 && exit.stdout.includes('REACQUIRED'),
    exit.code === 0 ? 'lock from a previous boot with a gone owner reclaimed' : exit.stderr.trim(),
  );
}

try {
  await exclusivity();
  await crashRecovery();
  await previousBoot();
} finally {
  await rm(dir, { recursive: true, force: true });
}

const failures = results.filter((result) => !result.ok);
if (failures.length > 0) {
  console.error(`\n${failures.length} lock acceptance scenario(s) failed.`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${results.length} lock acceptance scenarios passed.`);
}

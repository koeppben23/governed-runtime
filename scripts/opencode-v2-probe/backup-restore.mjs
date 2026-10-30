#!/usr/bin/env node
/**
 * Phase 0 backup/restore gate.
 *
 * Backs up the operator's config, state, small data files and the SQLite
 * database, then restores them into a fresh temporary root and proves the
 * restored database is readable. The backup root is deliberately outside the
 * repository; only hashes, sizes and integrity facts are printed.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const binary = process.env.OPENCODE_CLI ?? 'opencode';

function paths() {
  const output = execFileSync(binary, ['debug', 'paths'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  const result = {};
  for (const line of output.split('\n')) {
    const match = line.match(/^(\w+)\s+(.+)$/);
    if (match) result[match[1]] = match[2].trim();
  }
  return result;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function copyIfExists(source, target) {
  if (!(await exists(source))) return false;
  await cp(source, target, { recursive: true, force: true, errorOnExist: false });
  return true;
}

function sqlite(path, sql) {
  return execFileSync('sqlite3', [path, sql], {
    encoding: 'utf8',
    timeout: 600_000,
  }).trim();
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function hashTree(root) {
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const bytes = await readFile(full);
        files.push({
          path: full.slice(root.length + 1),
          bytes: bytes.byteLength,
          sha256: sha256(bytes),
        });
      }
    }
  }
  if (await exists(root)) await walk(root);
  return files;
}

const live = paths();
const backupRoot = await mkdtemp(join(tmpdir(), 'fg-oc-v2-backup-'));
const restoreRoot = await mkdtemp(join(tmpdir(), 'fg-oc-v2-restore-'));
const reportPath = process.env.FG_PROBE_BACKUP_REPORT;
const report = {
  at: new Date().toISOString(),
  binary,
  version: execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 30_000 }).trim(),
  live,
  backupRoot,
  restoreRoot,
  copied: [],
  integrity: {},
  warnings: [],
};

try {
  const backupConfig = join(backupRoot, 'config');
  const backupState = join(backupRoot, 'state');
  const backupData = join(backupRoot, 'data');
  const backupDb = join(backupRoot, 'opencode.db');
  await mkdir(backupConfig, { recursive: true });
  await mkdir(backupState, { recursive: true });
  await mkdir(backupData, { recursive: true });

  if (await copyIfExists(live.config, backupConfig)) report.copied.push('config');
  else report.warnings.push(`config path missing: ${live.config}`);
  if (await copyIfExists(live.state, backupState)) report.copied.push('state');
  else report.warnings.push(`state path missing: ${live.state}`);

  // Credentials and small metadata live beside the DB; snapshots, caches and
  // tool output are deliberately excluded from the restore probe.
  if (await exists(live.data)) {
    for (const entry of await readdir(live.data, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (/\.(db|db-wal|db-shm)$/.test(entry.name)) continue;
      await cp(join(live.data, entry.name), join(backupData, entry.name));
    }
    report.copied.push('data small files');
  }

  if (live.db && (await exists(live.db))) {
    sqlite(live.db, `.backup '${backupDb}'`);
    report.backupDbBytes = Number((await stat(backupDb)).size);
    report.liveDbBytes = Number((await stat(live.db)).size);
    report.integrity.backup = sqlite(backupDb, 'PRAGMA integrity_check;');
    report.integrity.liveTableCount = sqlite(
      live.db,
      "select count(*) from sqlite_master where type='table';",
    );
  } else {
    report.warnings.push(`database path missing or unset: ${live.db}`);
  }

  const restoreConfig = join(restoreRoot, 'config');
  const restoreState = join(restoreRoot, 'state');
  const restoreData = join(restoreRoot, 'data');
  const restoreDb = join(restoreRoot, 'opencode.db');
  await mkdir(restoreConfig, { recursive: true });
  await mkdir(restoreState, { recursive: true });
  await mkdir(restoreData, { recursive: true });
  if (report.copied.includes('config')) await cp(backupConfig, restoreConfig, { recursive: true });
  if (report.copied.includes('state')) await cp(backupState, restoreState, { recursive: true });
  await cp(backupData, restoreData, { recursive: true });
  if (report.backupDbBytes !== undefined) {
    await cp(backupDb, restoreDb);
    report.integrity.restore = sqlite(restoreDb, 'PRAGMA integrity_check;');
    report.integrity.restoredTableCount = sqlite(
      restoreDb,
      "select count(*) from sqlite_master where type='table';",
    );
    report.integrity.restoredUserTable = sqlite(
      restoreDb,
      "select name from sqlite_master where type='table' and name like '%session%' order by name limit 5;",
    );
  }

  report.configHashes = await hashTree(backupConfig);
  report.stateHashes = await hashTree(backupState);
  report.passed =
    report.integrity.backup === 'ok' &&
    (report.integrity.restore === undefined || report.integrity.restore === 'ok') &&
    (report.integrity.liveTableCount === undefined ||
      report.integrity.liveTableCount === report.integrity.restoredTableCount);
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  report.passed = false;
}

if (reportPath) {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
}
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;

// Keep the backup and restored copy for operator inspection only when asked.
if (process.env.FG_PROBE_KEEP_BACKUP !== '1') {
  await rm(backupRoot, { recursive: true, force: true });
  await rm(restoreRoot, { recursive: true, force: true });
}

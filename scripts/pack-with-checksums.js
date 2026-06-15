#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const result = spawnSync('npm', ['pack', '--silent'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
});

if (result.error) {
  console.error(`[pack:checksums] failed to run npm pack: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  console.error(`[pack:checksums] npm pack failed with exit code ${result.status ?? 'unknown'}`);
  process.exit(result.status ?? 1);
}

const tarball = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);

if (!tarball) {
  console.error('[pack:checksums] npm pack did not report a tarball path');
  process.exit(1);
}

const tarballPath = resolve(process.cwd(), tarball);
const bytes = await readFile(tarballPath);
const hash = createHash('sha256').update(bytes).digest('hex');
const checksumsPath = resolve(process.cwd(), 'checksums.sha256');

await writeFile(checksumsPath, `${hash}  ${basename(tarballPath)}\n`, 'utf8');

console.log(tarball);
console.log('checksums.sha256');

#!/usr/bin/env node
/**
 * @module demos/lib/environment-gate
 * @description Phase 0 dry run for the live demos: pins, npm compatibility
 * (including a real canary install under engine-strict), isolation, roots,
 * artifact integrity and an optional provider round trip. Writes an
 * environment manifest that separates the harness revision from the product
 * artifact. Fails closed before the first LLM-backed flow.
 *
 * Usage:
 *   node demos/lib/environment-gate.mjs --root <run-root> --repo <checkout> [options]
 *
 * Options:
 *   --model <id>          Model for the optional provider ping.
 *   --tarball <path>      Product tarball (+ checksums.sha256) to verify/canary.
 *   --canary-install      Install the tarball into a throwaway prefix.
 *   --skip-provider-ping  Do not call the provider.
 *
 * @version v1
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMainModule } from './is-main-module.mjs';

function parseArgs(argv) {
  const options = { canaryInstall: false, providerPing: true };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
      index += 1;
      return value;
    };
    if (flag === '--root') options.root = path.resolve(next());
    else if (flag === '--repo') options.repo = path.resolve(next());
    else if (flag === '--model') options.model = next();
    else if (flag === '--tarball') options.tarball = path.resolve(next());
    else if (flag === '--canary-install') options.canaryInstall = true;
    else if (flag === '--skip-provider-ping') options.providerPing = false;
    else throw new Error(`unknown option: ${flag}`);
  }
  if (!options.root) throw new Error('--root <run-root> is required');
  if (!options.repo) throw new Error('--repo <checkout> is required');
  options.model ??= 'deepseek/deepseek-flash';
  return options;
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function npmMajor(version) {
  const match = /^(\d+)\./.exec(String(version).trim());
  return match ? Number(match[1]) : null;
}

export function npmSatisfies(actual, range) {
  const major = npmMajor(actual);
  if (major === null) return false;
  const required = /\^(\d+)/.exec(String(range));
  if (!required) return false;
  return major === Number(required[1]);
}

function verifyChecksumSidecar(tarball) {
  const sidecar = path.join(path.dirname(tarball), 'checksums.sha256');
  if (!fs.existsSync(sidecar)) throw new Error(`checksums.sha256 missing next to ${tarball}`);
  const match = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(fs.readFileSync(sidecar, 'utf8').trim());
  if (!match) throw new Error(`checksums.sha256 is malformed: ${sidecar}`);
  const observed = sha256(tarball);
  if (observed !== match[1]) {
    throw new Error(`tarball digest ${observed} != sidecar ${match[1]}`);
  }
  return observed;
}

function runningDemoProcesses() {
  try {
    const output = execFileSync(
      'pgrep',
      ['-f', 'run-live-(matrix|claim-controls|risk-trigger-controls|replan-recovery)'],
      {
        encoding: 'utf8',
      },
    );
    return output
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  } catch {
    return [];
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = { checks: [], warnings: [] };
  const check = (name, ok, detail) => {
    report.checks.push({ name, ok: Boolean(ok), detail: detail ?? null });
    if (!ok) throw new Error(`environment gate failed: ${name}${detail ? ` (${detail})` : ''}`);
  };

  const packageJson = JSON.parse(fs.readFileSync(path.join(options.repo, 'package.json'), 'utf8'));
  const nodePin = fs.readFileSync(path.join(options.repo, '.node-version'), 'utf8').trim();
  check('node pin', process.versions.node === nodePin, `observed ${process.versions.node}`);
  const compat = fs.readFileSync(
    path.join(options.repo, 'src', 'cli', 'opencode-runtime-compat.ts'),
    'utf8',
  );
  const hostPin = /TESTED_OPENCODE_HOST_VERSION = '([^']+)'/.exec(compat)?.[1];
  const opencodeVersion = execFileSync('opencode', ['--version'], { encoding: 'utf8' }).trim();
  check('opencode pin', opencodeVersion === hostPin, `observed ${opencodeVersion}`);
  const npmVersion = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
  check(
    'npm compatibility',
    npmSatisfies(npmVersion, packageJson.engines?.npm ?? '^10'),
    `observed npm ${npmVersion} requires ${String(packageJson.engines?.npm)}`,
  );
  check(
    'java availability',
    (() => {
      try {
        execFileSync('java', ['-version'], { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    })(),
    null,
  );
  const checkoutHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: options.repo,
    encoding: 'utf8',
  }).trim();
  check('run root is fresh', !fs.existsSync(options.root), options.root);
  const concurrent = runningDemoProcesses();
  check('no concurrent demo run', concurrent.length === 0, concurrent.join(','));

  let product = null;
  if (options.tarball) {
    const digest = verifyChecksumSidecar(options.tarball);
    product = { tarball: options.tarball, sha256: digest };
    if (options.canaryInstall) {
      const canary = fs.mkdtempSync(path.join(os.tmpdir(), 'flowguard-gate-canary-'));
      try {
        execFileSync(
          'npm',
          ['install', '--prefix', canary, '--no-audit', '--no-fund', options.tarball],
          {
            stdio: 'pipe',
          },
        );
      } finally {
        fs.rmSync(canary, { recursive: true, force: true });
      }
      check('canary install', true, 'npm engine-strict install succeeded');
    }
  }

  fs.mkdirSync(options.root, { recursive: true });
  const configDir = path.join(options.root, 'gate-config');
  fs.mkdirSync(configDir, { recursive: true });
  if (options.providerPing) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowguard-gate-ping-'));
    try {
      const output = execFileSync(
        'opencode',
        [
          'run',
          '--dir',
          dir,
          '-m',
          options.model,
          '--format',
          'json',
          'Reply with the single word OK.',
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, OPENCODE_CONFIG_DIR: configDir, OPENCODE_DISABLE_AUTOUPDATE: '1' },
          timeout: 120_000,
        },
      );
      check('provider ping', /OK/.test(output), `model ${options.model}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    model: options.model,
    harness: { repo: options.repo, checkoutHead },
    toolchain: { node: process.versions.node, npm: npmVersion, opencode: opencodeVersion },
    product,
    root: options.root,
  };
  const manifestPath = path.join(options.root, 'environment-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`[environment-gate] OK; manifest written to ${manifestPath}`);
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`[environment-gate] ${String(error)}`);
    process.exitCode = 1;
  }
}

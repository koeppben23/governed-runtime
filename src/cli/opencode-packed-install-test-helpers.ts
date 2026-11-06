/** Real packed CLI/install bytes for native-host tests; never seeds governance. */
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashBuffer } from '../shared/hashing.js';

export async function createPackedFlowGuardInstall() {
  const npmCLI = process.env.npm_execpath;
  if (!npmCLI) throw new Error('npm_execpath is required to run packed installation tests');
  const root = await mkdtemp(join(tmpdir(), 'fg-packed-parity-'));
  // CI retains this directory outside the disposable installation, including on timeout.
  const diagnosticsRoot = resolve(process.env.FLOWGUARD_BOOTSTRAP_DIAGNOSTICS_DIR ?? root);
  await mkdir(diagnosticsRoot, { recursive: true });
  const diagnostics = await mkdtemp(join(diagnosticsRoot, 'bootstrap-'));
  const began = performance.now();
  const checkpoint = (stage: string, detail: Record<string, unknown> = {}) => {
    const event = {
      stage,
      timestamp: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - began),
      workerPID: process.pid,
      root,
      diagnostics,
      ...detail,
    };
    appendFileSync(join(diagnostics, 'phases.jsonl'), `${JSON.stringify(event)}\n`);
    console.info('inactive-parity-bootstrap', JSON.stringify(event));
  };
  let stage = 'tarball';
  try {
    checkpoint('tarball-begin', { node: process.version, npmCLI });
    let tarball: string;
    if (process.env.FLOWGUARD_TARBALL) {
      const supplied = resolve(process.env.FLOWGUARD_TARBALL);
      tarball = join(root, basename(supplied));
      await copyFile(supplied, tarball);
      await copyFile(join(dirname(supplied), 'checksums.sha256'), join(root, 'checksums.sha256'));
    } else {
      const packed = JSON.parse(
        execFileSync(
          process.execPath,
          [npmCLI, 'pack', '--json', '--ignore-scripts', '--pack-destination', root],
          {
            cwd: fileURLToPath(new URL('../..', import.meta.url)),
            encoding: 'utf8',
            timeout: 60_000,
          },
        ),
      ) as Array<{ filename: string }>;
      if (!packed[0]) throw new Error('npm pack returned no artifact');
      tarball = join(root, packed[0].filename);
      await writeFile(
        join(root, 'checksums.sha256'),
        `${hashBuffer(await readFile(tarball))}  ${basename(tarball)}\n`,
      );
    }
    const sha256 = hashBuffer(await readFile(tarball));
    checkpoint('tarball-ready', { file: basename(tarball), sha256 });
    // The CI job serializes both suites and shares one digest-bound bootstrap.
    // Never use this prefix for concurrent test files.
    const sharedBootstrap = process.env.FLOWGUARD_BOOTSTRAP_PREFIX
      ? resolve(process.env.FLOWGUARD_BOOTSTRAP_PREFIX)
      : undefined;
    const bootstrap = sharedBootstrap ?? join(root, 'bootstrap');
    const marker = sharedBootstrap ? join(sharedBootstrap, 'bootstrap-identity.json') : undefined;
    let reused = false;
    if (marker) {
      try {
        const prior = JSON.parse(await readFile(marker, 'utf8')) as {
          file?: unknown;
          sha256?: unknown;
        };
        reused =
          prior.file === basename(tarball) &&
          prior.sha256 === sha256 &&
          existsSync(join(bootstrap, 'node_modules/@flowguard/core/dist/build-info.json'));
      } catch {
        reused = false;
      }
    }
    if (reused) {
      checkpoint('bootstrap-reused', { bootstrap, marker });
    } else {
      if (sharedBootstrap) {
        await rm(bootstrap, { recursive: true, force: true });
        await mkdir(sharedBootstrap, { recursive: true });
      }
      stage = 'npm-install';
      checkpoint('npm-install-begin', {
        timeoutMs: 300_000,
        bootstrap,
        // Keep the shared cache and dependency selection unchanged; reuse is
        // opt-in and requires the CI job's serialized execution.
        configuredCache: process.env.npm_config_cache ?? process.env.NPM_CONFIG_CACHE ?? null,
      });
      // Keep synchronous execution and piped stdio, as in the original execFileSync.
      // spawnSync additionally exposes PID/status/signal on successful completion.
      const result = spawnSync(
        process.execPath,
        [
          npmCLI,
          'install',
          '--prefix',
          bootstrap,
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--loglevel=verbose',
          `--logs-dir=${join(diagnostics, 'npm-debug')}`,
          tarball,
        ],
        { cwd: root, encoding: 'utf8', timeout: 300_000 },
      );
      writeFileSync(join(diagnostics, 'npm.stdout.log'), result.stdout ?? '');
      writeFileSync(join(diagnostics, 'npm.stderr.log'), result.stderr ?? '');
      checkpoint('npm-install-end', {
        npmPID: result.pid,
        status: result.status,
        signal: result.signal,
        error: result.error
          ? {
              code: (result.error as NodeJS.ErrnoException).code,
              name: result.error.name,
              message: result.error.message,
            }
          : null,
      });
      if (result.error) throw result.error;
      if (result.status !== 0)
        throw Object.assign(new Error(`Packed npm bootstrap failed; see ${diagnostics}`), {
          status: result.status,
          signal: result.signal,
        });
    }
    stage = 'identity';
    const packedRoot = join(bootstrap, 'node_modules/@flowguard/core');
    const identity = {
      file: basename(tarball),
      sha256,
      build: JSON.parse(
        await readFile(join(packedRoot, 'dist/build-info.json'), 'utf8'),
      ) as unknown,
    };
    checkpoint('identity-ready', { identity });
    console.info('inactive-parity-artifact', JSON.stringify(identity));
    if (marker && !reused) {
      const pending = `${marker}.${process.pid}.tmp`;
      await writeFile(pending, `${JSON.stringify({ file: basename(tarball), sha256 })}\n`);
      await rename(pending, marker);
    }
    return {
      identity,
      async install(project: string, env: NodeJS.ProcessEnv, scope: 'repo' | 'global' = 'repo') {
        const installerDiagnostics = join(
          diagnostics,
          `installer-${scope}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        );
        await mkdir(installerDiagnostics, { recursive: true });
        // Observe the real installer's package-manager calls, including its 5s
        // detection probes. Do not replace detection or retry/extend any call.
        const preload = join(installerDiagnostics, 'observe-installer.cjs');
        await writeFile(
          preload,
          `const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const log = ${JSON.stringify(join(installerDiagnostics, 'subprocesses.jsonl'))};
const environment = env => Object.fromEntries(Object.entries(env).filter(([key]) =>
  /^(path|pathext|comspec|systemroot|home|userprofile|appdata|localappdata|npm_execpath|npm_config_cache)$/i.test(key)));
const record = (stage, detail = {}) => fs.appendFileSync(log, JSON.stringify({
  stage, timestamp: new Date().toISOString(), pid: process.pid, ppid: process.ppid, ...detail
}) + '\\n');
const failure = error => ({ name: error.name, message: error.message,
  code: error.code, status: error.status, signal: error.signal });
const candidates = Object.entries(process.env).filter(([key]) => /^path$/i.test(key))
  .flatMap(([key, value]) => value.split(path.delimiter).flatMap(directory =>
    ['npm', 'bun'].flatMap(name => (process.platform === 'win32'
      ? ['', ...(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')] : [''])
      .map(ext => path.join(directory.replace(/^"|"$/g, ''), name + ext))
      .filter(file => fs.existsSync(file)).map(file => ({ key, file })))));
record('process-start', { argv: process.argv, cwd: process.cwd(),
  environment: environment(process.env), candidates });
for (const method of ['execSync', 'execFileSync']) {
  const original = cp[method];
  cp[method] = function (...args) {
    const options = args.findLast(arg => arg && typeof arg === 'object' && !Array.isArray(arg)) || {};
    const began = performance.now();
    record('command-begin', { method, command: args[0], args: Array.isArray(args[1]) ? args[1] : [],
      cwd: options.cwd || process.cwd(), timeoutMs: options.timeout,
      environment: environment(options.env || process.env) });
    try {
      const result = original.apply(this, args);
      record('command-end', { method, command: args[0], elapsedMs: Math.round(performance.now() - began),
        status: 0 });
      return result;
    } catch (error) {
      record('command-end', { method, command: args[0], elapsedMs: Math.round(performance.now() - began),
        error: failure(error) });
      throw error;
    }
  };
}
require('node:module').syncBuiltinESMExports();
process.on('exit', code => record('process-exit', { code }));
`,
        );
        const installerEnv = {
          ...env,
          FLOWGUARD_INSTALL_LOCK_PATH: join(project, '.install.lock'),
          npm_config_loglevel: 'verbose',
          npm_config_logs_dir: installerDiagnostics,
          npm_config_timing: 'true',
          NODE_OPTIONS: [env.NODE_OPTIONS, `--require ${JSON.stringify(preload)}`]
            .filter(Boolean)
            .join(' '),
        };
        checkpoint('installer-begin', {
          project,
          git: existsSync(join(project, '.git')),
          scope,
          installerDiagnostics,
          timeoutMs: 300_000,
        });
        const installBegan = performance.now();
        const result = spawnSync(
          process.execPath,
          [
            join(packedRoot, 'dist/cli/install.js'),
            'install',
            '--install-scope',
            scope,
            '--core-tarball',
            tarball,
          ],
          {
            cwd: project,
            env: installerEnv,
            encoding: 'utf8',
            timeout: 300_000,
          },
        );
        writeFileSync(join(installerDiagnostics, 'installer.stdout.log'), result.stdout ?? '');
        writeFileSync(join(installerDiagnostics, 'installer.stderr.log'), result.stderr ?? '');
        checkpoint('installer-end', {
          project,
          scope,
          installerDiagnostics,
          durationMs: Math.round(performance.now() - installBegan),
          installerPID: result.pid,
          status: result.status,
          signal: result.signal,
          error: result.error
            ? { code: (result.error as NodeJS.ErrnoException).code, message: result.error.message }
            : null,
        });
        if (result.error) throw result.error;
        if (result.status !== 0)
          throw Object.assign(new Error(`Packed installer failed; see ${installerDiagnostics}`), {
            status: result.status,
            signal: result.signal,
            stdout: result.stdout,
            stderr: result.stderr,
          });
        const target = scope === 'repo' ? join(project, '.opencode') : env.OPENCODE_CONFIG_DIR;
        if (!target) throw new Error('No isolated OpenCode install target');
        const installed = join(target, 'node_modules/@flowguard/core');
        if (
          (await readFile(join(installed, 'dist/integration/plugin.js'), 'utf8')) !==
          (await readFile(join(packedRoot, 'dist/integration/plugin.js'), 'utf8'))
        )
          throw new Error('Installed plugin differs from the packed bootstrap bytes');
        checkpoint('installer-verified', { project, scope, installerDiagnostics });
        return result.stdout;
      },
      close: () => rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }),
    };
  } catch (error) {
    checkpoint('bootstrap-failed', {
      failedStage: stage,
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
    });
    await rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
    throw error;
  }
}

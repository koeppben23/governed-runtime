/** Real packed CLI/install bytes for native-host tests; never seeds governance. */
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    const bootstrap = join(root, 'bootstrap');
    stage = 'npm-install';
    checkpoint('npm-install-begin', {
      timeoutMs: 300_000,
      bootstrap,
      // Do not change or isolate the shared cache while testing the contention hypothesis.
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
    return {
      identity,
      async install(project: string, env: NodeJS.ProcessEnv, scope: 'repo' | 'global' = 'repo') {
        const output = execFileSync(
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
            env: { ...env, FLOWGUARD_INSTALL_LOCK_PATH: join(project, '.install.lock') },
            encoding: 'utf8',
            timeout: 300_000,
          },
        );
        const target = scope === 'repo' ? join(project, '.opencode') : env.OPENCODE_CONFIG_DIR;
        if (!target) throw new Error('No isolated OpenCode install target');
        const installed = join(target, 'node_modules/@flowguard/core');
        if (
          (await readFile(join(installed, 'dist/integration/plugin.js'), 'utf8')) !==
          (await readFile(join(packedRoot, 'dist/integration/plugin.js'), 'utf8'))
        )
          throw new Error('Installed plugin differs from the packed bootstrap bytes');
        return output;
      },
      close: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    checkpoint('bootstrap-failed', {
      failedStage: stage,
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
    });
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

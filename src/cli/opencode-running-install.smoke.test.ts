/** Install into an already-running pinned host, not a cold-start substitute.
 * The npm barrier delays real installation; it never fabricates installed bytes. */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenCode } from '@opencode/client';
import { hashBuffer } from '../shared/hashing.js';
import { resolveSessionAuthority } from '../adapters/session-authority.js';
import { withTestEnv } from '../integration/test-helpers.js';
import { awaitLocationActivation } from './opencode-native-test-helpers.js';
import { resolvePinnedOpenCodeHost } from './opencode-live-host-test-helpers.js';
import { PLUGIN_RELATIVE_PATH } from './templates.js';

const LIVE = process.env.OPENCODE_LIVE === '1' || process.env.FLOWGUARD_OPENCODE_HOST_E2E === '1';
const REPO = fileURLToPath(new URL('../..', import.meta.url));
let root: string | undefined;
const children: ChildProcess[] = [];
let hostOutput = '';
let restore: (() => void) | undefined;

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((done) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    child.once('close', () => {
      clearTimeout(timer);
      done();
    });
    child.kill('SIGTERM');
  });
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(stop));
  restore?.();
  restore = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
  hostOutput = '';
});

describe.skipIf(!LIVE || process.platform === 'win32')(
  'install on an already-running native host',
  () => {
    it.each(['repo', 'global'] as const)(
      'publishes %s code after real dependencies and activates native /start without a host restart',
      async (scope) => {
        root = await mkdtemp(join(tmpdir(), 'fg-running-install-'));
        const project = join(root, 'project');
        const config = join(root, 'config');
        const bin = join(root, 'bin');
        for (const dir of [project, config, bin]) await mkdir(dir);
        execFileSync('git', ['init', '--quiet', project]);
        await writeFile(join(config, 'opencode.json'), '{"update":"disable"}\n');
        const pinned = resolvePinnedOpenCodeHost();
        const env = {
          ...process.env,
          ...pinned.env,
          PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
          HOME: root,
          USERPROFILE: root,
          OPENCODE_CONFIG_DIR: config,
          XDG_CONFIG_HOME: join(root, 'xdg-config'),
          XDG_DATA_HOME: join(root, 'data'),
          XDG_STATE_HOME: join(root, 'state'),
          XDG_CACHE_HOME: join(root, 'cache'),
          TMPDIR: root,
          OPENCODE_PASSWORD: 'running-install-test-only',
          FLOWGUARD_INSTALL_LOCK_PATH: join(root, 'install.lock'),
        };
        expect(
          execFileSync(pinned.command, [...pinned.argsPrefix, '--version'], {
            env,
            encoding: 'utf8',
            timeout: 30_000,
          }).trim(),
        ).toBe(pinned.version);
        let tarball: string;
        if (process.env.FLOWGUARD_TARBALL) {
          const supplied = resolve(process.env.FLOWGUARD_TARBALL);
          tarball = join(root, basename(supplied));
          await copyFile(supplied, tarball);
          await copyFile(
            join(dirname(supplied), 'checksums.sha256'),
            join(root, 'checksums.sha256'),
          );
        } else {
          const packed = JSON.parse(
            execFileSync(
              'npm',
              ['pack', '--json', '--ignore-scripts', '--pack-destination', root],
              { cwd: REPO, env, encoding: 'utf8', timeout: 60_000 },
            ),
          ) as Array<{ filename: string }>;
          tarball = join(root, packed[0]!.filename);
          await writeFile(
            join(root, 'checksums.sha256'),
            `${hashBuffer(await readFile(tarball))}  ${basename(tarball)}\n`,
          );
        }
        const bootstrap = join(root, 'bootstrap');
        execFileSync(
          'npm',
          [
            'install',
            '--prefix',
            bootstrap,
            '--ignore-scripts',
            '--no-audit',
            '--no-fund',
            tarball,
          ],
          { cwd: root, env, encoding: 'utf8', timeout: 300_000 },
        );
        const packageRoot = join(bootstrap, 'node_modules/@flowguard/core');
        console.info(
          'running-install-artifact',
          JSON.stringify({
            scope,
            sha256: hashBuffer(await readFile(tarball)),
            build: JSON.parse(await readFile(join(packageRoot, 'dist/build-info.json'), 'utf8')),
          }),
        );
        const host = spawn(
          pinned.command,
          [...pinned.argsPrefix, 'serve', '--hostname=127.0.0.1', '--port=0'],
          { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        children.push(host);
        const baseUrl = await new Promise<string>((done, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`Host startup timed out: ${hostOutput}`)),
            60_000,
          );
          const receive = (chunk: Buffer) => {
            hostOutput += chunk.toString();
            const match = hostOutput.match(/listening on\s+(https?:\/\/\S+)/);
            if (match) {
              clearTimeout(timer);
              done(match[1]!);
            }
          };
          host.stdout?.on('data', receive);
          host.stderr?.on('data', receive);
          host.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
          });
          host.once('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`Host exited ${code}: ${hostOutput}`));
          });
        });
        const client = OpenCode.make({
          baseUrl,
          headers: {
            Authorization: `Basic ${Buffer.from('opencode:running-install-test-only').toString('base64')}`,
          },
        });
        const location = { directory: project };
        await awaitLocationActivation(client, location);
        expect(
          (await client.plugin.list({ location })).data.some((plugin) => plugin.id === 'flowguard'),
        ).toBe(false);

        const entered = join(root, 'npm-entered');
        const resume = join(root, 'npm-resume');
        const npmCLI = process.env.npm_execpath;
        if (!npmCLI) throw new Error('npm_execpath is required for the real npm barrier');
        await writeFile(
          join(bin, 'npm'),
          `#!/usr/bin/env node
const fs = require('node:fs'), cp = require('node:child_process');
if (process.argv[2] === 'install') {
  fs.writeFileSync(${JSON.stringify(entered)}, 'paused');
  const wait = new Int32Array(new SharedArrayBuffer(4)), deadline = Date.now() + 120000;
  while (!fs.existsSync(${JSON.stringify(resume)})) {
    if (Date.now() > deadline) process.exit(97);
    Atomics.wait(wait, 0, 0, 25);
  }
}
const result = cp.spawnSync(process.execPath, [${JSON.stringify(npmCLI)}, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
process.exit(result.status ?? 98);
`,
          { mode: 0o755 },
        );
        // Select npm deterministically, even on CI machines that also provide bun.
        await writeFile(join(bin, 'bun'), '#!/usr/bin/env node\nprocess.exit(1);\n', {
          mode: 0o755,
        });
        const installer = spawn(
          process.execPath,
          [
            join(packageRoot, 'dist/cli/install.js'),
            'install',
            '--install-scope',
            scope,
            '--core-tarball',
            tarball,
          ],
          {
            cwd: project,
            env: { ...env, PATH: `${bin}:${env.PATH}` },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        children.push(installer);
        let installOutput = '';
        installer.stdout?.on('data', (chunk) => (installOutput += chunk.toString()));
        installer.stderr?.on('data', (chunk) => (installOutput += chunk.toString()));
        const installed = new Promise<number | null>((done) =>
          installer.once('close', (code) => done(code)),
        );
        const target = scope === 'repo' ? join(project, '.opencode') : config;
        let installCode: number | null;
        try {
          await expect.poll(() => existsSync(entered), { timeout: 30_000 }).toBe(true);
          expect(
            existsSync(join(target, PLUGIN_RELATIVE_PATH)),
            'entrypoint must not be discoverable during dependency staging',
          ).toBe(false);
          await awaitLocationActivation(client, location);
          const staging = await client.plugin.list({ location });
          expect(
            staging.data.filter((plugin) => plugin.state.status !== 'active'),
            JSON.stringify(staging),
          ).toEqual([]);
        } finally {
          await writeFile(resume, 'go');
          installCode = await installed;
        }
        expect(installCode, installOutput).toBe(0);
        await client.location.reload();
        await awaitLocationActivation(client, location);
        const plugins = await client.plugin.list({ location });
        expect(
          plugins.data.filter((plugin) => plugin.id === 'flowguard'),
          `${JSON.stringify(plugins)}\n${hostOutput}`,
        ).toHaveLength(1);
        expect(
          plugins.data.filter((plugin) => plugin.state.status !== 'active'),
          JSON.stringify(plugins),
        ).toEqual([]);
        const commands = await client.command.list({ location });
        expect(commands.data.map((command) => command.name)).toContain('start');
        expect(existsSync(join(target, 'commands/start.md'))).toBe(false);
        const session = await client.session.create({
          title: 'Installed native activation',
          location,
        });
        await client.session.command({ sessionID: session.id, name: 'start', text: '' });
        await client.session.wait(
          { sessionID: session.id },
          { signal: AbortSignal.timeout(120_000) },
        );
        restore = withTestEnv({ OPENCODE_CONFIG_DIR: config });
        const authority = await resolveSessionAuthority({ root: project, sessionId: session.id });
        expect(authority.status, JSON.stringify(authority)).toBe('resolved');
        const report =
          JSON.stringify(await client.session.context({ sessionID: session.id })) +
          JSON.stringify(await client.session.inbox.list({ sessionID: session.id }));
        expect(report).toContain('FlowGuard governance is ACTIVE');
        expect(host.exitCode).toBeNull();
      },
      420_000,
    );
  },
);

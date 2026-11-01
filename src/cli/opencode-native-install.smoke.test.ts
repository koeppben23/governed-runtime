/** Actual packed plugin on a private native V2 host. No fixture substitutes for
 * operator/reviewer proof, and catalogue/lifecycle checks are not INACTIVE parity. */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenCode } from '@opencode/client';
import { PLUGIN_RELATIVE_PATH, PLUGIN_WRAPPER } from './templates.js';
import { hashBuffer } from '../shared/hashing.js';
import { nativeOpenCodeCandidate } from './opencode-live-host-test-helpers.js';

const LIVE = process.env.OPENCODE_LIVE === '1' || process.env.FLOWGUARD_OPENCODE_HOST_E2E === '1';
const REPO = fileURLToPath(new URL('../..', import.meta.url));
const CLI = process.env.OPENCODE_CLI ?? 'opencode';
let root: string | undefined;
let host: ChildProcess | undefined;

async function stopOwnedHost(): Promise<void> {
  if (!host || host.exitCode !== null || host.signalCode !== null) return;
  const child = host;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}
afterEach(async () => {
  await stopOwnedHost();
  host = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe.skipIf(!LIVE)('packed native V2 installation and lifecycle', () => {
  it('loads exactly one installed definition, reloads it, and unloads after uninstall without rewriting customer config', async () => {
    root = await mkdtemp(join(tmpdir(), 'fg-native-installed-'));
    const project = join(root, 'project');
    const config = join(root, '.config', 'opencode');
    await mkdir(project, { recursive: true });
    await mkdir(config, { recursive: true });
    execFileSync('git', ['init', '--quiet', project]);
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: root,
      USERPROFILE: root,
      XDG_CONFIG_HOME: join(root, '.config'),
      XDG_DATA_HOME: join(root, '.data'),
      XDG_CACHE_HOME: join(root, '.cache'),
      XDG_STATE_HOME: join(root, '.state'),
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      OPENCODE_CONFIG_DIR: config,
      OPENCODE_TEST_HOME: root,
      OPENCODE_PASSWORD: 'native-install-test-only',
      FLOWGUARD_INSTALL_LOCK_PATH: join(root, '.install.lock'),
    };
    expect(
      execFileSync(CLI, ['--version'], { env, encoding: 'utf8', timeout: 30_000 }).trim(),
    ).toBe(`opencode v${nativeOpenCodeCandidate.version}`);
    await writeFile(join(config, 'opencode.json'), '{"update":"disable"}\n');
    const customer =
      '{ // customer-native settings\n "permissions":[{"action":"edit","resource":"*","effect":"ask"}], "instructions":["CUSTOM.md"], }\n';
    await writeFile(join(project, 'opencode.jsonc'), customer);
    await writeFile(
      join(project, 'CUSTOM.md'),
      'Customer instructions, not FlowGuard governance.\n',
    );
    let tarball: string;
    if (process.env.FLOWGUARD_TARBALL) {
      const supplied = resolve(process.env.FLOWGUARD_TARBALL);
      tarball = join(root, basename(supplied));
      await copyFile(supplied, tarball);
      await copyFile(join(dirname(supplied), 'checksums.sha256'), join(root, 'checksums.sha256'));
    } else {
      const packed = JSON.parse(
        execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', root], {
          cwd: REPO,
          encoding: 'utf8',
          timeout: 60_000,
        }),
      ) as Array<{ filename: string }>;
      tarball = join(root, packed[0]!.filename);
      await writeFile(
        join(root, 'checksums.sha256'),
        `${hashBuffer(await readFile(tarball))}  ${packed[0]!.filename}\n`,
      );
    }
    console.info(
      'native-install-artifact',
      JSON.stringify({
        file: basename(tarball),
        sha256: hashBuffer(await readFile(tarball)),
      }),
    );
    // Bootstrap the CLI from these exact packed bytes, never workspace dist.
    const bootstrap = join(root, 'bootstrap');
    execFileSync(
      'npm',
      ['install', '--prefix', bootstrap, '--ignore-scripts', '--no-audit', '--no-fund', tarball],
      {
        cwd: root,
        env,
        encoding: 'utf8',
        timeout: 300_000,
      },
    );
    const packedRoot = join(bootstrap, 'node_modules/@flowguard/core');
    console.info(
      'native-install-build',
      await readFile(join(packedRoot, 'dist/build-info.json'), 'utf8'),
    );
    const runInstaller = (command: 'install' | 'uninstall', installer: string) =>
      execFileSync(
        process.execPath,
        [
          installer,
          command,
          '--install-scope',
          'repo',
          ...(command === 'install' ? ['--core-tarball', tarball] : []),
        ],
        { cwd: project, env, encoding: 'utf8', timeout: 300_000 },
      );
    const installed = runInstaller('install', join(packedRoot, 'dist/cli/install.js'));
    expect(installed).not.toContain('[error]');
    const target = join(project, '.opencode');
    expect(await readFile(join(target, PLUGIN_RELATIVE_PATH), 'utf8')).toBe(PLUGIN_WRAPPER);
    expect(existsSync(join(target, 'tools/flowguard.ts'))).toBe(false);
    expect(existsSync(join(target, 'plugins/flowguard-audit.ts'))).toBe(false);
    expect(await readFile(join(project, 'opencode.jsonc'), 'utf8')).toBe(customer);

    // Separate read-only diagnostic plugin. The installed product alone owns
    // registration; this observer never wraps or adds FlowGuard tools.
    const observer = join(target, 'plugins/00-native-inventory');
    await mkdir(observer, { recursive: true });
    await writeFile(
      join(observer, 'index.ts'),
      `
import { Plugin } from '@opencode/plugin';
import { Rpc } from '@opencode/plugin/rpc';
import { writeFileSync } from 'node:fs';
const Inventory = Rpc.define({ id: 'flowguard-test-inventory', methods: { tools: { input: { type: 'object', properties: {}, additionalProperties: false }, output: { type: 'array', items: { type: 'string' } }, errors: {} } }, events: {} });
export default Plugin.define({ id: 'flowguard-test-inventory', async setup(ctx) {
  const registration = await ctx.rpc.register(Inventory, { tools: async () => {
    try { return (await ctx.tool.list()).map(tool => tool.name); }
    catch (error) { writeFileSync(ctx.location.directory + '/inventory-error.txt', String(error.stack ?? error)); throw error; }
  } });
  return () => registration.dispose();
} });\n`,
    );

    let output = '';
    host = spawn(CLI, ['serve', '--hostname=127.0.0.1', '--port=0'], {
      cwd: project,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const child = host;
    const baseUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Native host startup timed out: ${output}`)),
        60_000,
      );
      const receive = (chunk: Buffer) => {
        output += chunk.toString();
        const match = output.match(/listening on\s+(https?:\/\/\S+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]!);
        }
      };
      child.stdout?.on('data', receive);
      child.stderr?.on('data', receive);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Native host exited ${code}: ${output}`));
      });
    });
    const client = OpenCode.make({
      baseUrl,
      headers: {
        Authorization: `Basic ${Buffer.from('opencode:native-install-test-only').toString('base64')}`,
      },
    });
    const location = { directory: project };
    // Registry reads activate the location; plugin.list is an observation of
    // currently active plugins, not an activation/completion operation.
    const assertSingleLoadedPlugin = async () => {
      await client.agent.list({ location }, { signal: AbortSignal.timeout(60_000) });
      const plugins = await client.plugin.list(
        { location },
        { signal: AbortSignal.timeout(60_000) },
      );
      const flowguard = plugins.data.filter((plugin) => plugin.id === 'flowguard');
      expect(
        plugins.data.filter((plugin) => plugin.state.status !== 'active'),
        `${JSON.stringify(plugins)}\n${output}`,
      ).toEqual([]);
      expect(
        plugins.data.find((plugin) => plugin.id === 'flowguard-test-inventory')?.state,
        JSON.stringify(plugins),
      ).toEqual({ status: 'active' });
      expect(flowguard, `${JSON.stringify(plugins)}\n${output}`).toHaveLength(1);
      expect(flowguard[0]?.state).toEqual({ status: 'active' });
      expect(flowguard[0]?.features.server).toBe(true);
    };
    await assertSingleLoadedPlugin();
    const commands = await client.command.list({ location });
    for (const name of ['plan', 'implement', 'continue'])
      expect(commands.data.some((command) => command.name === name)).toBe(true);
    const inventory = await client.rpc
      .call({ location, rpcID: 'flowguard-test-inventory', method: 'tools', input: {} })
      .catch(async (error) => {
        const diagnostic = join(project, 'inventory-error.txt');
        if (existsSync(diagnostic)) console.error(await readFile(diagnostic, 'utf8'));
        throw error;
      });
    expect(inventory.output.filter((name: string) => name.startsWith('flowguard_'))).toEqual([
      'flowguard_help',
    ]);
    await client.location.reload({ signal: AbortSignal.timeout(60_000) });
    await assertSingleLoadedPlugin();
    const reviewer = await client.agent.get({ location, agentID: 'flowguard-reviewer' });
    expect(reviewer.data.id).toBe('flowguard-reviewer');
    expect(existsSync(join(config, 'workspaces'))).toBe(false);
    const foreignFiles = [
      join(target, 'node_modules/customer-sentinel.bin'),
      join(target, 'node_modules/@flowguard/core/customer-sentinel.bin'),
      join(target, 'node_modules/customer-package/nested/sentinel.bin'),
    ];
    const foreignBytes = Buffer.from([0, 255, 128, 13, 10, 42]);
    for (const file of foreignFiles) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, foreignBytes);
    }
    const result = runInstaller(
      'uninstall',
      join(target, 'node_modules/@flowguard/core/dist/cli/install.js'),
    );
    expect(result).not.toContain('[error]');
    expect(result).toContain('exclusive content ownership not proven; preserved');
    for (const file of foreignFiles) expect(await readFile(file)).toEqual(foreignBytes);
    expect(existsSync(join(target, PLUGIN_RELATIVE_PATH))).toBe(false);
    expect(existsSync(join(target, 'package.json'))).toBe(false);
    await client.location.reload({ signal: AbortSignal.timeout(60_000) });
    await client.agent.list({ location }, { signal: AbortSignal.timeout(60_000) });
    const after = await client.plugin.list({ location });
    expect(after.data.some((plugin) => plugin.id === 'flowguard')).toBe(false);
    expect(await readFile(join(project, 'opencode.jsonc'), 'utf8')).toBe(customer);
  }, 420_000);
});

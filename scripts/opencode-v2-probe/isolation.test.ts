import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertCleanDiscovery,
  assertProbePaths,
  pinHost,
  probeEnvironment,
  readJournal,
  systemConfigPaths,
  stopProbeProcess,
} from './lib/isolation.mjs';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'fg-isolation-test-'));
  roots.push(root);
  const base = join(root, 'nested', 'probe-base');
  await mkdir(base, { recursive: true });
  return { root, base };
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform === 'win32')(
  'V2 probe isolation (Unix fixture, not a product security boundary)',
  () => {
    it('does not inherit host config, credentials, injection, proxies or Git redirection', () => {
      const hostile = [
        'NODE_OPTIONS',
        'BUN_OPTIONS',
        'OPENCODE_CONFIG',
        'OPENCODE_CONFIG_CONTENT',
        'OPENCODE_CONFIG_DIR',
        'OPENCODE_DB',
        'OPENCODE_SERVER_PASSWORD',
        'OPENCODE_CLI_CONFIG_CONTENT',
        'OPENAI_API_KEY',
        'GH_TOKEN',
        'HTTP_PROXY',
        'HTTPS_PROXY',
        'ALL_PROXY',
        'DYLD_INSERT_LIBRARIES',
        'GIT_DIR',
        'GIT_WORK_TREE',
        'GIT_CONFIG_COUNT',
        'FG_PROBE_DENY_TOOLS',
      ];
      for (const key of hostile) vi.stubEnv(key, 'must-not-propagate');
      const env = probeEnvironment('/isolated');
      for (const key of hostile) expect(env).not.toHaveProperty(key);
      expect(env.HOME).toBe('/isolated');
      expect(env.TMPDIR).toBe('/isolated/tmp');
      expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
    });

    it.each(['opencode.json', 'opencode.jsonc', '.opencode', 'AGENTS.md'])(
      'rejects ancestor %s above the disposable project root',
      async (name) => {
        const { root, base } = await fixture();
        await writeFile(join(root, name), 'contaminated');
        await expect(assertCleanDiscovery(base, [])).rejects.toHaveProperty(
          'code',
          'PROBE_DISCOVERY_CONTAMINATED',
        );
      },
    );

    it.skipIf(process.platform === 'win32')(
      'rejects dangling links rather than treating them as verified absence',
      async () => {
        const { root, base } = await fixture();
        await symlink(join(root, 'missing'), join(root, 'opencode.json'));
        await expect(assertCleanDiscovery(base, [])).rejects.toHaveProperty(
          'code',
          'PROBE_DISCOVERY_CONTAMINATED',
        );
      },
    );

    it('rejects a managed or system config even when project/global paths are clean', async () => {
      const { root, base } = await fixture();
      const managed = join(root, 'managed.plist');
      await writeFile(managed, 'managed');
      await expect(assertCleanDiscovery(base, [managed])).rejects.toHaveProperty(
        'code',
        'PROBE_DISCOVERY_CONTAMINATED',
      );
    });

    it.skipIf(process.platform === 'win32')(
      'checks both symlink-spelled and real ancestors',
      async () => {
        const { root, base } = await fixture();
        const alias = join(root, 'alias');
        await symlink(base, alias);
        await writeFile(join(root, 'nested', 'AGENTS.md'), 'real ancestor');
        await expect(assertCleanDiscovery(alias, [])).rejects.toHaveProperty(
          'code',
          'PROBE_DISCOVERY_CONTAMINATED',
        );
      },
    );

    it('accepts absence, records checked paths and fails on unsupported platforms', async () => {
      const { base } = await fixture();
      const result = await assertCleanDiscovery(base, []);
      expect(result.absent).toBe(true);
      expect(result.checkedPaths).toContain('/opencode.json');
      expect(systemConfigPaths('darwin', 'probe')).toContain(
        '/Library/Managed Preferences/probe/ai.opencode.managed.plist',
      );
      expect(() => systemConfigPaths('win32', 'probe')).toThrow('Isolation not verified');
    });

    it('does not hide filesystem inspection failures as absent configuration', async () => {
      const { root, base } = await fixture();
      const file = join(root, 'not-a-directory');
      await writeFile(file, 'file');
      await expect(assertCleanDiscovery(base, [join(file, 'config')])).rejects.toHaveProperty(
        'code',
        'PROBE_DISCOVERY_UNREADABLE',
      );
    });

    it('rejects missing/malformed journals instead of reporting no observed hooks', async () => {
      const { root } = await fixture();
      const path = join(root, 'journal');
      await expect(readJournal(path)).rejects.toHaveProperty('code', 'PROBE_JOURNAL_UNREADABLE');
      await writeFile(path, '{partial');
      await expect(readJournal(path)).rejects.toHaveProperty('code', 'PROBE_JOURNAL_UNREADABLE');
      await writeFile(path, '{"type":"setup:ready"}\n');
      expect(await readJournal(path)).toEqual([{ type: 'setup:ready' }]);
    });

    it('refuses an incorrectly versioned binary before opening a host server', async () => {
      const { root } = await fixture();
      await expect(pinHost(process.execPath, root, probeEnvironment(root))).rejects.toHaveProperty(
        'code',
        'PROBE_HOST_VERSION_MISMATCH',
      );
    });

    it('requires all reported mutable host paths to be inside the exact fixture root', () => {
      const paths = Object.fromEntries(
        ['home', 'config', 'data', 'state', 'cache', 'tmp', 'db'].map((key) => [
          key,
          '/isolated/' + key,
        ]),
      );
      expect(() => assertProbePaths(paths, '/isolated')).not.toThrow();
      for (const key of Object.keys(paths)) {
        expect(() =>
          assertProbePaths({ ...paths, [key]: '/isolated-sibling/db' }, '/isolated'),
        ).toThrow('escapes isolated root');
        const missing = { ...paths };
        delete missing[key];
        expect(() => assertProbePaths(missing, '/isolated')).toThrow('escapes isolated root');
      }
    });

    it('cleans up an owned child and remains safe after it has exited', async () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
      });
      await once(child, 'spawn');
      await stopProbeProcess(child);
      expect(child.signalCode ?? child.exitCode).not.toBeNull();
      await stopProbeProcess(child);
      await stopProbeProcess(undefined);
    });

    it.skipIf(process.platform === 'win32')(
      'forces cleanup if the private child ignores SIGTERM',
      async () => {
        const child = spawn(process.execPath, [
          '-e',
          'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)',
        ]);
        await once(child.stdout!, 'data');
        await stopProbeProcess(child, 20);
        expect(child.signalCode).toBe('SIGKILL');
      },
    );
  },
);

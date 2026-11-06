/**
 * @module cli/opencode-host-lifecycle.test
 * @description Contract tests for post-install OpenCode service verification.
 * These tests inject a host adapter; they never read, probe or restart the
 * developer's real Desktop service.
 */

import { describe, expect, it } from 'vitest';
import { applyHostLifecycle, runOpenCodeHostLifecycle } from './opencode-host-lifecycle.js';
import {
  isLoopbackServiceUrl,
  isOpenCodeServiceProcess,
  normalizePluginPath,
  type HostLifecycleAdapter,
  type HostProbe,
  type HostProcessInfo,
  type OpenCodeService,
} from './opencode-host-service.js';

const TARGET = '/tmp/flowguard-host-lifecycle/global';
const SERVICE: OpenCodeService = {
  version: '2.2.5',
  url: 'http://127.0.0.1:49374',
  pid: 61161,
  password: 'not-printed-secret',
};
const SERVICE_INFO: HostProcessInfo = {
  executable: '/Applications/OpenCode/opencode-cli',
  command: '/Applications/OpenCode/opencode-cli serve --service',
  parentPid: 1,
};
const REPLACEMENT: OpenCodeService = { ...SERVICE, pid: 62262 };

function pluginPath(target = TARGET): string {
  return normalizePluginPath(`${target}/plugins/flowguard`);
}

function probe(overrides: Partial<HostProbe> = {}): HostProbe {
  return {
    reachable: true,
    pluginStatus: 'failed',
    pluginPath: pluginPath(),
    pluginRef: 'err_test',
    hasStart: false,
    location: null,
    ...overrides,
  };
}

const ACTIVE = probe({ pluginStatus: 'active', pluginRef: null, hasStart: true });

class FakeAdapter implements HostLifecycleAdapter {
  platform: NodeJS.Platform = 'darwin';
  records: Array<unknown | undefined>;
  processes = new Map<number, HostProcessInfo | null>();
  probes: HostProbe[];
  restartError: Error | undefined;
  scheduleError: Error | undefined;
  restarts: string[] = [];
  scheduled: string[] = [];
  probeCalls = 0;
  onRestart: (() => void) | undefined;
  clock = 0;

  constructor(record: unknown | undefined, probes: HostProbe[]) {
    this.records = [record];
    this.probes = probes;
    this.processes.set(SERVICE.pid, SERVICE_INFO);
    this.processes.set(REPLACEMENT.pid, SERVICE_INFO);
    // Default: the installer is outside the service (parent is launchd/shell).
    this.processes.set(process.pid, { ...SERVICE_INFO, executable: '/bin/node', parentPid: 1 });
  }

  async readServiceRecord(): Promise<unknown | undefined> {
    return this.records.length > 1 ? this.records.shift() : this.records[0];
  }

  async probe(): Promise<HostProbe> {
    this.probeCalls += 1;
    return this.probes.length > 1 ? this.probes.shift()! : this.probes[0]!;
  }

  async processInfo(pid: number): Promise<HostProcessInfo | null> {
    return this.processes.get(pid) ?? null;
  }

  async restart(executable: string): Promise<void> {
    this.restarts.push(executable);
    if (this.restartError) throw this.restartError;
    this.onRestart?.();
  }

  async scheduleRestart(executable: string): Promise<void> {
    this.scheduled.push(executable);
    if (this.scheduleError) throw this.scheduleError;
  }

  async sleep(ms: number): Promise<void> {
    this.clock += ms;
  }

  now(): number {
    this.clock += 1;
    return this.clock;
  }
}

async function run(
  adapter: FakeAdapter,
  input: Partial<Parameters<typeof runOpenCodeHostLifecycle>[0]> = {},
) {
  return runOpenCodeHostLifecycle({
    target: TARGET,
    scope: 'global',
    allowRestart: true,
    probeTimeoutMs: 1,
    restartTimeoutMs: 1,
    adapter,
    ...input,
  });
}

describe('OpenCode host lifecycle', () => {
  describe('service record safety', () => {
    it('returns no-service without errors when no record exists', async () => {
      const adapter = new FakeAdapter(undefined, [ACTIVE]);
      const result = await run(adapter);
      expect(result.status).toBe('no-service');
      expect(result.errors).toEqual([]);
      expect(result.notices.some((notice) => notice.message.includes('No running'))).toBe(true);
      expect(adapter.probeCalls).toBe(0);
      expect(adapter.restarts).toEqual([]);
    });

    it('rejects a malformed record without probing or restarting', async () => {
      const adapter = new FakeAdapter({ url: 'http://127.0.0.1:1', pid: '61161' }, [ACTIVE]);
      const result = await run(adapter);
      expect(result.status).toBe('unverified');
      expect(result.errorDetails.map((detail) => detail.code)).toContain(
        'HOST_SERVICE_RECORD_INVALID',
      );
      expect(adapter.probeCalls).toBe(0);
      expect(adapter.restarts).toEqual([]);
    });

    it('never sends credentials to a non-loopback URL', async () => {
      const adapter = new FakeAdapter({ ...SERVICE, url: 'http://192.0.2.10:49374' }, [ACTIVE]);
      const result = await run(adapter);
      expect(result.errorDetails.map((detail) => detail.code)).toContain('HOST_SERVICE_UNSAFE_URL');
      expect(result.errors.join('\n')).not.toContain(SERVICE.password);
      expect(adapter.probeCalls).toBe(0);
      expect(adapter.restarts).toEqual([]);
    });

    it('refuses a stale PID or a process that is not opencode serve --service', async () => {
      const adapter = new FakeAdapter(SERVICE, [ACTIVE]);
      adapter.processes.set(SERVICE.pid, {
        executable: '/usr/bin/yes',
        command: 'yes',
        parentPid: 1,
      });
      const result = await run(adapter);
      expect(result.errorDetails.map((detail) => detail.code)).toContain('HOST_SERVICE_STALE');
      expect(adapter.restarts).toEqual([]);
    });

    it('fails closed when ancestry cannot be established', async () => {
      const adapter = new FakeAdapter(SERVICE, [probe()]);
      adapter.processes.delete(process.pid);
      const result = await run(adapter);
      expect(result.status).toBe('restart-required');
      expect(adapter.restarts).toEqual([]);
    });
  });

  describe('host verification', () => {
    it('reports an active plugin and /start without restarting', async () => {
      const adapter = new FakeAdapter(SERVICE, [ACTIVE]);
      const result = await run(adapter);
      expect(result.status).toBe('active');
      expect(result.notices.some((notice) => notice.message.includes('/start'))).toBe(true);
      expect(adapter.restarts).toEqual([]);
    });

    it('restarts an active plugin when an applied install requires fresh code', async () => {
      const adapter = new FakeAdapter(SERVICE, [ACTIVE]);
      adapter.onRestart = () => {
        adapter.records.unshift(REPLACEMENT);
        adapter.probes = [ACTIVE];
      };
      const result = await run(adapter, { forceRestart: true });
      expect(result.status).toBe('restarted');
      expect(adapter.restarts).toEqual([SERVICE_INFO.executable]);
    });

    it('schedules a restart when the installer is inside the service', async () => {
      const adapter = new FakeAdapter(SERVICE, [probe()]);
      adapter.processes.set(process.pid, {
        ...SERVICE_INFO,
        executable: '/bin/node',
        parentPid: SERVICE.pid,
      });
      const result = await run(adapter);
      expect(result.status).toBe('restart-scheduled');
      expect(result.errors).toEqual([]);
      expect(adapter.scheduled).toEqual([SERVICE_INFO.executable]);
      expect(adapter.restarts).toEqual([]);
    });

    it('reports restart-required inside the service when automatic restart is disabled', async () => {
      const adapter = new FakeAdapter(SERVICE, [probe()]);
      adapter.processes.set(process.pid, {
        ...SERVICE_INFO,
        executable: '/bin/node',
        parentPid: SERVICE.pid,
      });
      const result = await run(adapter, { allowRestart: false });
      expect(result.status).toBe('restart-required');
      expect(adapter.scheduled).toEqual([]);
    });

    it('reports a scheduling failure without claiming a restart', async () => {
      const adapter = new FakeAdapter(SERVICE, [probe()]);
      adapter.processes.set(process.pid, {
        ...SERVICE_INFO,
        executable: '/bin/node',
        parentPid: SERVICE.pid,
      });
      adapter.scheduleError = new Error('spawn refused');
      const result = await run(adapter);
      expect(result.status).toBe('restart-failed');
      expect(result.errorDetails.map((detail) => detail.code)).toContain('HOST_RESTART_FAILED');
      expect(adapter.scheduled).toEqual([SERVICE_INFO.executable]);
    });

    it('requires a restart when automatic restart is disabled', async () => {
      const adapter = new FakeAdapter(SERVICE, [probe()]);
      const result = await run(adapter, { allowRestart: false });
      expect(result.status).toBe('restart-required');
      expect(adapter.restarts).toEqual([]);
    });

    it('rejects an active plugin at a different installation path without restarting', async () => {
      const adapter = new FakeAdapter(SERVICE, [
        probe({
          pluginStatus: 'active',
          hasStart: true,
          pluginPath: '/tmp/other/plugins/flowguard',
        }),
      ]);
      const result = await run(adapter);
      expect(result.status).toBe('unverified');
      expect(result.errorDetails.map((detail) => detail.code)).toContain('HOST_PLUGIN_MISMATCH');
      expect(adapter.restarts).toEqual([]);
    });

    it('does not treat a reachable but foreign repo location as this installation', async () => {
      const adapter = new FakeAdapter(SERVICE, [probe({ location: '/private/tmp/other-project' })]);
      const result = await run(adapter, { scope: 'repo' });
      expect(result.status).toBe('unverified');
      expect(result.notices.some((notice) => notice.message.includes('repo-scoped'))).toBe(true);
      expect(adapter.restarts).toEqual([]);
    });

    it('reports NOT_VERIFIED without restarting when the loopback API is unreachable', async () => {
      const adapter = new FakeAdapter(SERVICE, [
        probe({ reachable: false, pluginStatus: 'unknown', pluginPath: null }),
      ]);
      const result = await run(adapter);
      expect(result.status).toBe('unverified');
      expect(result.errorDetails.map((detail) => detail.code)).toContain(
        'HOST_VERIFICATION_UNAVAILABLE',
      );
      expect(adapter.restarts).toEqual([]);
    });

    it('skips host verification on unsupported platforms', async () => {
      const adapter = new FakeAdapter(SERVICE, [ACTIVE]);
      adapter.platform = 'win32';
      const result = await run(adapter);
      expect(result.status).toBe('unverified');
      expect(result.notices.some((notice) => notice.message.includes('not supported'))).toBe(true);
      expect(adapter.restarts).toEqual([]);
    });
  });

  describe('restart', () => {
    it('restarts the exact executable and verifies the replacement', async () => {
      const adapter = new FakeAdapter(SERVICE, [probe()]);
      adapter.onRestart = () => {
        adapter.records.unshift(REPLACEMENT);
        adapter.probes = [ACTIVE];
      };
      const result = await run(adapter);
      expect(result.status).toBe('restarted');
      expect(adapter.restarts).toEqual([SERVICE_INFO.executable]);
      expect(result.notices.some((notice) => notice.message.includes('active'))).toBe(true);
    });

    it('reports restart failure without claiming activation', async () => {
      const adapter = new FakeAdapter(SERVICE, [probe()]);
      adapter.restartError = new Error('service manager refused');
      const result = await run(adapter);
      expect(result.status).toBe('restart-failed');
      expect(result.errorDetails.map((detail) => detail.code)).toContain('HOST_RESTART_FAILED');
      expect(result.notices.some((notice) => notice.message.includes('active'))).toBe(false);
    });

    it('rejects a replacement record whose URL is not loopback', async () => {
      const adapter = new FakeAdapter(SERVICE, [probe()]);
      adapter.onRestart = () => {
        adapter.records.unshift({ ...REPLACEMENT, url: 'http://192.0.2.10:49374' });
        adapter.probes = [ACTIVE];
      };
      const result = await run(adapter);
      expect(result.status).toBe('restart-failed');
      expect(result.errorDetails.map((detail) => detail.code)).toContain('HOST_RESTART_FAILED');
    });

    it('accepts a same-PID supervisor restart and verifies the plugin', async () => {
      const adapter = new FakeAdapter(SERVICE, [probe()]);
      adapter.onRestart = () => {
        adapter.probes = [ACTIVE];
      };
      const result = await run(adapter);
      expect(result.status).toBe('restarted');
      expect(adapter.restarts).toEqual([SERVICE_INFO.executable]);
    });

    it('fails when the restarted service publishes no readable record', async () => {
      const adapter = new FakeAdapter(SERVICE, [probe()]);
      adapter.onRestart = () => {
        adapter.records = [undefined];
      };
      const result = await run(adapter);
      expect(result.status).toBe('restart-failed');
      expect(result.errorDetails.map((detail) => detail.code)).toContain('HOST_RESTART_FAILED');
    });

    it('fails when the restarted service still has the failed plugin', async () => {
      const adapter = new FakeAdapter(SERVICE, [probe()]);
      adapter.onRestart = () => {
        adapter.records.unshift(REPLACEMENT);
        adapter.probes = [probe({ pluginRef: 'err_still_failed' })];
      };
      const result = await run(adapter);
      expect(result.status).toBe('restart-failed');
      expect(result.errors.join('\n')).toContain('err_still_failed');
    });

    it('reports a missing /start after a successful plugin restart', async () => {
      const adapter = new FakeAdapter(SERVICE, [probe()]);
      adapter.onRestart = () => {
        adapter.records.unshift(REPLACEMENT);
        adapter.probes = [probe({ pluginStatus: 'active', pluginRef: null, hasStart: false })];
      };
      const result = await run(adapter);
      expect(result.status).toBe('restart-failed');
      expect(result.errorDetails.map((detail) => detail.code)).toContain('HOST_COMMAND_MISSING');
    });
  });

  describe('pure helpers', () => {
    it('accepts only loopback http(s) service URLs', () => {
      expect(isLoopbackServiceUrl('http://127.0.0.1:49374')).toBe(true);
      expect(isLoopbackServiceUrl('http://localhost:49374')).toBe(true);
      expect(isLoopbackServiceUrl('http://[::1]:49374')).toBe(true);
      expect(isLoopbackServiceUrl('https://127.0.0.1:49374')).toBe(true);
      expect(isLoopbackServiceUrl('http://192.0.2.10:49374')).toBe(false);
      expect(isLoopbackServiceUrl('file:///tmp/service.json')).toBe(false);
      expect(isLoopbackServiceUrl('not a url')).toBe(false);
    });

    it('requires an absolute opencode CLI and serve --service command', () => {
      expect(isOpenCodeServiceProcess(SERVICE_INFO)).toBe(true);
      expect(
        isOpenCodeServiceProcess({
          executable: '/Applications/OpenCode/opencode',
          command: '/Applications/OpenCode/opencode serve --service',
          parentPid: 1,
        }),
      ).toBe(true);
      expect(isOpenCodeServiceProcess({ ...SERVICE_INFO, executable: 'opencode-cli' })).toBe(false);
      expect(isOpenCodeServiceProcess({ ...SERVICE_INFO, command: 'opencode serve' })).toBe(false);
      expect(isOpenCodeServiceProcess({ ...SERVICE_INFO, executable: '/usr/bin/yes' })).toBe(false);
    });

    it('normalizes a plugin entrypoint to its directory', () => {
      expect(normalizePluginPath('/tmp/plugins/flowguard/index.ts')).toBe(
        normalizePluginPath('/tmp/plugins/flowguard'),
      );
    });

    it('merges lifecycle failures into the install result', () => {
      const target = { warnings: ['w'], errors: [] as string[], notices: [] };
      applyHostLifecycle(target, {
        status: 'restart-required',
        notices: [{ kind: 'next', message: 'n' }],
        warnings: ['lw'],
        errors: ['le'],
        errorDetails: [{ code: 'HOST_RESTART_REQUIRED', message: 'le' }],
      });
      expect(target).toMatchObject({
        warnings: ['w', 'lw'],
        errors: ['le'],
        notices: [{ kind: 'next', message: 'n' }],
      });
    });
  });
});

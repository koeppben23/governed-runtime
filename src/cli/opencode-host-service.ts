/**
 * @module cli/opencode-host-service
 * @description Discovery, loopback probing and process verification for the
 * running OpenCode service. This module owns the host-specific I/O; lifecycle
 * decisions and restart orchestration live in opencode-host-lifecycle.ts.
 *
 * Safety boundaries:
 * - credentials are sent only to a loopback http(s) URL with redirects
 *   disabled;
 * - only a live `opencode`/`opencode-cli` process whose command is
 *   `serve --service` is accepted as a restart target;
 * - a malformed or stale service record never becomes a process-kill
 *   instruction.
 */

import { execFileSync } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { z } from 'zod';

class HostApiError extends Error {
  readonly code = 'OPENCODE_HOST_API_UNAVAILABLE';

  constructor(message: string) {
    super(message);
    this.name = 'HostApiError';
  }
}

const SERVICE_RECORD_SCHEMA = z.object({
  version: z.string().min(1),
  url: z.string().url(),
  pid: z.number().int().positive(),
  password: z.string().min(1),
});

export type OpenCodeService = z.infer<typeof SERVICE_RECORD_SCHEMA>;

export type HostPluginStatus = 'active' | 'failed' | 'unknown';

export interface HostProbe {
  readonly reachable: boolean;
  readonly pluginStatus: HostPluginStatus;
  readonly pluginPath: string | null;
  readonly pluginRef: string | null;
  readonly hasStart: boolean;
  readonly location: string | null;
}

export interface HostProcessInfo {
  readonly executable: string;
  readonly command: string;
  readonly parentPid: number;
}

export interface HostLifecycleAdapter {
  readonly platform: NodeJS.Platform;
  readServiceRecord(path: string): Promise<unknown | undefined>;
  probe(service: OpenCodeService, target: string): Promise<HostProbe>;
  processInfo(pid: number): Promise<HostProcessInfo | null>;
  restart(executable: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export function defaultServiceRecordPath(): string {
  return (
    process.env['FLOWGUARD_OPENCODE_SERVICE_RECORD'] ??
    join(homedir(), '.local', 'state', 'opencode', 'service.json')
  );
}

export function isLoopbackServiceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    return host === '127.0.0.1' || host === '::1' || host === 'localhost';
  } catch {
    return false;
  }
}

export function normalizePluginPath(value: string): string {
  const resolved = resolve(value);
  return resolved.endsWith(`${sep}index.ts`) ? dirname(resolved) : resolved;
}

function basicAuth(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function entries(value: unknown): Record<string, unknown>[] {
  if (!record(value) || !Array.isArray(value['data'])) return [];
  return value['data'].filter(record);
}

function localPluginEntry(
  value: unknown,
  target: string,
): { status: HostPluginStatus; path: string | null; ref: string | null } {
  const expected = normalizePluginPath(join(target, 'plugins', 'flowguard'));
  let fallback: { status: HostPluginStatus; path: string | null; ref: string | null } = {
    status: 'unknown',
    path: null,
    ref: null,
  };
  for (const entry of entries(value)) {
    const source = entry['source'];
    if (!record(source) || source['type'] !== 'local' || typeof source['path'] !== 'string') {
      continue;
    }
    const path = normalizePluginPath(source['path']);
    const state = record(entry['state']) ? entry['state'] : {};
    const rawStatus = state['status'];
    const status: HostPluginStatus =
      rawStatus === 'active' ? 'active' : rawStatus === 'failed' ? 'failed' : 'unknown';
    const candidate = {
      status,
      path,
      ref: typeof state['ref'] === 'string' ? state['ref'] : null,
    };
    if (path === expected) return candidate;
    if (basename(path) === 'flowguard') fallback = candidate;
  }
  return fallback;
}

async function fetchJson(
  fetchImpl: typeof fetch,
  service: OpenCodeService,
  pathname: string,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetchImpl(new URL(pathname, service.url), {
    headers: { Authorization: basicAuth(service.password) },
    redirect: 'error',
    signal,
  });
  if (!response.ok) throw new HostApiError(`OpenCode ${pathname} returned ${response.status}`);
  return response.json();
}

async function probeService(
  service: OpenCodeService,
  target: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5_000,
): Promise<HostProbe> {
  const signal = AbortSignal.timeout(timeoutMs);
  let pluginValue: unknown;
  try {
    pluginValue = await fetchJson(fetchImpl, service, '/api/plugin', signal);
  } catch {
    return {
      reachable: false,
      pluginStatus: 'unknown',
      pluginPath: null,
      pluginRef: null,
      hasStart: false,
      location: null,
    };
  }
  const plugin = localPluginEntry(pluginValue, target);
  let hasStart = false;
  let location: string | null = null;
  try {
    const commands = await fetchJson(fetchImpl, service, '/api/command', signal);
    hasStart = entries(commands).some((entry) => entry['name'] === 'start');
  } catch {
    // Command discovery is a secondary signal; the plugin state remains primary.
  }
  try {
    const current = await fetchJson(fetchImpl, service, '/api/location', signal);
    const data = record(current) ? current['data'] : undefined;
    if (record(data) && typeof data['directory'] === 'string') location = data['directory'];
  } catch {
    // Location is optional for global installs.
  }
  return {
    reachable: true,
    pluginStatus: plugin.status,
    pluginPath: plugin.path,
    pluginRef: plugin.ref,
    hasStart,
    location,
  };
}

function ps(pid: number, field: 'comm' | 'command' | 'ppid'): string | null {
  try {
    const output = execFileSync('ps', ['-p', String(pid), '-o', `${field}=`], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

function executablePath(pid: number): string | null {
  if (process.platform === 'linux') {
    try {
      return readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, '');
    } catch {
      // Fall back to ps; an absolute path is still required by the caller.
    }
  }
  return ps(pid, 'comm');
}

function processInfo(pid: number): HostProcessInfo | null {
  const executable = executablePath(pid);
  const command = ps(pid, 'command');
  const parent = ps(pid, 'ppid');
  if (executable === null || command === null || parent === null) return null;
  const parentPid = Number(parent);
  if (!Number.isInteger(parentPid) || parentPid < 0) return null;
  return { executable, command, parentPid };
}

export function isOpenCodeServiceProcess(info: HostProcessInfo): boolean {
  if (!isAbsolute(info.executable)) return false;
  const name = basename(info.executable);
  if (!/^opencode(?:-cli)?(?:\.exe)?$/.test(name)) return false;
  return /\bserve\s+--service(?:\s|$)/.test(info.command);
}

export function createDefaultAdapter(): HostLifecycleAdapter {
  return {
    platform: process.platform,
    async readServiceRecord(path) {
      try {
        return JSON.parse(await readFile(path, 'utf8')) as unknown;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
        throw error;
      }
    },
    probe: (service, target) => probeService(service, target),
    processInfo: async (pid) => processInfo(pid),
    async restart(executable) {
      execFileSync(executable, ['service', 'restart'], {
        timeout: 60_000,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      });
    },
    async sleep(ms) {
      await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
    },
    now: () => Date.now(),
  };
}

export { SERVICE_RECORD_SCHEMA };

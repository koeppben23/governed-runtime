/**
 * @module cli/run
 * @description Headless wrapper for FlowGuard via supported host CLIs.
 *
 * EXPERIMENTAL: This is a thin convenience wrapper.
 * For production, use host CLIs directly:
 *   opencode run "prompt"
 *   opencode serve --port 4096
 *   claude -p "prompt" --output-format stream-json
 *   codex --non-interactive --prompt "prompt"
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolveHost } from './host-resolver.js';
import { parseRunArgs, parseServeArgs } from './run-args.js';
import {
  HOST_COMMANDS,
  HOST_SERVE_UNSUPPORTED,
  resolveHostBinary,
  type HostCommandSpec,
} from './run-hosts.js';
import { getAdapterLogger } from '../logging/adapter-logger.js';
import { DEFAULT_HOST, HOST_IDS, type HostId } from '../shared/hosts.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RunResult {
  success: boolean;
  output?: string;
  error?: string;
}

export interface HeadlessConfig {
  prompt: string;
  host?: HostId;
  cwd?: string;
  env?: Record<string, string>;
}

export interface ServeConfig {
  host?: HostId;
  port?: number;
  hostname?: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface ServeResult {
  success: boolean;
  port: number;
  pid?: number;
  error?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_PORT = 4096;
const DEFAULT_HOSTNAME = '127.0.0.1';
const STARTUP_TIMEOUT_MS = 5000;

// ─── Utility Functions ────────────────────────────────────────────────────────────────

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    server.listen(port);
  });
}

async function waitForServer(port: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const available = await isPortAvailable(port);
    if (!available) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function executeHost(
  binary: string,
  args: string[],
  options?: { cwd?: string; env?: Record<string, string> },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const mergedEnv = { ...process.env, ...options?.env };
    let settled = false;
    const finish = (result: { exitCode: number; stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const proc = spawn(binary, args, {
      cwd: options?.cwd ?? process.cwd(),
      env: mergedEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr?.on('data', (d) => {
      stderr += d.toString();
    });

    proc.on('close', (code) => {
      finish({ exitCode: code ?? 0, stdout, stderr });
    });

    proc.on('error', (err) => {
      stderr += err.message;
      getAdapterLogger().error('cli', 'host process failed', { binary, error: err.message });
      finish({ exitCode: 1, stdout, stderr });
    });
  });
}

// ─── Run Implementation ────────────────────────────────────────────────────────────

export async function run(config: HeadlessConfig): Promise<RunResult> {
  const { prompt, cwd = process.cwd(), env } = config;

  if (!prompt) {
    return { success: false, error: 'Prompt is required' };
  }

  let host: HostId;
  try {
    host = (await resolveHost({ cliHost: config.host, cwd })).host;
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }

  const spec = HOST_COMMANDS[host];
  const mergedEnv = { ...env, FLOWGUARD_HOST_PLATFORM: host };
  const binaryPath = await resolveHostBinary(spec.binary, mergedEnv);
  if (!binaryPath) {
    return { success: false, error: `Host binary not found on PATH: ${spec.binary}` };
  }

  const result = await executeHost(binaryPath, spec.buildRunArgs(prompt), { cwd, env: mergedEnv });

  if (result.exitCode !== 0) {
    getAdapterLogger().warn('cli', 'run command failed', {
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
    return {
      success: false,
      error: result.stderr || `Exit code: ${result.exitCode}`,
    };
  }

  return { success: true, output: result.stdout };
}

// ─── Serve Implementation ─────────────────────────────────────────────────

export async function checkServer(port: number): Promise<boolean> {
  const available = await isPortAvailable(port);
  return !available;
}

function unsupportedServeResult(host: HostId, port: number): ServeResult {
  return {
    success: false,
    port,
    error: `${HOST_SERVE_UNSUPPORTED}: flowguard serve is only supported for opencode; ${host} has no verified native long-running serve mode`,
  };
}

type ServeHostSpec = HostCommandSpec & {
  supportsServe: true;
  buildServeArgs(config: { port: number; hostname: string }): string[];
};

type ServeHostResolution =
  | { ok: true; selectedHost: HostId; spec: ServeHostSpec }
  | { ok: false; error: ServeResult };

function supportsServe(spec: HostCommandSpec): spec is ServeHostSpec {
  return spec.supportsServe === true && spec.buildServeArgs !== undefined;
}

async function resolveServeHost(
  config: ServeConfig,
  cwd: string,
  port: number,
): Promise<ServeHostResolution> {
  const selectedHost = (await resolveHost({ cliHost: config.host, cwd })).host;
  const spec = HOST_COMMANDS[selectedHost];
  if (!supportsServe(spec)) {
    return { ok: false, error: unsupportedServeResult(selectedHost, port) };
  }
  return { ok: true, selectedHost, spec };
}

/**
 * Start an OpenCode server in detached mode.
 *
 * This is the only supported mode. The server runs in background
 * and the CLI returns immediately.
 */
export async function serve(config: ServeConfig): Promise<ServeResult> {
  const {
    port = DEFAULT_PORT,
    hostname: host = DEFAULT_HOSTNAME,
    cwd = process.cwd(),
    env,
  } = config;

  const resolved: ServeHostResolution = await (async () => {
    try {
      return await resolveServeHost(config, cwd, port);
    } catch (err) {
      return {
        ok: false,
        error: { success: false, port, error: err instanceof Error ? err.message : String(err) },
      };
    }
  })();

  if (!resolved.ok) return resolved.error;

  const { selectedHost, spec } = resolved;
  const mergedEnv = { ...env, FLOWGUARD_HOST_PLATFORM: selectedHost };
  const binaryPath = await resolveHostBinary(spec.binary, mergedEnv);
  if (!binaryPath) {
    return { success: false, port, error: `Host binary not found on PATH: ${spec.binary}` };
  }

  const inUse = await checkServer(port);
  if (inUse) {
    return { success: false, port, error: `Port ${port} is already in use` };
  }

  const args = spec.buildServeArgs({ port, hostname: host });
  const processEnv = { ...process.env, ...mergedEnv };

  // Detached mode only - server runs in background
  const serverProcess = spawn(binaryPath, args, {
    cwd,
    env: processEnv,
    stdio: 'ignore',
    detached: true,
  });

  serverProcess.unref();

  // Race: error vs ready vs timeout
  let startupError: string | null = null;

  serverProcess.on('error', (err) => {
    startupError = err.message;
  });

  const ready = await waitForServer(port, STARTUP_TIMEOUT_MS);

  if (!ready || startupError) {
    getAdapterLogger().error('cli', 'serve startup failed', {
      port,
      error: startupError || 'Server failed to start',
    });
    return { success: false, port, error: startupError || 'Server failed to start' };
  }

  return { success: true, port, pid: serverProcess.pid };
}

// ─── CLI Entry Point ──────────────────────────────────────────────────────────

export { parseRunArgs, parseServeArgs } from './run-args.js';

export function formatRunResult(result: RunResult): string {
  if (result.success) {
    return result.output ?? '[ok] Executed';
  }
  return `[error] ${result.error ?? 'Unknown error'}`;
}

export function getRunUsage(): string {
  return `Usage: flowguard run [options] -- <prompt>

Headless execution wrapper (EXPERIMENTAL).

For production, use host CLIs directly:
  opencode run "prompt"
  claude -p "prompt" --output-format stream-json
  codex --non-interactive --prompt "prompt"

Options:
  -- <prompt>       Command to execute
  --host <host>     Host: ${HOST_IDS.join(', ')} (default: ${DEFAULT_HOST})
  --cwd <dir>      Working directory`;
}

export function getServeUsage(): string {
  return `Usage: flowguard serve [options]

Server wrapper (EXPERIMENTAL, detached mode only).

Only OpenCode currently has verified native serve support:
  opencode serve --port 4096

Options:
  --host <host>      Host: ${HOST_IDS.join(', ')} (serve supported: opencode)
  --port <num>       Port (default: ${DEFAULT_PORT})
  --hostname <host>  Hostname (default: ${DEFAULT_HOSTNAME})
  --cwd <dir>       Working directory`;
}

export async function runMain(argv: string[]): Promise<number> {
  const parsed = parseRunArgs(argv);

  if (!parsed) {
    console.log(getRunUsage());
    return 1;
  }

  const result = await run(parsed.config);
  console.log(formatRunResult(result));

  return result.success ? 0 : 1;
}

export async function serveMain(argv: string[]): Promise<number> {
  const parsed = parseServeArgs(argv);

  if (!parsed) {
    console.log(getServeUsage());
    return 1;
  }

  const result = await serve(parsed.config);

  if (!result.success) {
    console.log(`[error] ${result.error}`);
    return 1;
  }

  console.log(`[ok] Server started on port ${result.port}`);
  if (result.pid) console.log(`    PID: ${result.pid}`);

  return 0;
}

/**
 * @module cli/run
 * @description Headless wrapper for FlowGuard via OpenCode.
 *
 * EXPERIMENTAL: This is a thin convenience wrapper.
 * For production, use OpenCode directly:
 *   opencode run "prompt"
 *   opencode serve --port 4096 --detach
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RunResult {
  success: boolean;
  output?: string;
  error?: string;
}

export interface HeadlessConfig {
  prompt: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface ServeConfig {
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

function executeOpenCode(
  args: string[],
  options?: { cwd?: string; env?: Record<string, string> },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const mergedEnv = { ...process.env, ...options?.env };
    const proc = spawn('opencode', args, {
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
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });

    proc.on('error', (err) => {
      stderr += err.message;
      resolve({ exitCode: 1, stdout, stderr });
    });
  });
}

// ─── Run Implementation ────────────────────────────────────────────────────────────

export async function run(config: HeadlessConfig): Promise<RunResult> {
  const { prompt, cwd = process.cwd(), env } = config;

  if (!prompt) {
    return { success: false, error: 'Prompt is required' };
  }

  const result = await executeOpenCode(['run', prompt], { cwd, env });

  if (result.exitCode !== 0) {
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

  const inUse = await checkServer(port);
  if (inUse) {
    return { success: false, port, error: `Port ${port} is already in use` };
  }

  const args = ['serve', '--port', String(port), '--hostname', host];
  const mergedEnv = { ...process.env, ...env };

  // Detached mode only - server runs in background
  const serverProcess = spawn('opencode', args, {
    cwd,
    env: mergedEnv,
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
    return { success: false, port, error: startupError || 'Server failed to start' };
  }

  return { success: true, port, pid: serverProcess.pid };
}

// ─── Argument Parsing ─────────────────────────────────────────────────

export function parseRunArgs(argv: string[]): { config: HeadlessConfig; errors: string[] } | null {
  const config: HeadlessConfig = { prompt: '' };
  const errors: string[] = [];
  const knownFlags = ['--', '--prompt', '--cwd'];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;

    if (arg.startsWith('-') && !knownFlags.includes(arg)) {
      errors.push(`Unknown flag: ${arg}`);
      continue;
    }

    if (arg === '--') {
      continue;
    }

    if (arg === '--prompt') {
      const next = argv[i + 1];
      if (next) {
        config.prompt = next;
        i++;
      } else {
        errors.push('--prompt requires a value');
      }
    } else if (arg === '--cwd') {
      const next = argv[i + 1];
      if (next) {
        config.cwd = next;
        i++;
      } else {
        errors.push('--cwd requires a value');
      }
    } else if (arg && !arg.startsWith('-')) {
      config.prompt = arg;
    }
  }

  if (!config.prompt) {
    errors.push('Prompt is required');
  }

  return errors.length > 0 ? null : { config, errors };
}

export function parseServeArgs(argv: string[]): { config: ServeConfig; errors: string[] } | null {
  const config: ServeConfig = {};
  const errors: string[] = [];
  const knownFlags = ['--port', '--hostname', '--cwd', '--detach'];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;

    if (arg.startsWith('-') && !knownFlags.includes(arg)) {
      errors.push(`Unknown flag: ${arg}`);
      continue;
    }

    if (arg === '--port') {
      const next = argv[i + 1];
      if (next) {
        const port = parseInt(next, 10);
        if (Number.isNaN(port) || port < 1 || port > 65535) {
          errors.push('--port must be 1-65535');
        } else {
          config.port = port;
          i++;
        }
      } else {
        errors.push('--port requires a value');
      }
    } else if (arg === '--hostname') {
      const next = argv[i + 1];
      if (next) {
        config.hostname = next;
        i++;
      } else {
        errors.push('--hostname requires a value');
      }
    } else if (arg === '--detach') {
      // Accepted as explicit detached-mode marker (now always detached anyway)
    } else if (arg === '--cwd') {
      const next = argv[i + 1];
      if (next) {
        config.cwd = next;
        i++;
      } else {
        errors.push('--cwd requires a value');
      }
    }
  }

  return errors.length > 0 ? null : { config, errors };
}

// ─── CLI Entry Point ──────────────────────────────────────────────────────────

export function formatRunResult(result: RunResult): string {
  if (result.success) {
    return result.output ?? '[ok] Executed';
  }
  return `[error] ${result.error ?? 'Unknown error'}`;
}

export function getRunUsage(): string {
  return `Usage: flowguard run [options] -- <prompt>

Headless execution wrapper (EXPERIMENTAL).

For production, use OpenCode directly:
  opencode run "prompt"

Options:
  -- <prompt>    Command to execute
  --cwd <dir>   Working directory`;
}

export function getServeUsage(): string {
  return `Usage: flowguard serve [options]

Server wrapper (EXPERIMENTAL, detached mode only).

For production, use OpenCode directly:
  opencode serve --port 4096 --detach

Options:
  --port <num>    Port (default: ${DEFAULT_PORT})
  --hostname <host>  Hostname (default: ${DEFAULT_HOSTNAME})
  --cwd <dir>    Working directory`;
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

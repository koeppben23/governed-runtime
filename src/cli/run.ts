/**
 * @module cli/run
 * @description Headless wrapper for FlowGuard via OpenCode modes.
 *
 * THIS IS EXPERIMENTAL: The implementation is being refined for correctness.
 *
 * Usage:
 *   flowguard run --prompt "..." [--server-url <url>]
 *   flowguard serve [--port <port>] [--detach]
 *
 * Architecture:
 * - run(): Executes commands via opencode run (non-interactive)
 * - serve(): Starts OpenCode server for headless operation
 *
 * Known limitations:
 * - Server lifecycle needs explicit management
 * - --attach semantics not fully verified with OpenCode
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
  serverUrl?: string;
  prompt: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface ServeConfig {
  port?: number;
  hostname?: string;
  detach?: boolean;
  cwd?: string;
  env?: Record<string, string>;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_PORT = 4096;
const DEFAULT_HOSTNAME = '127.0.0.1';
const SERVER_STARTUP_TIMEOUT_MS = 5000;

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
  options?: {
    cwd?: string;
    env?: Record<string, string>;
  },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn('opencode', args, {
      cwd: options?.cwd ?? process.cwd(),
      env: { ...process.env, ...options?.env },
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

/**
 * Execute a FlowGuard command in headless mode.
 *
 * Uses `opencode run` for non-interactive execution.
 * Does NOT start its own server — uses OpenCode's built-in mode.
 *
 * @param config - Headless configuration
 * @returns Execution result
 */
export async function run(config: HeadlessConfig): Promise<RunResult> {
  const { serverUrl, prompt, cwd = process.cwd(), env } = config;

  if (!prompt) {
    return {
      success: false,
      error: 'Prompt is required',
    };
  }

  // EXPERIMENTAL: Use serverUrl if provided
  // Note: opencode run --attach semantics need verification with OpenCode docs
  const args = serverUrl
    ? ['run', '--attach', serverUrl, prompt]
    : ['run', prompt];

  const result = await executeOpenCode(args, { cwd, env });

  if (result.exitCode !== 0) {
    return {
      success: false,
      error: result.stderr || `Exit code: ${result.exitCode}`,
    };
  }

  return {
    success: true,
    output: result.stdout,
  };
}

// ─── Serve Implementation ─────────────────────────────────────────────────

/**
 * Check if a port is in use.
 */
export async function checkServer(port: number): Promise<boolean> {
  const available = await isPortAvailable(port);
  return !available;
}

/**
 * Start an OpenCode server for headless operation.
 *
 * Note: Without --detach, this keeps the server in foreground.
 * With --detach, the server runs in background.
 *
 * @param config - Server configuration
 * @returns Server process info
 */
export async function serve(
  config: ServeConfig,
): Promise<{ success: boolean; port: number; pid?: number; error?: string }> {
  const {
    port = DEFAULT_PORT,
    hostname: host = DEFAULT_HOSTNAME,
    detach = false,
    cwd = process.cwd(),
    env,
  } = config;

  // Check if port is already in use
  const inUse = await checkServer(port);
  if (inUse) {
    return {
      success: false,
      port,
      error: `Port ${port} is already in use. Is a server already running?`,
    };
  }

  const args = [
    'serve',
    '--port',
    String(port),
    '--hostname',
    host,
  ];

  const childEnv = { ...process.env, ...env };

  if (detach) {
    // Spawn in background
    const serverProcess = spawn('opencode', args, {
      cwd,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    const ready = await waitForServer(port, SERVER_STARTUP_TIMEOUT_MS);
    if (!ready) {
      serverProcess.kill();
      return {
        success: false,
        port,
        error: `Server failed to start within ${SERVER_STARTUP_TIMEOUT_MS}ms`,
      };
    }

    return {
      success: true,
      port,
      pid: serverProcess.pid,
    };
  }

  // Foreground mode (default) - keep process running
  // This will block until the server is stopped
  const proc = spawn('opencode', args, {
    cwd,
    env: childEnv,
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  const pid = proc.pid;

  proc.stdout?.on('data', (d) => {
    process.stdout.write(d);
  });

  proc.stderr?.on('data', (d) => {
    process.stderr.write(d);
  });

  const ready = await waitForServer(port, SERVER_STARTUP_TIMEOUT_MS);
  if (!ready) {
    proc.kill();
    return {
      success: false,
      port,
      error: `Server failed to start within ${SERVER_STARTUP_TIMEOUT_MS}ms`,
    };
  }

  // Wait for process to exit (blocks until killed)
  return new Promise((resolve) => {
    proc.on('close', () => {
      resolve({
        success: true,
        port,
        pid,
      });
    });
  });
}

// ─── Argument Parsing ─────────────────────────────────────────────────

export function parseRunArgs(argv: string[]): {
  config: HeadlessConfig;
  errors: string[];
} | null {
  const config: HeadlessConfig = {
    prompt: '',
  };

  const errors: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--prompt') {
      const next = argv[i + 1];
      if (next) {
        config.prompt = next;
        i++;
      } else {
        errors.push('--prompt requires a value');
      }
    } else if (arg === '--server-url') {
      const next = argv[i + 1];
      if (next) {
        config.serverUrl = next;
        i++;
      } else {
        errors.push('--server-url requires a value');
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
    errors.push('Prompt is required. Use --prompt or provide a command.');
  }

  return errors.length > 0 ? null : { config, errors };
}

export function parseServeArgs(argv: string[]): {
  config: ServeConfig;
  errors: string[];
} | null {
  const config: ServeConfig = {};
  const errors: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--port') {
      const next = argv[i + 1];
      if (next) {
        const port = parseInt(next, 10);
        if (Number.isNaN(port) || port < 1 || port > 65535) {
          errors.push('--port must be between 1 and 65535');
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
      config.detach = true;
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
    return result.output ?? '[ok] Command executed';
  }
  return `[error] ${result.error ?? 'Unknown error'}`;
}

export function getRunUsage(): string {
  return `Usage: flowguard run [options] -- <prompt>

Execute FlowGuard commands in headless mode (EXPERIMENTAL).

Options:
  --prompt <text>     FlowGuard command to execute
  --server-url <url>  Attach to existing server
  --cwd <dir>        Working directory

Examples:
  flowguard run -- "Run /hydrate"
  flowguard run --server-url http://localhost:4096 -- "Run /validate"`;
}

export function getServeUsage(): string {
  return `Usage: flowguard serve [options]

Start an OpenCode server (EXPERIMENTAL).

Options:
  --port <num>       Port to listen on (default: ${DEFAULT_PORT})
  --hostname <host>  Hostname to bind to (default: ${DEFAULT_HOSTNAME})
  --detach          Run in background (don't block)
  --cwd <dir>       Working directory

Examples:
  flowguard serve
  flowguard serve --port 4096 --detach`;
}

export async function runMain(argv: string[]): Promise<number> {
  const parsed = parseRunArgs(argv);

  if (!parsed) {
    console.log(getRunUsage());
    return 1;
  }

  console.log(formatRunResult(await run(parsed.config)));
  return parsed.config.prompt ? 0 : 1;
}

export async function serveMain(argv: string[]): Promise<number> {
  const parsed = parseServeArgs(argv);

  if (!parsed) {
    console.log(getServeUsage());
    return 1;
  }

  const result = await serve(parsed.config);

  if (result.success) {
    console.log(`[ok] Server started on port ${result.port}`);
    if (result.pid) {
      console.log(`    PID: ${result.pid}`);
    }
  } else {
    console.log(`[error] ${result.error}`);
  }

  return result.success ? 0 : 1;
}
/**
 * @module cli/run
 * @description Headless wrapper for operating FlowGuard via OpenCode's headless modes.
 *
 * Usage:
 *   flowguard run --prompt "..." [--server-url <url>] [--attach]
 *   flowguard serve [--port <port>] [--hostname <hostname>]
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import type { ChildProcess } from 'node:child_process';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RunResult {
  success: boolean;
  output?: string;
  error?: string;
  serverPid?: number;
}

export interface HeadlessConfig {
  serverUrl?: string;
  prompt: string;
  attach?: boolean;
  stopServerAfter?: boolean;
  cwd?: string;
  serverPassword?: string;
  serverUsername?: string;
  env?: Record<string, string>;
}

export interface ServeConfig {
  port?: number;
  hostname?: string;
  mdns?: boolean;
  cors?: string[];
  serverPassword?: string;
  serverUsername?: string;
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

export async function run(config: HeadlessConfig): Promise<RunResult> {
  const {
    serverUrl,
    prompt,
    attach = false,
    stopServerAfter = true,
    cwd = process.cwd(),
    env,
  } = config;

  let serverProcess: ChildProcess | undefined;
  let serverPid: number | undefined;

  if (!attach && !serverUrl) {
    serverProcess = spawn('opencode', ['serve', '--port', String(DEFAULT_PORT)], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    serverPid = serverProcess.pid;
    const ready = await waitForServer(DEFAULT_PORT, SERVER_STARTUP_TIMEOUT_MS);

    if (!ready) {
      serverProcess.kill();
      return {
        success: false,
        error: `Server failed to start within ${SERVER_STARTUP_TIMEOUT_MS}ms`,
      };
    }

    // usedServer tracks whether we started a server (for logging/metrics in future)
  }

  try {
    const args = serverUrl
      ? ['run', '--attach', serverUrl, prompt]
      : ['run', prompt];

    const result = await executeOpenCode(args, { cwd, env });

    if (result.exitCode !== 0) {
      return {
        success: false,
        error: result.stderr || `Exit code: ${result.exitCode}`,
        serverPid,
      };
    }

    return {
      success: true,
      output: result.stdout,
      serverPid,
    };
  } finally {
    if (stopServerAfter && serverProcess) {
      serverProcess.kill();
    }
  }
}

// ─── Serve Implementation ─────────────────────────────────────────────────

export async function checkServer(port: number): Promise<boolean> {
  const available = await isPortAvailable(port);
  return !available;
}

export async function serve(
  config: ServeConfig,
): Promise<{ success: boolean; port: number; pid?: number; error?: string }> {
  const {
    port = DEFAULT_PORT,
    hostname: host = DEFAULT_HOSTNAME,
    mdns = false,
    cors = [],
    serverPassword,
    serverUsername,
    cwd = process.cwd(),
    env,
  } = config;

  const inUse = await checkServer(port);
  if (inUse) {
    return {
      success: false,
      port,
      error: `Port ${port} is already in use. Is a server already running?`,
    };
  }

  const serverEnv: Record<string, string> = { ...env };

  if (serverPassword) {
    serverEnv.OPENCODE_SERVER_PASSWORD = serverPassword;
    if (serverUsername) {
      serverEnv.OPENCODE_SERVER_USERNAME = serverUsername;
    }
  }

  const args = [
    'serve',
    '--port',
    String(port),
    '--hostname',
    host,
  ];

  if (mdns) {
    args.push('--mdns');
  }

  for (const origin of cors) {
    args.push('--cors', origin);
  }

  const serverProcess = spawn('opencode', args, {
    cwd,
    env: serverEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const serverPid = serverProcess.pid;

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
    pid: serverPid,
  };
}

// ─── Argument Parsing ─────────────────────────────────────────────────

export function parseRunArgs(argv: string[]): {
  config: HeadlessConfig;
  errors: string[];
} | null {
  const config: HeadlessConfig = {
    prompt: '',
    stopServerAfter: true,
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
    } else if (arg === '--attach') {
      config.attach = true;
    } else if (arg === '--no-stop') {
      config.stopServerAfter = false;
    } else if (arg === '--cwd') {
      const next = argv[i + 1];
      if (next) {
        config.cwd = next;
        i++;
      } else {
        errors.push('--cwd requires a value');
      }
    } else if (arg === '--password') {
      const next = argv[i + 1];
      if (next) {
        config.serverPassword = next;
        i++;
      } else {
        errors.push('--password requires a value');
      }
    } else if (arg === '--username') {
      const next = argv[i + 1];
      if (next) {
        config.serverUsername = next;
        i++;
      } else {
        errors.push('--username requires a value');
      }
    } else if (arg && !arg.startsWith('-')) {
      config.prompt = arg;
    }
  }

  if (!config.prompt && !config.serverUrl) {
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
        if (Number.isNaN(port)) {
          errors.push('--port requires a number');
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
    } else if (arg === '--mdns') {
      config.mdns = true;
    } else if (arg === '--cors') {
      const next = argv[i + 1];
      if (next) {
        config.cors = next.split(',');
        i++;
      } else {
        errors.push('--cors requires a value');
      }
    } else if (arg === '--password') {
      const next = argv[i + 1];
      if (next) {
        config.serverPassword = next;
        i++;
      } else {
        errors.push('--password requires a value');
      }
    } else if (arg === '--username') {
      const next = argv[i + 1];
      if (next) {
        config.serverUsername = next;
        i++;
      } else {
        errors.push('--username requires a value');
      }
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
  const lines: string[] = [];

  if (result.success) {
    lines.push('[ok] Command executed successfully');
    if (result.output) {
      lines.push('');
      lines.push(result.output);
    }
  } else {
    lines.push(`[error] ${result.error ?? 'Unknown error'}`);
  }

  if (result.serverPid) {
    lines.push(`  Server PID: ${result.serverPid}`);
  }

  return lines.join('\n');
}

export function getRunUsage(): string {
  return `Usage: flowguard run [options] [--] <prompt>

Execute FlowGuard commands in headless mode.

Options:
  --prompt <text>     FlowGuard command to execute
  --server-url <url>  Attach to an existing server
  --attach            Don't start a server
  --no-stop           Don't stop server after execution
  --cwd <dir>         Working directory
  --password <pass>   Server auth password
  --username <user>   Server auth username

Examples:
  flowguard run "Run /hydrate policyMode=team-ci"
  flowguard run --server-url http://localhost:4096 "Run /validate"`;
}

export function getServeUsage(): string {
  return `Usage: flowguard serve [options]

Start an OpenCode server for headless FlowGuard operation.

Options:
  --port <num>       Port to listen on (default: ${DEFAULT_PORT})
  --hostname <host>  Hostname to bind to (default: ${DEFAULT_HOSTNAME})
  --mdns             Enable mDNS discovery
  --cors <origins>   Additional CORS origins
  --password <pass>  Server auth password
  --username <user>  Server auth username
  --cwd <dir>       Working directory

Examples:
  flowguard serve
  flowguard serve --port 4096 --password secret`;

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
/**
 * @module verification/toolchain-probe
 * @description Declarative runtime toolchain probing.
 *
 * Checks whether required executables, runtimes, and reporter modules are
 * available in the execution environment. Produces advisory ToolAvailability
 * results — never installs anything, never accesses network.
 *
 * Read-only. No auto-install. Probe commands come only from the trusted
 * static provider catalog — never from repository content.
 *
 * @version v1
 */

import { execFile } from 'node:child_process';

// ─── Types ──────────────────────────────────────────────────────────────────

export type ProbeRole = 'runtime' | 'tool' | 'reporter';

export interface ProbeSpec {
  readonly id: string;
  readonly role: ProbeRole;
  readonly command: string;
  readonly versionPattern?: string;
}

export interface ProbeRequest {
  readonly tool: ProbeSpec;
  readonly cwd: string;
}

export type ToolAvailability =
  | { readonly status: 'available'; readonly version?: string }
  | { readonly status: 'missing' }
  | { readonly status: 'unknown'; readonly reason: string };

export type ProbeResult = ToolAvailability;

export interface ProbeRunner {
  probe(request: ProbeRequest): Promise<ProbeResult>;
}

// ─── Production Runner ──────────────────────────────────────────────────────

const PROBE_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 10_240;

export class ProcessProbeRunner implements ProbeRunner {
  private readonly cache = new Map<string, Promise<ProbeResult>>();

  async probe(request: ProbeRequest): Promise<ProbeResult> {
    const cacheKey = `${request.tool.command}:${request.cwd}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const promise = this.runProbe(request);
    this.cache.set(cacheKey, promise);
    return promise;
  }

  private async runProbe(request: ProbeRequest): Promise<ProbeResult> {
    const { tool, cwd } = request;
    const tokens = parseShellCommand(tool.command);
    if (tokens.length === 0) {
      return { status: 'unknown', reason: `empty probe command: ${tool.command}` };
    }
    const cmd = tokens[0]!;
    const args = tokens.slice(1);

    try {
      const result = await execWithTimeout(cmd, args, cwd, PROBE_TIMEOUT_MS);
      if (result.timedOut) {
        return { status: 'unknown', reason: `probe timed out after ${PROBE_TIMEOUT_MS}ms` };
      }

      if (result.exitCode === 0) {
        let version: string | undefined;
        if (tool.versionPattern) {
          const re = new RegExp(tool.versionPattern);
          const match = re.exec(result.stdout);
          version = match?.[1];
        }
        return { status: 'available', version };
      }

      return { status: 'unknown', reason: `probe exited with code ${result.exitCode}` };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return { status: 'missing' };
      }
      return { status: 'unknown', reason: String(err) };
    }
  }
}

// ─── Internal — subprocess execution ────────────────────────────────────────

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function execWithTimeout(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const child = execFile(command, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      windowsVerbatimArguments: true,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < MAX_OUTPUT_BYTES)
        stdout += chunk.slice(0, MAX_OUTPUT_BYTES - stdout.length);
    });
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < MAX_OUTPUT_BYTES)
        stderr += chunk.slice(0, MAX_OUTPUT_BYTES - stderr.length);
    });

    child.on('error', (err: { code?: string }) => {
      if (settled) return;
      settled = true;
      reject(err);
    });

    child.on('close', (code: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      resolve({
        exitCode: code ?? -1,
        stdout: stdout.slice(0, MAX_OUTPUT_BYTES),
        stderr: stderr.slice(0, MAX_OUTPUT_BYTES),
        timedOut: signal === 'SIGTERM',
      });
    });
  });
}

function parseShellCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else current += ch;
    } else if (inDouble) {
      if (ch === '"') inDouble = false;
      else current += ch;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === ' ' || ch === '\t') {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

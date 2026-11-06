/**
 * @module cli/debug-export-host
 * @description Host-specific transcript capture for the CLI diagnostic export.
 *
 * The adapter-side validator owns shape/identity checks. This CLI module owns
 * executable invocation, byte/time bounds and typed process failures.
 */

import { spawn } from 'node:child_process';

import {
  DiagnosticHostError,
  validateHostTranscript,
  type HostTranscript,
} from '../adapters/diagnostics/index.js';

type HostTranscriptReadErrorCode =
  'HOST_EXPORT_FAILED' | 'HOST_EXPORT_TIMEOUT' | 'HOST_EXPORT_TOO_LARGE';

class HostTranscriptReadError extends Error {
  readonly code: HostTranscriptReadErrorCode;

  constructor(code: HostTranscriptReadErrorCode, message: string) {
    super(message);
    this.name = 'HostTranscriptReadError';
    this.code = code;
  }
}

export interface HostTranscriptReadOptions {
  readonly workspace: string;
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly command?: string;
}

interface CapturedProcess {
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly code: number;
}

function runExportProcess(
  command: string,
  sessionId: string,
  options: HostTranscriptReadOptions,
): Promise<CapturedProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['export', sessionId], {
      cwd: options.workspace,
      env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: '1', PWD: options.workspace },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = '';
    let settled = false;
    const finish = (error?: Error, code = 1) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ stdout: Buffer.concat(chunks), stderr, code });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(
        new HostTranscriptReadError(
          'HOST_EXPORT_TIMEOUT',
          `Host transcript export timed out after ${options.timeoutMs} ms.`,
        ),
      );
    }, options.timeoutMs);
    timer.unref?.();

    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > options.maxBytes) {
        child.kill('SIGKILL');
        finish(
          new HostTranscriptReadError(
            'HOST_EXPORT_TOO_LARGE',
            `Host transcript exceeds the ${options.maxBytes}-byte capture limit.`,
          ),
        );
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      finish(
        new HostTranscriptReadError(
          'HOST_EXPORT_FAILED',
          `Host transcript export could not start: ${error.message}`,
        ),
      );
    });
    child.on('close', (code) => {
      if (code === 0) finish(undefined, 0);
      else
        finish(
          new HostTranscriptReadError(
            'HOST_EXPORT_FAILED',
            `Host transcript export failed (exit ${String(code)}): ${stderr.trim()}`,
          ),
        );
    });
  });
}

/**
 * Capture one host session through the installed host CLI. Failure is typed and
 * is never converted into an empty successful transcript.
 */
export async function readHostTranscript(
  sessionId: string,
  options: HostTranscriptReadOptions,
): Promise<HostTranscript> {
  const result = await runExportProcess(options.command ?? 'opencode', sessionId, options);
  if (result.stdout.byteLength > options.maxBytes) {
    throw new HostTranscriptReadError(
      'HOST_EXPORT_TOO_LARGE',
      `Host transcript exceeds the ${options.maxBytes}-byte capture limit.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.toString('utf8'));
  } catch {
    throw new DiagnosticHostError('HOST_EXPORT_INVALID', 'Host transcript is not valid JSON.');
  }
  return validateHostTranscript(parsed, sessionId, result.stdout.byteLength);
}

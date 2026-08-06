/**
 * process-runner.ts
 *
 * Generic shell-free process runner for eval case execution.
 * Spawns a configured command, passes the prompt via stdin, captures
 * stdout/stderr, enforces timeout, and returns a typed RunnerOutcome.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, cpSync, rmSync, mkdtempSync } from 'node:fs';
import { join, sep, basename } from 'node:path';
import { tmpdir } from 'node:os';
import type { RunnerConfig } from '../schema.js';
import type { WorkspaceSnapshot } from '../assertions.js';

// ── Outcome types ─────────────────────────────────────────────────────

export interface CompletedOutcome {
  status: 'completed';
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  beforeSnapshot: WorkspaceSnapshot;
  afterSnapshot: WorkspaceSnapshot;
  beforeContent: Map<string, string>;
  afterContent: Map<string, string>;
}

export interface RunnerErrorOutcome {
  status: 'runner_error';
  errorKind: 'spawn' | 'timeout' | 'signal' | 'workspace' | 'internal';
  message: string;
  stdout: string;
  stderr: string;
}

export type RunnerOutcome = CompletedOutcome | RunnerErrorOutcome;

// ── Ignored paths ─────────────────────────────────────────────────────

const IGNORED_PREFIXES = ['.git', 'node_modules', 'eval-results', 'tmp'];
const IGNORED_NAMES = new Set(['.DS_Store', 'Thumbs.db']);

function isIgnored(relPath: string): boolean {
  if (IGNORED_NAMES.has(basename(relPath))) return true;
  return IGNORED_PREFIXES.some(
    (p) => relPath === p || relPath.startsWith(p + '/') || relPath.startsWith(p + '\\'),
  );
}

// ── Snapshot ──────────────────────────────────────────────────────────

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function snapshotWorkspace(
  root: string,
): { entries: WorkspaceSnapshot; contents: Map<string, string> } {
  const entries: WorkspaceSnapshot = new Map();
  const contents = new Map<string, string>();
  walk(root, '', entries, contents);
  return { entries, contents };
}

function walk(
  root: string,
  relDir: string,
  entries: WorkspaceSnapshot,
  contents: Map<string, string>,
): void {
  const fullDir = join(root, relDir);
  let dirents: ReturnType<typeof readdirSync>;
  try {
    dirents = readdirSync(fullDir);
  } catch {
    return;
  }
  for (const name of dirents) {
    const relPath = relDir ? join(relDir, name) : name;
    if (isIgnored(relPath)) continue;
    const fullPath = join(root, relPath);
    let st;
    try {
      st = lstatSync(fullPath);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      walk(root, relPath, entries, contents);
    } else {
      // codeql[js/file-system-race] — deterministic eval test snapshot,
      // single-threaded, lstat→readFileSync gap is not exploitable here
      try {
        const buf = readFileSync(fullPath);
        const snapshotPath = relPath.split(sep).join('/');
        entries.set(snapshotPath, { sha256: sha256(buf), bytes: buf.length });
        contents.set(snapshotPath, buf.toString('utf-8'));
      } catch {
        // file was removed or changed between lstat and read — skip
      }
    }
  }
}

// ── Workspace setup ───────────────────────────────────────────────────

function setupWorkspace(
  fixtureRoot: string,
  forceCopy: boolean,
): { workspaceRoot: string; cleanup: () => void } | RunnerErrorOutcome {
  if (!forceCopy) {
    return {
      workspaceRoot: fixtureRoot,
      cleanup: () => {},
    };
  }

  const wsRoot = mkdtempSync(join(tmpdir(), 'eval-ws-'));
  try {
    cpSync(fixtureRoot, wsRoot, { recursive: true, dereference: false });
  } catch (err) {
    return {
      status: 'runner_error',
      errorKind: 'workspace',
      message: `Failed to copy workspace: ${(err as Error).message}`,
      stdout: '',
      stderr: '',
    };
  }

  return {
    workspaceRoot: wsRoot,
    cleanup: () => {
      try {
        rmSync(wsRoot, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    },
  };
}

// ── Process execution ─────────────────────────────────────────────────

export async function runProcess(
  config: RunnerConfig,
  fixtureRoot: string,
  prompt: string,
  forceCopy: boolean,
): Promise<RunnerOutcome> {
  const ws = setupWorkspace(fixtureRoot, forceCopy);
  if ('status' in ws) return ws;

  const { workspaceRoot, cleanup } = ws;

  const before = snapshotWorkspace(workspaceRoot);

  let child: ChildProcess;
  const startMs = Date.now();

  return new Promise<RunnerOutcome>((resolve) => {
    try {
      child = spawn(config.command, config.args, {
        cwd: workspaceRoot,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      cleanup();
      resolve({
        status: 'runner_error',
        errorKind: 'spawn',
        message: `Failed to spawn "${config.command}": ${(err as Error).message}`,
        stdout: '',
        stderr: '',
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (outcome: RunnerOutcome) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({
        status: 'runner_error',
        errorKind: 'timeout',
        message: `Process timed out after ${config.timeoutMs}ms`,
        stdout,
        stderr,
      });
    }, config.timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      finish({
        status: 'runner_error',
        errorKind: 'spawn',
        message: `Process error: ${err.message}`,
        stdout,
        stderr,
      });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);

      if (signal) {
        finish({
          status: 'runner_error',
          errorKind: 'signal',
          message: `Process terminated by signal ${signal}`,
          stdout,
          stderr,
        });
        return;
      }

      const durationMs = Date.now() - startMs;
      const exitCode = code ?? -1;

      const after = snapshotWorkspace(workspaceRoot);

      finish({
        status: 'completed',
        exitCode,
        stdout,
        stderr,
        durationMs,
        beforeSnapshot: before.entries,
        afterSnapshot: after.entries,
        beforeContent: before.contents,
        afterContent: after.contents,
      });
    });

    // Write prompt to stdin and close it
    child.stdin?.end(prompt);
  });
}

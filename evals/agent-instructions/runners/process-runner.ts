/**
 * process-runner.ts
 *
 * Generic shell-free process runner for eval case execution.
 * Spawns a configured command, captures stdout/stderr, enforces
 * timeout, and returns a typed RunnerOutcome.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, cpSync, rmSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { tmpdir } from 'node:os';
import type { RunnerConfig } from './schema.js';
import type { WorkspaceSnapshot, WorkspaceEntry } from './assertions.js';

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
      st = statSync(fullPath);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      walk(root, relPath, entries, contents);
    } else if (st.isFile()) {
      const buf = readFileSync(fullPath);
      entries.set(relPath, { sha256: sha256(buf), bytes: buf.length });
      contents.set(relPath, buf.toString('utf-8'));
    }
  }
}

// ── Workspace setup ───────────────────────────────────────────────────

export function setupWorkspace(
  fixtureRoot: string,
  mode: 'copy' | 'none',
): { workspaceRoot: string; cleanup: () => void } | RunnerErrorOutcome {
  if (mode === 'none') {
    return {
      workspaceRoot: fixtureRoot,
      cleanup: () => {},
    };
  }

  const wsRoot = join(tmpdir(), `eval-ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
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
  cwd?: string,
): Promise<RunnerOutcome> {
  const ws = setupWorkspace(fixtureRoot, config.workspaceMode);
  if ('status' in ws) return ws;

  const { workspaceRoot, cleanup } = ws;
  const effectiveCwd = cwd ?? workspaceRoot;

  const before = snapshotWorkspace(effectiveCwd);

  const startMs = Date.now();
  let child: ChildProcess;
  try {
    child = spawn(config.command, config.args, {
      cwd: effectiveCwd,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    cleanup();
    return {
      status: 'runner_error',
      errorKind: 'spawn',
      message: `Failed to spawn "${config.command}": ${(err as Error).message}`,
      stdout: '',
      stderr: '',
    };
  }

  let stdout = '';
  let stderr = '';

  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf-8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf-8');
  });

  const timedOut = await new Promise<'timeout' | null>((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), config.timeoutMs);
    child.on('close', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });

  if (timedOut === 'timeout') {
    child.kill('SIGKILL');
    // drain any remaining output
    await new Promise<void>((resolve) => {
      child.on('close', () => resolve());
      setTimeout(() => resolve(), 2000);
    });
    cleanup();
    return {
      status: 'runner_error',
      errorKind: 'timeout',
      message: `Process timed out after ${config.timeoutMs}ms`,
      stdout,
      stderr,
    };
  }

  const signal = child.signalCode;
  if (signal) {
    cleanup();
    return {
      status: 'runner_error',
      errorKind: 'signal',
      message: `Process terminated by signal ${signal}`,
      stdout,
      stderr,
    };
  }

  const durationMs = Date.now() - startMs;
  const exitCode = child.exitCode ?? -1;

  const after = snapshotWorkspace(effectiveCwd);
  cleanup();

  return {
    status: 'completed',
    exitCode,
    stdout,
    stderr,
    durationMs,
    beforeSnapshot: before.entries,
    afterSnapshot: after.entries,
    beforeContent: before.contents,
    afterContent: after.contents,
  };
}

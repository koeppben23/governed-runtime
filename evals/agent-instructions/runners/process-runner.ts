/**
 * process-runner.ts
 *
 * Generic shell-free process runner for eval case execution.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  readFileSync,
  readdirSync,
  lstatSync,
  cpSync,
  rmSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join, sep, basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import type { InstructionHost, InstructionSurface, RunnerConfig } from '../schema.js';
import type { WorkspaceSnapshot } from '../assertions.js';
import { buildMandatesContent } from '../../../src/rendering/mandates-renderer.js';
import { computeMandatesDigest } from '../../../src/cli/install-helpers.js';
import { mergeOpencodeJson } from '../../../src/cli/install-json.js';
import {
  CLAUDE_CODE_PLUGIN_DIR,
  claudeCodePluginFiles,
  CODEX_PLUGIN_NAME,
  codexPluginFiles,
} from '../../../src/cli/templates.js';
import { PACKAGE_VERSION } from '../../../src/shared/package-version.js';

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
  instructionSurface: InstructionSurface;
  instructionHost?: InstructionHost;
}

export interface RunnerErrorOutcome {
  status: 'runner_error';
  errorKind: 'spawn' | 'timeout' | 'signal' | 'workspace' | 'internal';
  message: string;
  stdout: string;
  stderr: string;
  instructionSurface?: InstructionSurface;
  instructionHost?: InstructionHost;
}

export type RunnerOutcome = CompletedOutcome | RunnerErrorOutcome;

const IGNORED_PREFIXES = ['.git', 'node_modules', 'eval-results', 'tmp'];
const IGNORED_NAMES = new Set(['.DS_Store', 'Thumbs.db']);
const MAX_CAPTURE_CHARS = 1_000_000;

function isIgnored(relPath: string): boolean {
  if (IGNORED_NAMES.has(basename(relPath))) return true;
  return IGNORED_PREFIXES.some(
    (p) => relPath === p || relPath.startsWith(p + '/') || relPath.startsWith(p + '\\'),
  );
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function snapshotWorkspace(root: string): {
  entries: WorkspaceSnapshot;
  contents: Map<string, string>;
} {
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

    let stat;
    try {
      stat = lstatSync(fullPath);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      walk(root, relPath, entries, contents);
      continue;
    }
    if (!stat.isFile()) continue;

    try {
      const buf = readFileSync(fullPath);
      const snapshotPath = relPath.split(sep).join('/');
      entries.set(snapshotPath, { sha256: sha256(buf), bytes: buf.length });
      contents.set(snapshotPath, buf.toString('utf-8'));
    } catch {
      // Snapshotting is best-effort for unreadable files; assertions cannot rely on absent content.
    }
  }
}

function setupWorkspace(
  fixtureRoot: string,
  forceCopy: boolean,
): { workspaceRoot: string; cleanup: () => void } | RunnerErrorOutcome {
  if (!forceCopy) return { workspaceRoot: fixtureRoot, cleanup: () => {} };

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

function outcomeMetadata(
  instructionSurface: InstructionSurface,
  instructionHost: InstructionHost | undefined,
): { instructionSurface: InstructionSurface; instructionHost?: InstructionHost } {
  return {
    instructionSurface,
    ...(instructionHost ? { instructionHost } : {}),
  };
}

function writeTemplateTree(root: string, files: Readonly<Record<string, string>>): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = join(root, relativePath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, 'utf-8');
  }
}

async function materializeInstructionSurface(
  workspaceRoot: string,
  instructionSurface: InstructionSurface,
  instructionHost: InstructionHost | undefined,
): Promise<string | null> {
  if (instructionSurface === 'repository_contributor') {
    return instructionHost === undefined
      ? null
      : 'repository_contributor evaluations must not declare a product instruction host';
  }
  if (instructionHost === undefined) {
    return 'flowguard_product evaluations require an explicit instruction host';
  }

  if (instructionHost === 'opencode') {
    const mandatesDir = join(workspaceRoot, '.opencode');
    mkdirSync(mandatesDir, { recursive: true });
    writeFileSync(
      join(mandatesDir, 'flowguard-mandates.md'),
      buildMandatesContent(PACKAGE_VERSION(), computeMandatesDigest()),
      'utf-8',
    );
    await mergeOpencodeJson(join(workspaceRoot, 'opencode.json'), 'repo');
    return null;
  }

  if (instructionHost === 'claude-code') {
    const pluginRoot = join(workspaceRoot, CLAUDE_CODE_PLUGIN_DIR);
    writeTemplateTree(pluginRoot, claudeCodePluginFiles(PACKAGE_VERSION()));
    return null;
  }

  const pluginRoot = join(workspaceRoot, 'plugins', CODEX_PLUGIN_NAME);
  writeTemplateTree(pluginRoot, codexPluginFiles(PACKAGE_VERSION()));
  const marketplaceDir = join(workspaceRoot, '.agents', 'plugins');
  mkdirSync(marketplaceDir, { recursive: true });
  writeFileSync(
    join(marketplaceDir, 'marketplace.json'),
    JSON.stringify(
      {
        name: CODEX_PLUGIN_NAME,
        plugins: [
          {
            name: CODEX_PLUGIN_NAME,
            source: { source: 'local', path: `./plugins/${CODEX_PLUGIN_NAME}` },
            policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
            category: 'Productivity',
          },
        ],
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );
  return null;
}

function appendBounded(current: string, chunk: Buffer): string {
  if (current.length >= MAX_CAPTURE_CHARS) return current;
  const text = chunk.toString('utf-8');
  const remaining = MAX_CAPTURE_CHARS - current.length;
  if (text.length <= remaining) return current + text;
  return current + text.slice(0, Math.max(0, remaining - 16)) + '\n[TRUNCATED]\n';
}

function killProcessTree(child: ChildProcess): void {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // Fall back to the direct child if the process group is already gone.
    }
  }
  child.kill('SIGKILL');
}

export async function runProcess(
  config: RunnerConfig,
  fixtureRoot: string,
  prompt: string,
  forceCopy: boolean,
  repoRoot: string,
  childEnv: NodeJS.ProcessEnv,
  instructionSurface: InstructionSurface,
  instructionHost?: InstructionHost,
): Promise<RunnerOutcome> {
  const metadata = outcomeMetadata(instructionSurface, instructionHost);
  const ws = setupWorkspace(fixtureRoot, forceCopy);
  if ('status' in ws) return { ...ws, ...metadata };

  const { workspaceRoot, cleanup } = ws;

  try {
    const surfaceError = await materializeInstructionSurface(
      workspaceRoot,
      instructionSurface,
      instructionHost,
    );
    if (surfaceError) {
      cleanup();
      return {
        status: 'runner_error',
        errorKind: 'workspace',
        message: surfaceError,
        stdout: '',
        stderr: '',
        ...metadata,
      };
    }
  } catch (err) {
    cleanup();
    return {
      status: 'runner_error',
      errorKind: 'workspace',
      message: `Failed to install FlowGuard product mandates: ${(err as Error).message}`,
      stdout: '',
      stderr: '',
      ...metadata,
    };
  }

  const before = snapshotWorkspace(workspaceRoot);
  const resolvedArgs = config.args.map((arg) =>
    arg.replaceAll('{repoRoot}', repoRoot).replaceAll('{workspaceRoot}', workspaceRoot),
  );
  const useStdin = config.promptTransport === 'stdin';
  if (!useStdin) {
    for (let index = 0; index < resolvedArgs.length; index++) {
      resolvedArgs[index] = resolvedArgs[index].replace('{prompt}', prompt);
    }
  }

  let child: ChildProcess;
  const startMs = Date.now();

  return new Promise<RunnerOutcome>((resolve) => {
    try {
      child = spawn(config.command, resolvedArgs, {
        cwd: workspaceRoot,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: childEnv,
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      cleanup();
      resolve({
        status: 'runner_error',
        errorKind: 'spawn',
        message: `Failed to spawn "${config.command}": ${(err as Error).message}`,
        stdout: '',
        stderr: '',
        ...metadata,
      });
      return;
    }

    let stdout = '';
    let stderrOut = '';
    let settled = false;

    const finish = (outcome: RunnerOutcome) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrOut = appendBounded(stderrOut, chunk);
    });

    const timer = setTimeout(() => {
      killProcessTree(child);
      finish({
        status: 'runner_error',
        errorKind: 'timeout',
        message: `Process timed out after ${config.timeoutMs}ms`,
        stdout,
        stderr: stderrOut,
        ...metadata,
      });
    }, config.timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      finish({
        status: 'runner_error',
        errorKind: 'spawn',
        message: `Process error: ${err.message}`,
        stdout,
        stderr: stderrOut,
        ...metadata,
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
          stderr: stderrOut,
          ...metadata,
        });
        return;
      }

      const after = snapshotWorkspace(workspaceRoot);
      finish({
        status: 'completed',
        exitCode: code ?? -1,
        stdout,
        stderr: stderrOut,
        durationMs: Date.now() - startMs,
        beforeSnapshot: before.entries,
        afterSnapshot: after.entries,
        beforeContent: before.contents,
        afterContent: after.contents,
        ...metadata,
      });
    });

    child.stdin?.end(useStdin ? prompt : undefined);
  });
}

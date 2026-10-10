/**
 * @module cli/inspect-upgrade-check-identity.test
 * @description Workspace-identity tests for `flowguard inspect`: canonical
 * worktree resolution (no phantom fingerprints), managed-vs-missing workspace
 * semantics, and the exit-code contract for wrong directories and git
 * infrastructure failures.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { makeState } from '../fixtures.js';
import { writeState } from '../adapters/persistence.js';
import { sessionDir, ensureWorkspace, workspaceDir } from '../adapters/workspace/index.js';
import { GitError } from '../adapters/git-command.js';
import { DEFAULT_CONFIG } from '../config/flowguard-config.js';
import { runUpgradePreflight } from '../adapters/workspace/upgrade-preflight.js';
import { writeRepoConfig } from '../adapters/persistence-config.js';
import { withTestEnv } from '../integration/test-helpers.js';
import { inspectMain } from './inspect-command.js';

const gitOriginals = vi.hoisted(() => ({
  resolveRoot: null as unknown as (typeof import('../adapters/git.js'))['resolveRoot'],
}));

vi.mock('../adapters/git', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/git.js')>();
  gitOriginals.resolveRoot = original.resolveRoot;
  return { ...original, resolveRoot: vi.fn(original.resolveRoot) };
});

const gitMock = await import('../adapters/git.js');

const originalCwd = process.cwd();

afterEach(async () => {
  process.chdir(originalCwd);
  vi.mocked(gitMock.resolveRoot).mockReset().mockImplementation(gitOriginals.resolveRoot);
  vi.restoreAllMocks();
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/** Isolated FlowGuard config home; returns the config directory. */
async function isolateConfigDir(): Promise<string> {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'upgrade-identity-cfg-'));
  const restore = withTestEnv({ OPENCODE_CONFIG_DIR: configDir });
  cleanups.push(async () => {
    restore();
    await fs.rm(configDir, { recursive: true, force: true });
  });
  return configDir;
}

/** Real (physical) git repository in the OS temp directory. */
async function makeGitRepo(parent?: string): Promise<string> {
  const created = await fs.mkdtemp(path.join(parent ?? os.tmpdir(), 'upgrade-identity-repo-'));
  const root = await fs.realpath(created);
  execFileSync('git', ['init', '--quiet', root], { windowsHide: true });
  cleanups.push(async () => {
    await fs.rm(created, { recursive: true, force: true });
  });
  return root;
}

/** Plain directory that is not a git repository. */
async function makePlainDir(): Promise<string> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), 'upgrade-identity-plain-'));
  const dir = await fs.realpath(created);
  cleanups.push(async () => {
    await fs.rm(created, { recursive: true, force: true });
  });
  return dir;
}

async function runInspect(
  args: readonly string[],
  cwd: string,
): Promise<{ exit: number; stdout: string; stderr: string }> {
  process.chdir(cwd);
  let stdout = '';
  let stderr = '';
  const log = console.log;
  const error = console.error;
  console.log = (value?: unknown) => {
    stdout += `${String(value)}\n`;
  };
  console.error = (value?: unknown) => {
    stderr += `${String(value)}\n`;
  };
  try {
    const exit = await inspectMain([...args]);
    return { exit, stdout, stderr };
  } finally {
    console.log = log;
    console.error = error;
  }
}

interface ParsedReport {
  upgradeReady: boolean;
  workspaceFingerprint: string | null;
  findings?: Array<{ code: string }>;
  sessions?: Array<{ findings: Array<{ code: string }> }>;
}

function parseReport(stdout: string): ParsedReport {
  return JSON.parse(stdout) as ParsedReport;
}

function reportCodes(report: ParsedReport): string[] {
  return (report.findings ?? []).map((finding) => finding.code);
}

/** Initialize a workspace and seed one active session; returns fingerprint. */
async function seedActiveSession(root: string): Promise<string> {
  const workspace = await ensureWorkspace(root);
  const sessDir = sessionDir(workspace.fingerprint, 'ses_identity_active');
  await fs.mkdir(sessDir, { recursive: true });
  await writeState(sessDir, makeState('PLAN'));
  return workspace.fingerprint;
}

describe('inspect workspace identity resolution', () => {
  it('lists nothing outside a git repository but fails explicit session and preflight lookups', async () => {
    await isolateConfigDir();
    const plain = await makePlainDir();

    const listed = await runInspect([], plain);
    expect(listed.exit).toBe(0);
    expect(listed.stdout).toContain('No FlowGuard sessions found.');

    const session = await runInspect(['--session', 'ses_missing'], plain);
    expect(session.exit).toBe(1);
    expect(session.stderr).toContain('Cannot resolve the workspace');
    expect(session.stdout).not.toContain('No FlowGuard sessions found.');

    const preflight = await runInspect(['--upgrade-check', '--json'], plain);
    expect(preflight.exit).toBe(1);
    const report = parseReport(preflight.stdout);
    expect(report.upgradeReady).toBe(false);
    expect(report.workspaceFingerprint).toBeNull();
    expect(reportCodes(report)).toContain('WORKSPACE_UNRESOLVED');
  });

  it('binds a subdirectory preflight to the resolved worktree root (no phantom fingerprint)', async () => {
    await isolateConfigDir();
    const root = await makeGitRepo();
    const fingerprint = await seedActiveSession(root);
    const subdir = path.join(root, 'deep', 'sub');
    await fs.mkdir(subdir, { recursive: true });

    const { exit, stdout } = await runInspect(['--upgrade-check', '--json'], subdir);
    expect(exit).toBe(1);
    const report = parseReport(stdout);
    expect(report.workspaceFingerprint).toBe(fingerprint);
    expect(
      report.sessions?.flatMap((session) => session.findings.map((finding) => finding.code)),
    ).toContain('ACTIVE_SESSION');
  });

  it('blocks a resolvable repository without an initialized FlowGuard workspace', async () => {
    await isolateConfigDir();
    const root = await makeGitRepo();

    const { exit, stdout } = await runInspect(['--upgrade-check', '--json'], root);
    expect(exit).toBe(1);
    const report = parseReport(stdout);
    expect(report.upgradeReady).toBe(false);
    expect(reportCodes(report)).toContain('WORKSPACE_NOT_INITIALIZED');
  });

  it('treats a repo-scoped install without sessions as a valid empty workspace', async () => {
    await isolateConfigDir();
    const root = await makeGitRepo();
    await writeRepoConfig(root, DEFAULT_CONFIG);

    const { exit, stdout } = await runInspect(['--upgrade-check', '--json'], root);
    expect(exit).toBe(0);
    const report = parseReport(stdout);
    expect(report.upgradeReady).toBe(true);
  });

  it('treats an initialized workspace without sessions as ready', async () => {
    await isolateConfigDir();
    const root = await makeGitRepo();
    const workspace = await ensureWorkspace(root);

    const { exit, stdout } = await runInspect(['--upgrade-check', '--json'], root);
    expect(exit).toBe(0);
    const report = parseReport(stdout);
    expect(report.upgradeReady).toBe(true);
    expect(report.workspaceFingerprint).toBe(workspace.fingerprint);
  });

  it('resolves a nested repository to its own identity instead of the outer workspace', async () => {
    await isolateConfigDir();
    const outer = await makeGitRepo();
    await seedActiveSession(outer);
    const inner = await makeGitRepo(outer);

    const blocked = await runInspect(['--upgrade-check', '--json'], inner);
    expect(blocked.exit).toBe(1);
    expect(reportCodes(parseReport(blocked.stdout))).toContain('WORKSPACE_NOT_INITIALIZED');
    expect(reportCodes(parseReport(blocked.stdout))).not.toContain('ACTIVE_SESSION');

    await ensureWorkspace(inner);
    const ready = await runInspect(['--upgrade-check', '--json'], inner);
    expect(ready.exit).toBe(0);
    expect(parseReport(ready.stdout).upgradeReady).toBe(true);
  });

  it('fails closed when the session inventory cannot be read', async () => {
    await isolateConfigDir();
    const root = await makeGitRepo();
    const workspace = await ensureWorkspace(root);
    const sessionsRoot = path.join(
      process.env.OPENCODE_CONFIG_DIR as string,
      'workspaces',
      workspace.fingerprint,
      'sessions',
    );
    await fs.rm(sessionsRoot, { recursive: true, force: true });
    await fs.writeFile(sessionsRoot, 'not a directory', 'utf8');

    const { exit, stdout } = await runInspect(['--upgrade-check', '--json'], root);
    expect(exit).toBe(1);
    expect(reportCodes(parseReport(stdout))).toContain('INVENTORY_UNREADABLE');
  });

  it('treats only NOT_GIT_REPO as an empty inventory in list mode', async () => {
    await isolateConfigDir();
    const plain = await makePlainDir();

    vi.mocked(gitMock.resolveRoot).mockRejectedValueOnce(
      new GitError('NOT_GIT_REPO', 'mock: not a repository'),
    );
    const notRepo = await runInspect([], plain);
    expect(notRepo.exit).toBe(0);
    expect(notRepo.stdout).toContain('No FlowGuard sessions found.');

    vi.mocked(gitMock.resolveRoot).mockRejectedValueOnce(
      new GitError('GIT_TIMEOUT', 'mock: git timed out'),
    );
    const timeout = await runInspect([], plain);
    expect(timeout.exit).toBe(1);
    expect(timeout.stderr).toContain('Cannot resolve the workspace');
    expect(timeout.stdout).not.toContain('No FlowGuard sessions found.');

    vi.mocked(gitMock.resolveRoot).mockRejectedValueOnce(
      new GitError('GIT_NOT_FOUND', 'mock: git executable missing'),
    );
    const notFound = await runInspect([], plain);
    expect(notFound.exit).toBe(1);
    expect(notFound.stdout).not.toContain('No FlowGuard sessions found.');

    vi.mocked(gitMock.resolveRoot).mockRejectedValueOnce(
      new GitError('NOT_GIT_REPO', 'mock: not a repository'),
    );
    const session = await runInspect(['--session', 'ses_missing'], plain);
    expect(session.exit).toBe(1);
  });

  it('blocks when the worktree identity changes after sessions existed (remote added)', async () => {
    await isolateConfigDir();
    const root = await makeGitRepo();
    await seedActiveSession(root);

    execFileSync('git', ['remote', 'add', 'origin', 'https://example.com/org/repo.git'], {
      cwd: root,
      windowsHide: true,
    });

    const { exit, stdout } = await runInspect(['--upgrade-check', '--json'], root);
    expect(exit).toBe(1);
    const report = parseReport(stdout);
    expect(report.upgradeReady).toBe(false);
    expect(reportCodes(report)).toContain('WORKSPACE_IDENTITY_CHANGED');
  });

  it('blocks when the worktree identity changes after sessions existed (remote removed)', async () => {
    await isolateConfigDir();
    const root = await makeGitRepo();
    execFileSync('git', ['remote', 'add', 'origin', 'https://example.com/org/repo.git'], {
      cwd: root,
      windowsHide: true,
    });
    await seedActiveSession(root);
    execFileSync('git', ['remote', 'remove', 'origin'], { cwd: root, windowsHide: true });

    const { exit, stdout } = await runInspect(['--upgrade-check', '--json'], root);
    expect(exit).toBe(1);
    expect(reportCodes(parseReport(stdout))).toContain('WORKSPACE_IDENTITY_CHANGED');
  });

  it('blocks when a shared-origin clone changes identity and its session lives in the shared store', async () => {
    await isolateConfigDir();
    const sharedRemote = 'https://example.com/org/shared-repo.git';

    const cloneB = await makeGitRepo();
    execFileSync('git', ['remote', 'add', 'origin', sharedRemote], {
      cwd: cloneB,
      windowsHide: true,
    });
    const shared = await ensureWorkspace(cloneB);

    const cloneA = await makeGitRepo();
    execFileSync('git', ['remote', 'add', 'origin', sharedRemote], {
      cwd: cloneA,
      windowsHide: true,
    });
    await writeRepoConfig(cloneA, DEFAULT_CONFIG);

    // Clone A's active session lives in the shared remote-fingerprint store;
    // workspace.json still records clone B as the initializer.
    const sessDir = sessionDir(shared.fingerprint, 'ses_clone_a');
    await fs.mkdir(sessDir, { recursive: true });
    const base = makeState('PLAN');
    await writeState(sessDir, { ...base, binding: { ...base.binding, worktree: cloneA } });

    execFileSync('git', ['remote', 'set-url', 'origin', 'https://example.com/org/moved.git'], {
      cwd: cloneA,
      windowsHide: true,
    });

    const { exit, stdout } = await runInspect(['--upgrade-check', '--json'], cloneA);
    expect(exit).toBe(1);
    const report = parseReport(stdout);
    expect(report.upgradeReady).toBe(false);
    expect(reportCodes(report)).toContain('WORKSPACE_IDENTITY_CHANGED');
  });

  it('does not ignore a session store whose metadata is missing', async () => {
    await isolateConfigDir();
    const root = await makeGitRepo();
    await ensureWorkspace(root);

    const orphan = 'c'.repeat(24);
    const sessDir = sessionDir(orphan, 'ses_orphan');
    await fs.mkdir(sessDir, { recursive: true });
    const base = makeState('PLAN');
    await writeState(sessDir, { ...base, binding: { ...base.binding, worktree: root } });

    const { exit, stdout } = await runInspect(['--upgrade-check', '--json'], root);
    expect(exit).toBe(1);
    expect(reportCodes(parseReport(stdout))).toContain('WORKSPACE_IDENTITY_CHANGED');
  });

  it('fails closed when a foreign session binding cannot be read', async () => {
    await isolateConfigDir();
    const root = await makeGitRepo();
    await ensureWorkspace(root);

    const orphan = 'c'.repeat(24);
    const sessDir = sessionDir(orphan, 'ses_orphan');
    await fs.mkdir(sessDir, { recursive: true });
    await fs.writeFile(path.join(sessDir, 'session-state.json'), '{ not json', 'utf8');

    const { exit, stdout } = await runInspect(['--upgrade-check', '--json'], root);
    expect(exit).toBe(1);
    expect(reportCodes(parseReport(stdout))).toContain('INVENTORY_UNREADABLE');
  });

  it('does not block on an unrelated store with inconsistent metadata and no sessions', async () => {
    await isolateConfigDir();
    const root = await makeGitRepo();
    await ensureWorkspace(root);

    const stranger = 'd'.repeat(24);
    await fs.mkdir(workspaceDir(stranger), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir(stranger), 'workspace.json'),
      JSON.stringify({
        schemaVersion: 'workspace.v1',
        fingerprint: 'e'.repeat(24),
        materialClass: 'local_path',
        canonicalRemote: null,
        worktreePath: '/definitely/elsewhere',
        createdAt: new Date().toISOString(),
      }),
      'utf8',
    );

    const { exit, stdout } = await runInspect(['--upgrade-check', '--json'], root);
    expect(exit).toBe(0);
    expect(parseReport(stdout).upgradeReady).toBe(true);
  });

  it('reports workspace-not-initialized from the read model for an unmanaged fingerprint', async () => {
    await isolateConfigDir();
    const root = await makeGitRepo();

    const result = await runUpgradePreflight({
      fingerprint: 'b'.repeat(24),
      worktreeRoot: root,
      normalizedRoot: root,
    });
    expect(result.kind).toBe('workspace-not-initialized');
  });
});

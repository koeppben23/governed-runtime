/**
 * @module cli/inspect-upgrade-check.test
 * @description Pre-upgrade preflight tests: discovery (including sessions
 * without audit), classification matrix, archive mapping/extractability, and
 * the exit-code contract.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { ARCHIVE_LAYOUT_VERSION, ARCHIVE_MANIFEST_SCHEMA_VERSION } from '../archive/types.js';
import { makeState } from '../fixtures.js';
import { writeState } from '../adapters/persistence.js';
import { sessionDir, workspaceDir } from '../adapters/workspace/index.js';
import { isTarAvailable, withTestEnv } from '../integration/test-helpers.js';
import {
  classifyAuditMember,
  classifyManifestMember,
  combineArchiveContract,
  type UpgradeCheckReport,
} from '../adapters/workspace/upgrade-preflight.js';
import { runUpgradeCheck, reportWorkspaceUnresolved } from './inspect-upgrade-check.js';
import { getInspectUsage, parseInspectArgs } from './inspect-command.js';
import { defaultReasonRegistry } from '../config/reasons.js';

const tarOk = await isTarAvailable();
const execFileAsync = promisify(execFile);
const FINGERPRINT = 'a'.repeat(24);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

let workspaceConfigDir: string | null = null;

async function createWorkspaceRoot(
  options: { readonly createSessions?: boolean } = {},
): Promise<{ configDir: string; sessionsRoot: string }> {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'upgrade-check-'));
  workspaceConfigDir = configDir;
  const restore = withTestEnv({ OPENCODE_CONFIG_DIR: configDir });
  cleanups.push(async () => {
    restore();
    await fs.rm(configDir, { recursive: true, force: true });
  });
  const sessionsRoot = path.join(workspaceDir(FINGERPRINT), 'sessions');
  if (options.createSessions === false) {
    // Managed workspace without a sessions directory (never used).
    await fs.mkdir(workspaceDir(FINGERPRINT), { recursive: true });
  } else {
    await fs.mkdir(sessionsRoot, { recursive: true });
  }
  return { configDir, sessionsRoot };
}

async function seedSession(
  sessionsRoot: string,
  sessionId: string,
  options: { readonly phase?: string; readonly state?: boolean; readonly audit?: boolean } = {},
): Promise<string> {
  const sessDir = sessionDir(FINGERPRINT, sessionId);
  await fs.mkdir(sessDir, { recursive: true });
  if (options.state !== false) {
    await writeState(sessDir, makeState((options.phase ?? 'COMPLETE') as never));
  }
  if (options.audit === true) {
    await fs.writeFile(path.join(sessDir, 'audit.jsonl'), '', 'utf8');
  }
  return sessDir;
}

async function runCheck(): Promise<{ exit: number; report: UpgradeCheckReport }> {
  let output = '';
  const original = console.log;
  console.log = (value?: unknown) => {
    output += `${String(value)}\n`;
  };
  try {
    const exit = await runUpgradeCheck(
      { fingerprint: FINGERPRINT, worktreeRoot: workspaceConfigDir ?? process.cwd() },
      true,
    );
    return { exit, report: JSON.parse(output) as UpgradeCheckReport };
  } finally {
    console.log = original;
  }
}

function findingCodes(report: UpgradeCheckReport): string[] {
  return [
    ...report.sessions.flatMap((s) => s.findings.map((f) => f.code)),
    ...report.archives.flatMap((a) => a.findings.map((f) => f.code)),
  ];
}

describe('inspect --upgrade-check argument contract', () => {
  it('parses the flag and allows --json with it', () => {
    const parsed = parseInspectArgs(['--upgrade-check', '--json']);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.args.upgradeCheck).toBe(true);
      expect(parsed.args.json).toBe(true);
      expect(parsed.args.sessionId).toBeUndefined();
    }
  });

  it('rejects --upgrade-check combined with --session', () => {
    const parsed = parseInspectArgs(['--upgrade-check', '--session', 'sid']);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('cannot be combined');
  });

  it('documents the flag in the usage text', () => {
    expect(getInspectUsage()).toContain('--upgrade-check');
  });
});

describe('inspect --upgrade-check classification helpers', () => {
  it('combines archive contract status with integrity outranking oldness', () => {
    expect(combineArchiveContract('compatible', 'compatible')).toBe('compatible');
    expect(combineArchiveContract('compatible', 'unknown')).toBe('unknown');
    expect(combineArchiveContract('incompatible', 'compatible')).toBe('incompatible');
    expect(combineArchiveContract('incompatible', 'invalid')).toBe('invalid');
    expect(combineArchiveContract('unknown', 'unknown')).toBe('unknown');
  });

  it('classifies manifest members against the current contract', () => {
    expect(classifyManifestMember({ kind: 'blocked' })).toBe('unknown');
    expect(classifyManifestMember({ kind: 'ok', content: 'not json' })).toBe('unknown');
    expect(
      classifyManifestMember({
        kind: 'ok',
        content: JSON.stringify({ schemaVersion: 'archive-manifest.v3' }),
      }),
    ).toBe('incompatible');
    expect(
      classifyManifestMember({
        kind: 'ok',
        content: JSON.stringify({ schemaVersion: ARCHIVE_MANIFEST_SCHEMA_VERSION }),
      }),
    ).toBe('invalid');
    expect(
      classifyManifestMember({
        kind: 'ok',
        content: JSON.stringify({
          schemaVersion: ARCHIVE_MANIFEST_SCHEMA_VERSION,
          layoutVersion: ARCHIVE_LAYOUT_VERSION,
          createdAt: '2026-01-01T00:00:00.000Z',
          sessionId: 'sid-1',
          fingerprint: FINGERPRINT,
          policyMode: 'team',
          profileId: 'baseline',
          discoveryDigest: null,
          auditChainHead: 'genesis',
          auditEventCount: 0,
          includedFiles: [],
          fileDigests: {},
          contentDigest: 'digest',
        }),
      }),
    ).toBe('compatible');
  });

  it('classifies audit members against the current envelope/chain contract', () => {
    expect(classifyAuditMember({ kind: 'blocked' })).toBe('unknown');
    expect(classifyAuditMember({ kind: 'ok', content: 'not json' })).toBe('unknown');
    expect(classifyAuditMember({ kind: 'ok', content: JSON.stringify({}) })).toBe('incompatible');
    expect(classifyAuditMember({ kind: 'ok', content: '' })).toBe('compatible');
  });
});

describe('inspect --upgrade-check workspace report', () => {
  it('reports an empty workspace as upgrade-ready', async () => {
    await createWorkspaceRoot();
    const { exit, report } = await runCheck();
    expect(exit).toBe(0);
    expect(report.upgradeReady).toBe(true);
    expect(report.summary).toMatchObject({ sessions: 0, archives: 0, blockers: 0 });
  });

  it('treats a workspace without a sessions directory as empty inventory', async () => {
    const { sessionsRoot } = await createWorkspaceRoot({ createSessions: false });
    await expect(fs.stat(sessionsRoot)).rejects.toMatchObject({ code: 'ENOENT' });

    const { exit, report } = await runCheck();
    expect(exit).toBe(0);
    expect(report.upgradeReady).toBe(true);
    expect(report.summary).toMatchObject({ sessions: 0, archives: 0, blockers: 0 });
    expect(report.sessions).toEqual([]);
    expect(report.archives).toEqual([]);
  });

  it.runIf(process.platform !== 'win32')(
    'blocks on an invalid session directory name instead of crashing',
    async () => {
      const { sessionsRoot } = await createWorkspaceRoot();
      await fs.mkdir(path.join(sessionsRoot, 'legacy.'), { recursive: true });

      const { exit, report } = await runCheck();
      expect(exit).toBe(1);
      expect(report.sessions).toHaveLength(1);
      expect(report.sessions[0]).toMatchObject({ sessionId: 'legacy.', state: 'unreadable' });
      expect(findingCodes(report)).toContain('SESSION_DIR_NAME_INVALID');
    },
  );

  it('blocks on an active session and passes for a terminal one', async () => {
    const { sessionsRoot } = await createWorkspaceRoot();
    await seedSession(sessionsRoot, 'active-1', { phase: 'PLAN' });
    await seedSession(sessionsRoot, 'done-1', { phase: 'COMPLETE' });

    const { exit, report } = await runCheck();
    expect(exit).toBe(1);
    expect(report.summary.blockers).toBe(1);
    expect(findingCodes(report)).toContain('ACTIVE_SESSION');
    expect(report.sessions.find((s) => s.sessionId === 'done-1')?.terminal).toBe(true);
  });

  it('blocks on an incompatible persisted state', async () => {
    const { sessionsRoot } = await createWorkspaceRoot();
    const sessDir = await seedSession(sessionsRoot, 'legacy-1', { state: false });
    await fs.writeFile(
      path.join(sessDir, 'session-state.json'),
      JSON.stringify({ schemaVersion: 'v9' }),
      'utf8',
    );

    const { exit, report } = await runCheck();
    expect(exit).toBe(1);
    expect(findingCodes(report)).toContain('STATE_INCOMPATIBLE');
  });

  it('never recommends archiving active or aborted sessions in recovery guidance', async () => {
    const { sessionsRoot } = await createWorkspaceRoot();
    await seedSession(sessionsRoot, 'active-1', { phase: 'PLAN' });
    const sessDir = await seedSession(sessionsRoot, 'legacy-1', { state: false });
    await fs.writeFile(
      path.join(sessDir, 'session-state.json'),
      JSON.stringify({ schemaVersion: 'v9' }),
      'utf8',
    );

    const { report } = await runCheck();
    const recoveries = report.sessions
      .flatMap((session) => session.findings)
      .flatMap((finding) => finding.recovery ?? []);

    // Active sessions: archiving is only mentioned as a phase constraint.
    const activeLines = recoveries.filter((line) => line.includes('Complete the session'));
    expect(activeLines.length).toBeGreaterThan(0);
    for (const line of activeLines) {
      expect(line).not.toContain('or archive it');
      expect(line).toContain('terminal phase');
    }

    // Incompatible state: no promise that any terminal session is archivable.
    expect(recoveries.some((line) => line.includes('release that wrote'))).toBe(true);
    expect(recoveries.some((line) => line.includes('complete active sessions normally'))).toBe(
      true,
    );
    expect(
      recoveries.some((line) => line.toLowerCase().includes('archive preflight permits')),
    ).toBe(true);
    expect(recoveries.some((line) => line.includes('aborted or otherwise non-exportable'))).toBe(
      true,
    );

    // The reason registry carries the same operator contract.
    const incompatibleContract =
      defaultReasonRegistry.get('STATE_INCOMPATIBLE')?.recoverySteps.join(' ') ?? '';
    expect(incompatibleContract).toContain('archive preflight permits');
    expect(incompatibleContract).toContain('aborted or otherwise non-exportable');
    const activeContract =
      defaultReasonRegistry.get('ACTIVE_SESSION')?.recoverySteps.join(' ') ?? '';
    expect(activeContract).toContain('terminal phase');
    expect(activeContract).not.toContain('Or archive it');
  });

  it('blocks when state is missing but a live audit trail exists', async () => {
    const { sessionsRoot } = await createWorkspaceRoot();
    await seedSession(sessionsRoot, 'half-1', { state: false, audit: true });

    const { exit, report } = await runCheck();
    expect(exit).toBe(1);
    expect(findingCodes(report)).toContain('STATE_MISSING_WITH_AUDIT');
  });

  it('warns (but does not block) for a terminal session without an audit trail', async () => {
    const { sessionsRoot } = await createWorkspaceRoot();
    await seedSession(sessionsRoot, 'no-audit-1', { phase: 'COMPLETE', audit: false });

    const { exit, report } = await runCheck();
    expect(exit).toBe(0);
    expect(report.summary.blockers).toBe(0);
    expect(findingCodes(report)).toContain('AUDIT_MISSING');
  });

  it('warns (but does not block) for an empty session directory', async () => {
    const { sessionsRoot } = await createWorkspaceRoot();
    await seedSession(sessionsRoot, 'empty-1', { state: false, audit: false });

    const { exit, report } = await runCheck();
    expect(exit).toBe(0);
    expect(findingCodes(report)).toContain('EMPTY_SESSION_DIR');
  });
});

describe.skipIf(!tarOk)('inspect --upgrade-check archive classification', () => {
  async function createArchive(
    sessionsRoot: string,
    fileName: string,
    rootSessionId: string,
  ): Promise<void> {
    const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'upgrade-archive-'));
    cleanups.push(() => fs.rm(staging, { recursive: true, force: true }));
    const auditDir = path.join(staging, rootSessionId, 'audit');
    await fs.mkdir(auditDir, { recursive: true });
    await fs.writeFile(path.join(auditDir, 'audit.jsonl'), '', 'utf8');
    const archiveDir = path.join(sessionsRoot, 'archive');
    await fs.mkdir(archiveDir, { recursive: true });
    await execFileAsync('tar', [
      '-czf',
      path.join(archiveDir, fileName),
      '-C',
      staging,
      `${rootSessionId}/audit/audit.jsonl`,
    ]);
  }

  it('confirms the session root from the tar contents, not the file name', async () => {
    const { sessionsRoot } = await createWorkspaceRoot();
    await createArchive(sessionsRoot, 'regulated-foo.tar.gz', 'foo');

    const { exit, report } = await runCheck();
    expect(exit).toBe(0);
    expect(report.archives).toHaveLength(1);
    expect(report.archives[0]).toMatchObject({
      file: 'regulated-foo.tar.gz',
      sessionId: 'foo',
      extractable: 'yes',
    });
    // Missing manifest/article contract evidence stays a warning for archives.
    expect(findingCodes(report)).toContain('ARCHIVE_CONTRACT_UNKNOWN');
  });

  it('warns (never blocks) for an unreadable archive container', async () => {
    const { sessionsRoot } = await createWorkspaceRoot();
    const archiveDir = path.join(sessionsRoot, 'archive');
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.writeFile(path.join(archiveDir, 'broken.tar.gz'), 'not a tar', 'utf8');

    const { exit, report } = await runCheck();
    expect(exit).toBe(0);
    expect(report.archives[0]).toMatchObject({ extractable: 'no', currentContract: 'unknown' });
    expect(findingCodes(report)).toContain('ARCHIVE_UNREADABLE');
  });

  it('marks an archive without a confirmed session root as not extractable', async () => {
    const { sessionsRoot } = await createWorkspaceRoot();
    await createArchive(sessionsRoot, 'foo.tar.gz', 'other');

    const { exit, report } = await runCheck();
    expect(exit).toBe(0);
    expect(report.archives[0]).toMatchObject({
      file: 'foo.tar.gz',
      sessionId: null,
      extractable: 'no',
      currentContract: 'unknown',
    });
    expect(findingCodes(report)).toContain('ARCHIVE_UNREADABLE');
  });

  it('marks an archive with a blocked (non-regular) member as not extractable', async () => {
    const { sessionsRoot } = await createWorkspaceRoot();
    const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'upgrade-archive-'));
    cleanups.push(() => fs.rm(staging, { recursive: true, force: true }));
    await fs.mkdir(path.join(staging, 'foo', 'audit'), { recursive: true });
    const archiveDir = path.join(sessionsRoot, 'archive');
    await fs.mkdir(archiveDir, { recursive: true });
    await execFileAsync('tar', [
      '-czf',
      path.join(archiveDir, 'foo.tar.gz'),
      '-C',
      staging,
      'foo/audit',
    ]);

    const { exit, report } = await runCheck();
    expect(exit).toBe(0);
    expect(report.archives[0]).toMatchObject({ extractable: 'no' });
    expect(findingCodes(report)).toContain('ARCHIVE_UNREADABLE');
  });
});

describe('inspect --upgrade-check workspace resolution failure', () => {
  async function capture(run: () => number): Promise<{ exit: number; output: string }> {
    let output = '';
    const original = console.log;
    console.log = (value?: unknown) => {
      output += `${String(value)}\n`;
    };
    try {
      return { exit: run(), output };
    } finally {
      console.log = original;
    }
  }

  it('emits a structured JSON finding when --json cannot resolve the workspace', async () => {
    const { exit, output } = await capture(() => reportWorkspaceUnresolved(true, 'not a worktree'));
    expect(exit).toBe(1);
    const report = JSON.parse(output) as UpgradeCheckReport;
    expect(report).toMatchObject({
      workspaceFingerprint: null,
      upgradeReady: false,
      summary: { blockers: 1 },
    });
    expect(report.findings).toEqual([
      { severity: 'blocker', code: 'WORKSPACE_UNRESOLVED', message: expect.any(String) },
    ]);
    expect(output.trim().startsWith('{')).toBe(true);
  });

  it('emits a plain blocker line without --json', async () => {
    const { exit, output } = await capture(() =>
      reportWorkspaceUnresolved(false, 'not a worktree'),
    );
    expect(exit).toBe(1);
    expect(output).toContain('[blocker] WORKSPACE_UNRESOLVED');
  });
});

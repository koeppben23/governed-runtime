/**
 * @module cli/demo-evidence-verify.test
 * @description Smoke contract for the standalone demo evidence-package
 * verifier. Build-dependent: the verifier imports the canonical archive
 * primitives from the built `@flowguard/core`, so this test runs in the smoke
 * project after `npm run build` (see vitest.config.ts).
 *
 * The fixtures are real packages produced through the real archive paths
 * (`archiveCompletionExport`, `archiveRegulatedEvidence`); tamper cases repack
 * the tarball (or build a raw ustar archive) and recompute the sidecar so each
 * failure isolates the check under test. The unsafe-prefix and duplicate-member
 * cases install a recording `tar` wrapper to prove the verifier never starts an
 * extraction process for a rejected archive.
 *
 * @test-policy HAPPY, BAD, CORNER
 * @version v1
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import {
  BINDING,
  FIXED_TIME,
  makeState,
  REGULATED_POLICY_SNAPSHOT,
  REVIEW_APPROVE,
} from '../fixtures.js';
import { appendAuditEvent } from '../adapters/persistence-audit.js';
import { writeState } from '../adapters/persistence.js';
import { buildDecisionAuditIntent } from '../integration/services/decision-audit-intent.js';
import {
  archiveCompletionExport,
  archiveRegulatedEvidence,
} from '../adapters/workspace/archive.js';
import { archiveSession, initWorkspace } from '../adapters/workspace/index.js';
import { withTestEnv } from '../integration/test-helpers.js';

const execFileAsync = promisify(execFile);

const VERIFIER = path.join(
  process.cwd(),
  'demos',
  'java-task-manager',
  'verify-evidence-package.mjs',
);
const WORKTREE = process.cwd();
const SESSION_A = '550e8400-e29b-41d4-a716-4466554400a1';
const SESSION_B = '550e8400-e29b-41d4-a716-4466554400b2';
const FLOWGUARD_A = '550e8400-e29b-41d4-a716-4466554400c1';
const FLOWGUARD_B = '550e8400-e29b-41d4-a716-4466554400c2';

const cleanups: Array<() => Promise<void>> = [];

beforeEach(async () => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-demo-evidence-'));
  const restore = withTestEnv({ OPENCODE_CONFIG_DIR: configDir });
  cleanups.push(async () => {
    restore();
    await fs.rm(configDir, { recursive: true, force: true });
  });
});

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

async function initSession(
  sessionId: string,
  flowguardSessionId: string,
): Promise<{ fingerprint: string; sessionDir: string }> {
  const initialized = await initWorkspace(WORKTREE, sessionId);
  return { fingerprint: initialized.fingerprint, sessionDir: initialized.sessionDir };
}

function bindingFor(
  sessionId: string,
  fingerprint: string,
): typeof BINDING & { hostSessionId: string } {
  return { ...BINDING, hostSessionId: sessionId, fingerprint, worktree: WORKTREE };
}

async function appendEvent(
  sessionDir: string,
  flowguardSessionId: string,
  sessionId: string,
  phase: string,
  event: string,
  detail: Record<string, unknown>,
  actor = 'system',
): Promise<void> {
  await appendAuditEvent(sessionDir, {
    id: randomUUID(),
    flowguardSessionId,
    hostSessionId: sessionId,
    phase,
    event,
    occurredAt: FIXED_TIME,
    actor,
    detail,
  });
}

async function buildCompleteExportPackage(
  sessionId = SESSION_A,
  flowguardSessionId = FLOWGUARD_A,
): Promise<string> {
  const { fingerprint, sessionDir } = await initSession(sessionId, flowguardSessionId);
  await writeState(
    sessionDir,
    makeState('COMPLETE', {
      id: flowguardSessionId,
      flowguardSessionId,
      binding: bindingFor(sessionId, fingerprint),
      transition: {
        from: 'EXPORT_READY',
        to: 'COMPLETE',
        event: 'EXPORT_MATERIALIZED',
        at: FIXED_TIME,
      },
    }),
  );
  await appendEvent(
    sessionDir,
    flowguardSessionId,
    sessionId,
    'COMPLETE',
    'lifecycle:session_completed',
    {
      kind: 'lifecycle',
      action: 'session_completed',
      finalPhase: 'COMPLETE',
    },
  );
  return archiveCompletionExport(fingerprint, sessionId);
}

/** The real `/export` snapshot point: archiving happens at EXPORT_READY. */
async function buildExportReadyPackage(): Promise<string> {
  const { fingerprint, sessionDir } = await initSession(SESSION_A, FLOWGUARD_A);
  await writeState(
    sessionDir,
    makeState('EXPORT_READY', {
      id: FLOWGUARD_A,
      flowguardSessionId: FLOWGUARD_A,
      binding: bindingFor(SESSION_A, fingerprint),
      transition: {
        from: 'EVIDENCE_REVIEW',
        to: 'EXPORT_READY',
        event: 'APPROVE',
        at: FIXED_TIME,
      },
    }),
  );
  await appendEvent(sessionDir, FLOWGUARD_A, SESSION_A, 'EVIDENCE_REVIEW', 'transition:APPROVE', {
    kind: 'transition',
    from: 'EVIDENCE_REVIEW',
    to: 'EXPORT_READY',
    event: 'APPROVE',
  });
  return archiveCompletionExport(fingerprint, SESSION_A);
}

/**
 * A real mandatory regulated archive. The archive necessarily snapshots
 * `regulatedArchiveStatus: 'pending'` — the live status only becomes
 * `verified` after the archive exists — so the offline verifier must validate
 * the archived completion evidence, not the later live status.
 */
async function buildRegulatedPackage(): Promise<string> {
  const { fingerprint, sessionDir } = await initSession(SESSION_A, FLOWGUARD_A);
  await writeState(
    sessionDir,
    makeState('COMPLETE', {
      id: FLOWGUARD_A,
      flowguardSessionId: FLOWGUARD_A,
      binding: bindingFor(SESSION_A, fingerprint),
      policySnapshot: REGULATED_POLICY_SNAPSHOT,
      reviewDecision: REVIEW_APPROVE,
      regulatedArchiveStatus: 'pending',
      transition: {
        from: 'EXPORT_READY',
        to: 'COMPLETE',
        event: 'EXPORT_MATERIALIZED',
        at: FIXED_TIME,
      },
    }),
  );
  await appendEvent(sessionDir, FLOWGUARD_A, SESSION_A, 'EVIDENCE_REVIEW', 'transition:APPROVE', {
    kind: 'transition',
    from: 'EVIDENCE_REVIEW',
    to: 'EXPORT_READY',
    event: 'APPROVE',
  });
  const decisionIntent = buildDecisionAuditIntent({
    transition: { from: 'EVIDENCE_REVIEW', to: 'EXPORT_READY', event: 'APPROVE', at: FIXED_TIME },
    decision: REVIEW_APPROVE,
    policyMode: 'regulated',
    decisionSequence: 1,
    actor: 'human',
  });
  await appendEvent(
    sessionDir,
    FLOWGUARD_A,
    SESSION_A,
    decisionIntent.phase,
    decisionIntent.event,
    decisionIntent.detail,
    decisionIntent.actor,
  );
  await appendEvent(
    sessionDir,
    FLOWGUARD_A,
    SESSION_A,
    'COMPLETE',
    'transition:EXPORT_MATERIALIZED',
    {
      kind: 'transition',
      from: 'EXPORT_READY',
      to: 'COMPLETE',
      event: 'EXPORT_MATERIALIZED',
    },
  );
  await appendEvent(sessionDir, FLOWGUARD_A, SESSION_A, 'COMPLETE', 'lifecycle:session_completed', {
    kind: 'lifecycle',
    action: 'session_completed',
    finalPhase: 'COMPLETE',
  });
  return archiveRegulatedEvidence(fingerprint, SESSION_A);
}

// ─── Runner helpers ──────────────────────────────────────────────────────────

async function runVerifier(
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [VERIFIER, ...args], {
      timeout: 60_000,
      ...(env ? { env } : {}),
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

async function sha256(filePath: string): Promise<string> {
  return createHash('sha256')
    .update(await fs.readFile(filePath))
    .digest('hex');
}

async function repack(
  packagePath: string,
  sessionId: string,
  mutate: (sessionRoot: string) => Promise<void>,
): Promise<void> {
  const extraction = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-demo-evidence-repack-'));
  const members = (await execFileAsync('tar', ['-tzf', packagePath], { timeout: 30_000 })).stdout
    .split(/\r?\n/)
    .filter(Boolean);
  await execFileAsync('tar', ['-xzf', packagePath, '-C', extraction], { timeout: 30_000 });
  await mutate(path.join(extraction, sessionId));
  await execFileAsync(
    'tar',
    ['--format=ustar', '-czf', packagePath, '-C', extraction, ...members],
    {
      timeout: 30_000,
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    },
  );
  await fs.writeFile(
    `${packagePath}.sha256`,
    `${await sha256(packagePath)}  ${path.basename(packagePath)}\n`,
  );
  await fs.rm(extraction, { recursive: true, force: true });
}

async function writeSharingConfig(): Promise<void> {
  const configDir = process.env.OPENCODE_CONFIG_DIR;
  if (!configDir) throw new Error('OPENCODE_CONFIG_DIR must be set by the test env');
  await fs.writeFile(
    path.join(configDir, 'flowguard.json'),
    JSON.stringify({
      schemaVersion: 'v1',
      archive: { redaction: { allowedModes: ['basic'], allowRawExport: false } },
    }),
    'utf8',
  );
}

// ─── Raw tar construction (malicious archives) ───────────────────────────────

function ustarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'utf8');
  header.write('0000000\0', 108, 8, 'utf8');
  header.write('0000000\0', 116, 8, 'utf8');
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8');
  header.write('00000000000\0', 136, 12, 'utf8');
  header.write('        ', 148, 8, 'utf8');
  header.write('0', 156, 1, 'utf8');
  header.write('ustar', 257, 6, 'utf8');
  header.write('00', 263, 2, 'utf8');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');
  return header;
}

function buildTarGz(entries: ReadonlyArray<{ name: string; content: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content, 'utf8');
    blocks.push(ustarHeader(entry.name, content.length));
    blocks.push(content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

async function walkFiles(
  root: string,
  prefix = '',
): Promise<Array<{ name: string; content: string }>> {
  const result: Array<{ name: string; content: string }> = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      result.push(...(await walkFiles(path.join(root, entry.name), relative)));
    } else {
      result.push({
        name: relative,
        content: await fs.readFile(path.join(root, entry.name), 'utf8'),
      });
    }
  }
  return result;
}

/** Install a recording `tar` wrapper so a test can prove no extraction started. */
async function makeTarSpy(): Promise<{ env: NodeJS.ProcessEnv; logPath: string }> {
  const { stdout } = await execFileAsync('which', ['tar']);
  const realTar = stdout.trim();
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-tar-spy-'));
  cleanups.push(async () => fs.rm(binDir, { recursive: true, force: true }));
  const logPath = path.join(binDir, 'calls.log');
  await fs.writeFile(
    path.join(binDir, 'tar'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$TAR_CALL_LOG"\nexec ${realTar} "$@"\n`,
    { mode: 0o755 },
  );
  return {
    logPath,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}`, TAR_CALL_LOG: logPath },
  };
}

// ─── Evidence manifest fixtures ──────────────────────────────────────────────

function evidenceManifest(
  sessions: ReadonlyArray<{
    flow: string;
    sessionId: string;
    artifacts: ReadonlyArray<{ kind: string; file: string; sha256: string }>;
  }>,
): string {
  return `${JSON.stringify({ schemaVersion: 'demo-evidence-manifest.v1', sessions }, null, 2)}\n`;
}

async function writeFile(dir: string, name: string, content: string): Promise<string> {
  await fs.writeFile(path.join(dir, name), content, 'utf8');
  return sha256(path.join(dir, name));
}

/**
 * Assemble the reference evidence directory: the development package and one
 * host chat export per flow. Returns the manifest path.
 */
async function buildEvidenceDirectory(
  options: { copyPeerReviewChat?: boolean; reuseSessionId?: boolean } = {},
): Promise<{
  manifestPath: string;
}> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-demo-evidence-package-'));
  cleanups.push(async () => fs.rm(directory, { recursive: true, force: true }));

  const packagePath = await buildCompleteExportPackage();
  const packageName = path.basename(packagePath);
  await fs.copyFile(packagePath, path.join(directory, packageName));
  await fs.copyFile(`${packagePath}.sha256`, path.join(directory, `${packageName}.sha256`));

  const packageHash = await sha256(packagePath);
  const architectureHash = await writeFile(
    directory,
    'chat-architecture.md',
    'architecture session chat export\n',
  );
  const developmentHash = await writeFile(
    directory,
    'chat-development.md',
    'development session chat export\n',
  );
  const peerReviewHash = await writeFile(
    directory,
    'chat-peer-review.md',
    options.copyPeerReviewChat
      ? 'architecture session chat export\n'
      : 'peer review session chat export\n',
  );

  const manifestPath = path.join(directory, 'evidence-manifest.json');
  await fs.writeFile(
    manifestPath,
    evidenceManifest([
      {
        flow: 'architecture',
        sessionId: '550e8400-e29b-41d4-a716-4466554400d1',
        artifacts: [
          { kind: 'host-chat-export', file: 'chat-architecture.md', sha256: architectureHash },
        ],
      },
      {
        flow: 'development',
        sessionId: SESSION_A,
        artifacts: [
          { kind: 'flowguard-package', file: packageName, sha256: packageHash },
          { kind: 'host-chat-export', file: 'chat-development.md', sha256: developmentHash },
        ],
      },
      {
        flow: 'peer-review',
        sessionId: options.reuseSessionId ? SESSION_A : '550e8400-e29b-41d4-a716-4466554400d2',
        artifacts: [
          { kind: 'host-chat-export', file: 'chat-peer-review.md', sha256: peerReviewHash },
        ],
      },
    ]),
    'utf8',
  );
  return { manifestPath };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('demo evidence package verifier', () => {
  describe('HAPPY', () => {
    it('verifies the real /export snapshot at EXPORT_READY', async () => {
      const packagePath = await buildExportReadyPackage();

      const result = await runVerifier([
        packagePath,
        '--expect-session',
        SESSION_A,
        '--expect-flow',
        'development',
        '--expect-phase',
        'EXPORT_READY',
      ]);

      expect(result.stdout).toContain('VERIFIED');
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
    });

    it('verifies a real raw export package as the expected session', async () => {
      const packagePath = await buildCompleteExportPackage();

      const result = await runVerifier([
        packagePath,
        '--expect-session',
        SESSION_A,
        '--expect-flow',
        'development',
        '--expect-phase',
        'COMPLETE',
      ]);

      expect(result.stdout).toContain('VERIFIED');
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`session: ${SESSION_A}`);
    });

    it('verifies a real regulated archive created by archiveRegulatedEvidence', async () => {
      const packagePath = await buildRegulatedPackage();
      expect(path.basename(packagePath)).toBe(`regulated-${SESSION_A}.tar.gz`);

      const result = await runVerifier([
        packagePath,
        '--expect-session',
        SESSION_A,
        '--expect-flow',
        'regulated',
      ]);

      expect(result.stdout).toContain('VERIFIED');
      expect(result.code).toBe(0);
    });

    it('verifies the three-session evidence manifest', async () => {
      const { manifestPath } = await buildEvidenceDirectory();

      const result = await runVerifier(['--manifest', manifestPath]);

      expect(result.stdout).toContain('VERIFIED');
      expect(result.stdout).toContain('development: ');
      expect(result.code).toBe(0);
    });
  });

  describe('BAD', () => {
    it('rejects a package with changed file bytes', async () => {
      const packagePath = await buildCompleteExportPackage();
      await repack(packagePath, SESSION_A, async (sessionRoot) => {
        const statePath = path.join(sessionRoot, 'state', 'session-state.json');
        const original = await fs.readFile(statePath, 'utf-8');
        await fs.writeFile(statePath, `${original}\n`, 'utf-8');
      });

      const result = await runVerifier([packagePath, '--expect-session', SESSION_A]);

      expect(result.code).toBe(1);
      expect(result.stdout).toContain('file_digest_mismatch');
    });

    it('rejects manipulated manifest metadata', async () => {
      const packagePath = await buildCompleteExportPackage();
      await repack(packagePath, SESSION_A, async (sessionRoot) => {
        const manifestPath = path.join(sessionRoot, 'archive-manifest.json');
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as Record<
          string,
          unknown
        >;
        manifest.policyMode = 'regulated';
        await fs.writeFile(manifestPath, JSON.stringify(manifest), 'utf-8');
      });

      const result = await runVerifier([packagePath, '--expect-session', SESSION_A]);

      expect(result.code).toBe(1);
      expect(result.stdout).toContain('content_digest_mismatch');
      expect(result.stdout).toContain('manifest_policy_mode_mismatch');
    });

    it('rejects a valid package assigned to a different session', async () => {
      const packagePath = await buildCompleteExportPackage(SESSION_B, FLOWGUARD_B);

      const result = await runVerifier([packagePath, '--expect-session', SESSION_A]);

      expect(result.code).toBe(1);
      expect(result.stdout).toContain('session_identity_mismatch');
    });

    it('fails closed with a usage error when no expectation is provided', async () => {
      const packagePath = await buildCompleteExportPackage();

      const result = await runVerifier([packagePath]);

      expect(result.code).toBe(2);
      expect(result.stderr).toContain('--expect-session is required');
    });

    it('rejects an unsafe session prefix without starting an extraction', async () => {
      const spy = await makeTarSpy();
      const unsafePath = path.join(os.tmpdir(), `fg-unsafe-${randomUUID()}.tar.gz`);
      cleanups.push(async () => fs.rm(unsafePath, { force: true }));
      await fs.writeFile(
        unsafePath,
        buildTarGz([{ name: '../outside/archive-manifest.json', content: '{}' }]),
      );

      const result = await runVerifier([unsafePath, '--expect-session', SESSION_A], spy.env);

      expect(result.code).toBe(1);
      expect(result.stdout).toContain('refusing to extract');
      const calls = await fs.readFile(spy.logPath, 'utf-8');
      expect(calls).toContain('-tzf');
      expect(calls).not.toContain('-xzf');
    });

    it('rejects duplicate archive members without starting an extraction', async () => {
      const packagePath = await buildCompleteExportPackage();
      const extraction = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-demo-evidence-walk-'));
      cleanups.push(async () => fs.rm(extraction, { recursive: true, force: true }));
      await execFileAsync('tar', ['-xzf', packagePath, '-C', extraction], { timeout: 30_000 });
      const entries = await walkFiles(path.join(extraction, SESSION_A));
      expect(entries.length).toBeGreaterThan(0);
      const duplicatePath = path.join(os.tmpdir(), `fg-duplicate-${randomUUID()}.tar.gz`);
      cleanups.push(async () => fs.rm(duplicatePath, { force: true }));
      const members = entries.map((entry) => ({
        name: `${SESSION_A}/${entry.name}`,
        content: entry.content,
      }));
      const [firstMember] = members;
      if (!firstMember) throw new Error('expected at least one archive member');
      await fs.writeFile(duplicatePath, buildTarGz([...members, firstMember]));
      await fs.writeFile(
        `${duplicatePath}.sha256`,
        `${await sha256(duplicatePath)}  ${path.basename(duplicatePath)}\n`,
      );

      const spy = await makeTarSpy();
      const result = await runVerifier([duplicatePath, '--expect-session', SESSION_A], spy.env);

      expect(result.code).toBe(1);
      expect(result.stdout).toContain('refusing to extract');
      const calls = await fs.readFile(spy.logPath, 'utf-8');
      expect(calls).not.toContain('-xzf');
    });

    it('rejects an unsafe manifest path without opening any payload file', async () => {
      // Only the manifest is malicious; the tar members stay safe and present.
      const packagePath = await buildCompleteExportPackage();
      await repack(packagePath, SESSION_A, async (sessionRoot) => {
        const manifestPath = path.join(sessionRoot, 'archive-manifest.json');
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as Record<
          string,
          unknown
        >;
        manifest.includedFiles = ['../../../etc/passwd'];
        manifest.fileDigests = { '../../../etc/passwd': 'a'.repeat(64) };
        await fs.writeFile(manifestPath, JSON.stringify(manifest), 'utf-8');
      });

      const result = await runVerifier([packagePath, '--expect-session', SESSION_A]);

      expect(result.code).toBe(1);
      expect(result.stdout).toContain('unsafe_manifest_path');
      // No payload read was attempted, so no file-digest finding for the
      // traversal path (or any other manifest-listed file) can appear.
      expect(result.stdout).not.toContain('file_digest_mismatch');
    });

    it('rejects a team archive claimed as a regulated flow', async () => {
      const packagePath = await buildCompleteExportPackage();

      const result = await runVerifier([
        packagePath,
        '--expect-session',
        SESSION_A,
        '--expect-flow',
        'regulated',
      ]);

      expect(result.code).toBe(1);
      expect(result.stdout).toContain("requires policy mode 'regulated'");
    });

    it('rejects a chat export that is a byte-identical copy from another flow', async () => {
      // The original evidence defect: the peer-review chat export was a copy
      // of the architecture export. Both declared hashes are correct — only
      // the cross-session byte identity reveals the copy.
      const { manifestPath } = await buildEvidenceDirectory({ copyPeerReviewChat: true });

      const result = await runVerifier(['--manifest', manifestPath]);

      expect(result.code).toBe(1);
      expect(result.stdout).toContain('cross_session_artifact_duplicate');
    });

    it('rejects a manifest that reuses one session id across flows', async () => {
      const { manifestPath } = await buildEvidenceDirectory({ reuseSessionId: true });

      const result = await runVerifier(['--manifest', manifestPath]);

      expect(result.code).toBe(1);
      expect(result.stdout).toContain('duplicate_session_id');
    });

    it('rejects a manifest artifact with a wrong declared digest', async () => {
      const { manifestPath } = await buildEvidenceDirectory();
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as {
        sessions: Array<{ flow: string; artifacts: Array<{ file: string; sha256: string }> }>;
      };
      const architecture = manifest.sessions.find((session) => session.flow === 'architecture');
      const artifact = architecture?.artifacts[0];
      if (!artifact) throw new Error('expected an architecture artifact');
      artifact.sha256 = '0'.repeat(64);
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

      const result = await runVerifier(['--manifest', manifestPath]);

      expect(result.code).toBe(1);
      expect(result.stdout).toContain('file_digest_mismatch');
    });
  });

  describe('CORNER', () => {
    it('refuses to present a redacted sharing archive as fully verifiable raw evidence', async () => {
      const { fingerprint, sessionDir } = await initSession(SESSION_A, FLOWGUARD_A);
      await writeState(
        sessionDir,
        makeState('COMPLETE', {
          id: FLOWGUARD_A,
          flowguardSessionId: FLOWGUARD_A,
          binding: bindingFor(SESSION_A, fingerprint),
          transition: {
            from: 'EXPORT_READY',
            to: 'COMPLETE',
            event: 'EXPORT_MATERIALIZED',
            at: FIXED_TIME,
          },
        }),
      );
      await appendEvent(
        sessionDir,
        FLOWGUARD_A,
        SESSION_A,
        'COMPLETE',
        'lifecycle:session_completed',
        {
          kind: 'lifecycle',
          action: 'session_completed',
          finalPhase: 'COMPLETE',
        },
      );
      await writeSharingConfig();
      const packagePath = await archiveSession(fingerprint, SESSION_A, {
        redactionMode: 'basic',
        includeRaw: false,
      });

      const refused = await runVerifier([packagePath, '--expect-session', SESSION_A]);
      expect(refused.code).toBe(3);
      expect(refused.stdout).toContain('sharing_archive_not_verifiable');

      const accepted = await runVerifier([
        packagePath,
        '--expect-session',
        SESSION_A,
        '--expect-sharing',
      ]);
      expect(accepted.code).toBe(0);
      expect(accepted.stdout).toContain('NOT FULLY VERIFIABLE');
    });
  });
});

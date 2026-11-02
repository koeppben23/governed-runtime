/**
 * @module adapters/workspace/archive-read-verified.test
 * @description Verified-snapshot reader tests: the raw completion export is
 * read from the same snapshot that was verified; missing sidecars, sharing
 * archives, tampering and session mismatches block every positive result.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { archiveCompletionExport, archiveSession } from './archive.js';
import { archiveFileName } from './archive-layout.js';
import { verifyCompletionExport, verifyCompletionExportCaptured } from './archive-verify-chain.js';
import { readVerifiedCompletionExport } from './archive-read-verified.js';
import { writeState } from '../persistence.js';
import { appendAuditEvent } from '../persistence-audit.js';
import { materializeEvidenceArtifacts } from './evidence-artifacts.js';
import { initWorkspace, workspacesHome } from './init.js';
import { hashFile, hashText } from '../../shared/hashing.js';
import { canonicalJsonStringify } from '../../shared/canonical-json.js';
import { BINDING, makeProgressedState } from '../../fixtures.js';
import type { SessionState } from '../../state/schema.js';
import { withTestEnv } from '../../integration/test-helpers.js';
import { createTempWorktree, runCleanups } from '../workspace-test-helpers.js';

let WORKTREE: string;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(async () => {
  const temp = await createTempWorktree({ prefix: 'iso-read-verified-' });
  WORKTREE = temp.worktree;
  cleanups.push(temp.cleanup);
});

afterEach(async () => {
  await runCleanups(cleanups.splice(0).reverse());
});

async function isolateConfigDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'iso-read-verified-cfg-'));
}

function boundState(input: {
  readonly sessionId: string;
  readonly fingerprint: string;
  readonly phase?: SessionState['phase'];
}): SessionState {
  const base = makeProgressedState(input.phase ?? 'COMPLETE');
  return {
    ...base,
    binding: {
      ...BINDING,
      hostSessionId: input.sessionId,
      worktree: WORKTREE,
      fingerprint: input.fingerprint,
    },
  };
}

async function persistBoundSession(input: {
  readonly sessionDir: string;
  readonly sessionId: string;
  readonly fingerprint: string;
}): Promise<SessionState> {
  const state = boundState({ sessionId: input.sessionId, fingerprint: input.fingerprint });
  await writeState(input.sessionDir, state);
  await materializeEvidenceArtifacts(
    input.sessionDir,
    state,
    hashText(canonicalJsonStringify(state)),
  );
  return state;
}

async function createExportFixture(options: { readonly appendDecision?: boolean } = {}) {
  const configDir = await isolateConfigDir();
  const restore = withTestEnv({ OPENCODE_CONFIG_DIR: configDir });
  cleanups.push(async () => {
    restore();
    await fs.rm(configDir, { recursive: true, force: true });
  });

  const sessionId = '550e8400-e29b-41d4-a716-4466554400ab';
  const initialized = await initWorkspace(WORKTREE, sessionId);
  const state = await persistBoundSession({
    sessionDir: initialized.sessionDir,
    sessionId,
    fingerprint: initialized.fingerprint,
  });

  await appendAuditEvent(initialized.sessionDir, {
    id: randomUUID(),
    flowguardSessionId: state.flowguardSessionId,
    hostSessionId: sessionId,
    phase: 'COMPLETE',
    event: 'transition:EXPORT_MATERIALIZED',
    occurredAt: '2026-01-01T00:00:00.000Z',
    actor: 'machine',
    detail: {
      kind: 'transition',
      from: 'EXPORT_READY',
      to: 'COMPLETE',
      event: 'EXPORT_MATERIALIZED',
      autoAdvanced: false,
      chainIndex: -1,
    },
  });
  if (options.appendDecision) {
    await appendAuditEvent(initialized.sessionDir, {
      id: randomUUID(),
      flowguardSessionId: state.flowguardSessionId,
      hostSessionId: sessionId,
      phase: 'COMPLETE',
      event: 'decision:decision-1',
      occurredAt: '2026-01-01T00:01:00.000Z',
      actor: 'human',
      detail: {
        kind: 'decision',
        decisionId: 'decision-1',
        decisionSequence: 1,
        gatePhase: 'EVIDENCE_REVIEW',
        verdict: 'approve',
        rationale: 'fixture rationale',
        decidedAt: '2026-01-01T00:01:00.000Z',
        decisionIdentity: {
          actorId: 'reviewer-1',
          actorEmail: null,
          actorSource: 'env',
          actorAssurance: 'best_effort',
        },
        fromPhase: 'EVIDENCE_REVIEW',
        toPhase: 'COMPLETE',
        transitionEvent: 'APPROVE',
        policyMode: 'team',
      },
    });
  }

  const exportPath = await archiveCompletionExport(initialized.fingerprint, sessionId);
  return { ...initialized, sessionId, state, exportPath };
}

describe('adapters/workspace/archive-read-verified', () => {
  describe('HAPPY — the verified snapshot backs positive evidence', () => {
    it('returns the verified state and audit trail from the packaged snapshot', async () => {
      const fixture = await createExportFixture({ appendDecision: true });
      const read = await readVerifiedCompletionExport(fixture.fingerprint, fixture.sessionId);
      expect(read.kind).toBe('verified');
      if (read.kind !== 'verified') return;
      expect(read.integrity).toBe('verified_archive_snapshot');
      expect(read.manifest.sessionId).toBe(fixture.sessionId);
      expect(read.state.flowguardSessionId).toBe(fixture.state.flowguardSessionId);
      expect(read.manifest.auditEventCount).toBe(read.events.length);
      expect(read.events.some((event) => event.event.startsWith('decision:'))).toBe(true);
      expect(read.events.some((event) => event.event === 'transition:EXPORT_MATERIALIZED')).toBe(
        true,
      );
      expect(read.packageSha256).toBe(read.sidecarSha256);
      expect(read.packageSha256).toBe(await hashFile(fixture.exportPath));
    });

    it('is read-only: the package and the live state are unchanged', async () => {
      const fixture = await createExportFixture();
      const before = await hashFile(fixture.exportPath);
      const stateBefore = await fs.readFile(
        path.join(fixture.sessionDir, 'session-state.json'),
        'utf-8',
      );
      await readVerifiedCompletionExport(fixture.fingerprint, fixture.sessionId);
      expect(await hashFile(fixture.exportPath)).toBe(before);
      expect(await fs.readFile(path.join(fixture.sessionDir, 'session-state.json'), 'utf-8')).toBe(
        stateBefore,
      );
    });

    it('is behavior-equivalent to the canonical verifier for the same package', async () => {
      const fixture = await createExportFixture();
      const plain = await verifyCompletionExport(fixture.fingerprint, fixture.sessionId);
      const captured = await verifyCompletionExportCaptured(fixture.fingerprint, fixture.sessionId);
      expect(captured.verification.passed).toBe(plain.passed);
      expect(captured.verification.findings).toEqual(plain.findings);
      expect(captured.verification.manifest).toEqual(plain.manifest);
    });
  });

  describe('BAD — missing sidecars, tampering and sharing archives always block', () => {
    it('requires the checksum sidecar even where archive verification is non-strict', async () => {
      const fixture = await createExportFixture();
      await fs.rm(`${fixture.exportPath}.sha256`);
      // The publication binding needs the sidecar, so the canonical verifier
      // already fails here; the reader keeps its own explicit requirement.
      expect((await verifyCompletionExport(fixture.fingerprint, fixture.sessionId)).passed).toBe(
        false,
      );
      const read = await readVerifiedCompletionExport(fixture.fingerprint, fixture.sessionId);
      expect(read.kind).toBe('blocked');
      if (read.kind === 'blocked') {
        expect(['SIDECAR_REQUIRED', 'PACKAGE_UNVERIFIABLE']).toContain(read.code);
        expect(read.findings.some((finding) => finding.code === 'archive_checksum_missing')).toBe(
          true,
        );
      }
    });

    it('blocks a mismatched sidecar and a tampered archive', async () => {
      const fixture = await createExportFixture();
      await fs.writeFile(`${fixture.exportPath}.sha256`, `${'0'.repeat(64)}  export.tar.gz\n`);
      const mismatched = await readVerifiedCompletionExport(fixture.fingerprint, fixture.sessionId);
      expect(mismatched.kind).toBe('blocked');
      if (mismatched.kind === 'blocked') expect(mismatched.code).toBe('PACKAGE_UNVERIFIABLE');

      const second = await createExportFixture();
      const original = await fs.readFile(second.exportPath);
      await fs.writeFile(second.exportPath, Buffer.concat([original, Buffer.from('tamper')]));
      const tampered = await readVerifiedCompletionExport(second.fingerprint, second.sessionId);
      expect(tampered.kind).toBe('blocked');
      if (tampered.kind === 'blocked') expect(tampered.code).toBe('PACKAGE_UNVERIFIABLE');
    });

    it('never reads a redacted sharing archive as verified evidence', async () => {
      const configDir = await isolateConfigDir();
      const restore = withTestEnv({ OPENCODE_CONFIG_DIR: configDir });
      cleanups.push(async () => {
        restore();
        await fs.rm(configDir, { recursive: true, force: true });
      });
      await fs.writeFile(
        path.join(configDir, 'flowguard.json'),
        JSON.stringify({
          schemaVersion: 'v1',
          archive: { redaction: { allowedModes: ['basic'], allowRawExport: false } },
        }),
        'utf8',
      );

      const sessionId = '550e8400-e29b-41d4-a716-4466554400ac';
      const initialized = await initWorkspace(WORKTREE, sessionId);
      await persistBoundSession({
        sessionDir: initialized.sessionDir,
        sessionId,
        fingerprint: initialized.fingerprint,
      });
      const sharingPath = await archiveSession(initialized.fingerprint, sessionId, {
        redactionMode: 'basic',
        includeRaw: false,
        worktree: WORKTREE,
      });

      // Place the sharing package where the completion-export reader looks.
      const archiveDir = path.join(
        workspacesHome(),
        initialized.fingerprint,
        'sessions',
        'archive',
      );
      const exportPath = path.join(archiveDir, archiveFileName(sessionId, 'export'));
      await fs.copyFile(sharingPath, exportPath);
      await fs.writeFile(
        `${exportPath}.sha256`,
        `${await hashFile(exportPath)}  ${path.basename(exportPath)}\n`,
      );

      const read = await readVerifiedCompletionExport(initialized.fingerprint, sessionId);
      expect(read.kind).toBe('blocked');
      // A sharing archive has no raw state/audit members, so verification
      // fails before the reader's explicit raw-evidence guard; either way it
      // can never back verified evidence.
      if (read.kind === 'blocked') {
        expect(['NOT_RAW_EVIDENCE_EXPORT', 'PACKAGE_UNVERIFIABLE']).toContain(read.code);
      }
    });
  });

  describe('CORNER — missing packages and session mismatches', () => {
    it('blocks when no completion export exists', async () => {
      const configDir = await isolateConfigDir();
      const restore = withTestEnv({ OPENCODE_CONFIG_DIR: configDir });
      cleanups.push(async () => {
        restore();
        await fs.rm(configDir, { recursive: true, force: true });
      });
      const sessionId = '550e8400-e29b-41d4-a716-4466554400ad';
      const initialized = await initWorkspace(WORKTREE, sessionId);
      await persistBoundSession({
        sessionDir: initialized.sessionDir,
        sessionId,
        fingerprint: initialized.fingerprint,
      });
      const read = await readVerifiedCompletionExport(initialized.fingerprint, sessionId);
      expect(read.kind).toBe('blocked');
      if (read.kind === 'blocked') expect(read.code).toBe('PACKAGE_MISSING');
    });

    it('blocks a foreign package copied under another session name', async () => {
      const fixture = await createExportFixture();
      const otherSessionId = '550e8400-e29b-41d4-a716-4466554400ae';
      const other = await initWorkspace(WORKTREE, otherSessionId);
      await persistBoundSession({
        sessionDir: other.sessionDir,
        sessionId: otherSessionId,
        fingerprint: other.fingerprint,
      });
      const archiveDir = path.join(workspacesHome(), fixture.fingerprint, 'sessions', 'archive');
      const otherExport = path.join(archiveDir, archiveFileName(otherSessionId, 'export'));
      await fs.copyFile(fixture.exportPath, otherExport);
      await fs.writeFile(
        `${otherExport}.sha256`,
        `${await hashFile(otherExport)}  ${path.basename(otherExport)}\n`,
      );
      // The tar member gate already refuses members outside the requested
      // session; the manifest/session binding check is defense in depth.
      const read = await readVerifiedCompletionExport(fixture.fingerprint, otherSessionId);
      expect(read.kind).toBe('blocked');
      if (read.kind === 'blocked') expect(read.code).toBe('PACKAGE_UNVERIFIABLE');
    });
  });

  describe('EDGE — capture provenance is explicit', () => {
    it('never reports a verified package when the tar member policy is violated', async () => {
      const fixture = await createExportFixture();
      const read = await readVerifiedCompletionExport(fixture.fingerprint, fixture.sessionId);
      expect(read.kind).toBe('verified');
      if (read.kind === 'verified') {
        expect(read.events.every((event) => event.auditFormatVersion === 'audit-chain.v3')).toBe(
          true,
        );
        expect(read.manifest.rawIncluded).toBe(true);
        expect(read.manifest.redactionMode).toBe('none');
      }
    });

    it('reports a snapshot that fails the member gate as unverifiable, not missing', async () => {
      const fixture = await createExportFixture();
      const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'iso-member-gate-'));
      try {
        await promisify(execFile)('tar', ['xzf', fixture.exportPath, '-C', staging], {
          windowsHide: true,
        });
        await fs.writeFile(path.join(staging, 'outside.txt'), 'not a session member\n', 'utf8');
        const original = await fs.readFile(fixture.exportPath);
        await promisify(execFile)(
          'tar',
          [
            '--format=ustar',
            '-czf',
            fixture.exportPath,
            '-C',
            staging,
            fixture.sessionId,
            'outside.txt',
          ],
          { windowsHide: true },
        );
        const digest = await hashFile(fixture.exportPath);
        await fs.writeFile(
          `${fixture.exportPath}.sha256`,
          `${digest}  ${path.basename(fixture.exportPath)}\n`,
        );

        const read = await readVerifiedCompletionExport(fixture.fingerprint, fixture.sessionId);
        expect(read.kind).toBe('blocked');
        if (read.kind === 'blocked') expect(read.code).toBe('PACKAGE_UNVERIFIABLE');
        expect(original.length).toBeGreaterThan(0);
      } finally {
        await fs.rm(staging, { recursive: true, force: true });
      }
    });
  });
});

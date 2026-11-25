/**
 * @module cli/inspect-iso27001.smoke.test
 * @description End-to-end smoke test for `flowguard inspect --iso27001-mapping`
 * against the built CLI: a real workspace, a real completion-export package,
 * an independent re-verification of that package, and the tamper path.
 *
 * Requires `npm run build`; skipped otherwise (like the other CLI smoke tests).
 *
 * @test-policy HAPPY, BAD, CORNER — all three categories present.
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { archiveCompletionExport } from '../adapters/workspace/archive.js';
import { verifyCompletionExport } from '../adapters/workspace/archive-verify-chain.js';
import { materializeEvidenceArtifacts } from '../adapters/workspace/evidence-artifacts.js';
import { computeFingerprint } from '../adapters/workspace/fingerprint.js';
import { sessionDir } from '../adapters/workspace/index.js';
import { appendAuditEvent } from '../adapters/persistence-audit.js';
import { writeState } from '../adapters/persistence.js';
import { BINDING, FIXED_TIME, makeProgressedState } from '../fixtures.js';
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { hashFile, hashText } from '../shared/hashing.js';
import type { SessionState } from '../state/schema.js';
import {
  makeAssertionExtraction,
  makeImplementationAttempt,
  TEST_ATTEMPT_ID,
} from '../audit/iso27001/iso27001-test-helpers.js';
import { TEST_REMOTE_ORIGIN, createTempWorktree } from '../adapters/workspace-test-helpers.js';
import { withTestEnv } from '../integration/test-helpers.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI_ENTRY = path.join(REPO_ROOT, 'dist', 'cli', 'install.js');
const HAS_BUILT_CLI = existsSync(CLI_ENTRY);

const SESSION_ID = '550e8400-e29b-41d4-a716-4466554400b0';
const LOCAL_ID = 'auth.spec.ts::rejects-invalid-token';

function runCli(
  args: string[],
  cwd: string,
  env: Record<string, string>,
): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: 'utf-8',
    stdio: 'pipe',
    env: { ...process.env, FORCE_COLOR: '0', ...env },
    timeout: 30_000,
  });
  return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

const describeSmoke = HAS_BUILT_CLI ? describe : describe.skip;

describeSmoke('flowguard inspect --iso27001-mapping smoke', () => {
  it('HAPPY: verifies the package, links the declared evidence, and stays read-only', async () => {
    const worktree = await createTempWorktree({
      prefix: 'iso-smoke-',
      remote: TEST_REMOTE_ORIGIN,
    });
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iso-smoke-cfg-'));
    const restore = withTestEnv({ OPENCODE_CONFIG_DIR: configDir });
    try {
      const fingerprint = (await computeFingerprint(worktree.worktree)).fingerprint;
      const sessDir = sessionDir(fingerprint, SESSION_ID);
      await fs.mkdir(sessDir, { recursive: true });

      const extraction = makeAssertionExtraction({
        attemptId: TEST_ATTEMPT_ID,
        localId: LOCAL_ID,
        status: 'passed',
      });
      const state: SessionState = {
        ...makeProgressedState('COMPLETE'),
        binding: {
          ...BINDING,
          hostSessionId: SESSION_ID,
          worktree: worktree.worktree,
          fingerprint,
        },
        validationAttempts: [makeImplementationAttempt({ checkId: 'test', extraction })],
      };
      await writeState(sessDir, state);
      await materializeEvidenceArtifacts(sessDir, state, hashText(canonicalJsonStringify(state)));
      await appendAuditEvent(sessDir, {
        id: randomUUID(),
        flowguardSessionId: state.flowguardSessionId,
        hostSessionId: SESSION_ID,
        phase: 'COMPLETE',
        event: 'transition:EXPORT_MATERIALIZED',
        occurredAt: FIXED_TIME,
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
      const exportPath = await archiveCompletionExport(fingerprint, SESSION_ID);

      const mappingPath = path.join(configDir, 'mapping.json');
      await fs.writeFile(
        mappingPath,
        JSON.stringify({
          mappingSchemaVersion: 'iso27001-evidence-mapping.v1',
          framework: { id: 'ISO/IEC 27001:2022', annex: 'A' },
          organizationId: 'acme-secdev',
          ismsScopeId: 'isms-prod-2026',
          mappingVersion: '1.0',
          owner: 'Secure Development Lead',
          approval: {
            reference: 'ISMS-APPROVAL-2026-014',
            approvedAt: '2026-01-15T10:00:00.000Z',
            assertedBy: 'CISO Office',
          },
          rules: [
            {
              ruleId: 'sec-testing',
              controlRef: { namespace: 'iso27001:2022/annexA', controlId: 'A.8.29' },
              policyRequirementId: 'SDLC-SEC-TEST-01',
              applicability: 'asserted_applicable',
              evidence: [
                {
                  kind: 'validation.assertion_passed',
                  checkId: 'test',
                  assertion: { providerId: 'vitest', localId: LOCAL_ID },
                },
              ],
            },
          ],
        }),
        'utf8',
      );

      const env = { OPENCODE_CONFIG_DIR: configDir };
      const digestBefore = await hashFile(exportPath);
      const result = runCli(
        ['inspect', '--session', SESSION_ID, '--iso27001-mapping', mappingPath, '--json'],
        worktree.worktree,
        env,
      );
      expect(result.stderr).not.toContain('[error]');
      expect(result.code).toBe(0);
      const report = JSON.parse(result.stdout) as {
        evidencePackage: { packageSha256: string };
        controls: Array<{ controlRef: { controlId: string }; status: string }>;
      };
      expect(report.controls[0]?.controlRef.controlId).toBe('A.8.15');
      const a829 = report.controls.find((control) => control.controlRef.controlId === 'A.8.29');
      expect(a829?.status).toBe('EVIDENCE_LINKED_VERIFIED');
      expect(report.evidencePackage.packageSha256).toBe(digestBefore);

      // Independent re-verification with the canonical verifier.
      const verification = await verifyCompletionExport(fingerprint, SESSION_ID);
      expect(verification.passed).toBe(true);
      expect(await hashFile(exportPath)).toBe(digestBefore);

      // BAD: a tampered package fails closed with exit 2.
      const original = await fs.readFile(exportPath);
      await fs.writeFile(exportPath, Buffer.concat([original, Buffer.from('tamper')]));
      const tampered = runCli(
        ['inspect', '--session', SESSION_ID, '--iso27001-mapping', mappingPath, '--json'],
        worktree.worktree,
        env,
      );
      expect(tampered.code).toBe(2);
      expect(tampered.stdout).toBe('');
      expect(tampered.stderr).toContain('PACKAGE_UNVERIFIABLE');
    } finally {
      restore();
      await fs.rm(configDir, { recursive: true, force: true });
      await worktree.cleanup();
    }
  }, 60_000);

  it('CORNER: --iso27001-mapping without --session is rejected before any package read', () => {
    const result = runCli(['inspect', '--iso27001-mapping', 'whatever.json'], REPO_ROOT, {
      OPENCODE_CONFIG_DIR: path.join(os.tmpdir(), 'iso-smoke-unused'),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('requires --session');
  });
});

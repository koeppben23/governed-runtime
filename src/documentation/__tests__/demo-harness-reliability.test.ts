/**
 * @module documentation/__tests__/demo-harness-reliability
 * @description Regression tests for the demo-harness reliability fixes:
 * symlink-safe CLI entry points, the fixture repo-config application (without
 * pre-seeding `.opencode` before install), the frozen policy snapshot proof,
 * and the bounded no-op turn classification.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 * @version v1
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isMainModule } from '../../../demos/lib/is-main-module.mjs';
import { hostTurnWasNoOp } from '../../../demos/java-task-manager/run-live-matrix.mjs';
import { applyFixtureRepoConfig } from '../../../demos/risk-trigger-fixture/run-live-risk-trigger-controls.mjs';
import { releaseLease } from '../../../demos/lib/run-lease.mjs';
import { FlowGuardConfigSchema } from '../../config/flowguard-config.js';
import { freezePolicySnapshot } from '../../config/policy-snapshot.js';
import {
  digestText,
  resolveNewPolicyResolution,
} from '../../integration/tools/hydrate/hydrate-policy.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const LEASE_SCRIPT = path.join(REPO_ROOT, 'demos', 'lib', 'run-lease.mjs');
const REAL_FIXTURE_CONFIG = path.join(
  REPO_ROOT,
  'demos',
  'risk-trigger-fixture',
  '.opencode',
  'flowguard.json',
);
const FROZEN_AT = '2026-01-01T00:00:00.000Z';

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('documentation/demo-harness-reliability', () => {
  describe('HAPPY — CLI entry-point detection is symlink-safe', () => {
    it('detects the main module through a symlinked invocation path', () => {
      const dir = tempDir('fg-main-module-');
      try {
        const link = path.join(dir, 'run-lease-link.mjs');
        symlinkSync(LEASE_SCRIPT, link);
        expect(isMainModule(pathToFileURL(LEASE_SCRIPT).href, LEASE_SCRIPT)).toBe(true);
        expect(isMainModule(pathToFileURL(LEASE_SCRIPT).href, link)).toBe(true);
        expect(isMainModule(pathToFileURL(LEASE_SCRIPT).href, undefined)).toBe(false);
        expect(
          isMainModule(
            pathToFileURL(LEASE_SCRIPT).href,
            path.join(REPO_ROOT, 'demos', 'lib', 'environment-gate.mjs'),
          ),
        ).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('executes the lease CLI invoked through a symlink (former silent no-op)', () => {
      const dir = tempDir('fg-lease-cli-');
      const repo = tempDir('fg-lease-repo-');
      try {
        const link = path.join(dir, 'run-lease-link.mjs');
        symlinkSync(LEASE_SCRIPT, link);
        const output = execFileSync(
          process.execPath,
          [link, 'acquire', '--repo', repo, '--pid', String(process.pid)],
          { encoding: 'utf8' },
        );
        const parsed = JSON.parse(output) as { token?: string };
        expect(parsed.token).toBeTruthy();
        expect(releaseLease(repo, parsed.token ?? '')).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(repo, { recursive: true, force: true });
      }
    });
  });

  describe('BAD — only a true no-op turn may downgrade to NOT_VERIFIED', () => {
    it('requires zero tool calls and an observed, unchanged state for the exact label', () => {
      expect(
        hostTurnWasNoOp(
          { label: 'flow-05-implement', toolCalls: 0, stateObserved: true, stateChanged: false },
          'flow-05-implement',
        ),
      ).toBe(true);
      expect(
        hostTurnWasNoOp(
          { label: 'flow-05-implement', toolCalls: 1, stateObserved: true, stateChanged: false },
          'flow-05-implement',
        ),
      ).toBe(false);
      expect(
        hostTurnWasNoOp(
          { label: 'flow-05-implement', toolCalls: 0, stateObserved: true, stateChanged: true },
          'flow-05-implement',
        ),
      ).toBe(false);
      expect(
        hostTurnWasNoOp(
          { label: 'other-step', toolCalls: 0, stateObserved: true, stateChanged: false },
          'flow-05-implement',
        ),
      ).toBe(false);
      // An unreadable state digest is never an observed unchanged state.
      expect(
        hostTurnWasNoOp(
          { label: 'flow-05-implement', toolCalls: 0, stateObserved: false, stateChanged: null },
          'flow-05-implement',
        ),
      ).toBe(false);
      expect(
        hostTurnWasNoOp(
          { label: 'flow-05-implement', toolCalls: 0, stateChanged: false },
          'flow-05-implement',
        ),
      ).toBe(false);
      expect(hostTurnWasNoOp(null, 'flow-05-implement')).toBe(false);
      expect(hostTurnWasNoOp(undefined, 'flow-05-implement')).toBe(false);
    });
  });

  describe('CORNER — fixture config is applied after install, never pre-seeded', () => {
    it('merges the fixture repo config into the installed config', () => {
      const workspace = tempDir('fg-fixture-workspace-');
      const fixtureDir = tempDir('fg-fixture-source-');
      try {
        mkdirSync(path.join(workspace, '.opencode'), { recursive: true });
        writeFileSync(
          path.join(workspace, '.opencode', 'flowguard.json'),
          `${JSON.stringify({ schemaVersion: 'v1', policy: { mode: 'team' } }, null, 2)}\n`,
        );
        mkdirSync(path.join(fixtureDir, '.opencode'), { recursive: true });
        writeFileSync(
          path.join(fixtureDir, '.opencode', 'flowguard.json'),
          JSON.stringify({
            schemaVersion: 'v1',
            policy: {
              riskTriggerPaths: [
                { trigger: 'state_integrity', pattern: 'src/main/java/fixture/state/**' },
              ],
            },
          }),
        );
        expect(applyFixtureRepoConfig(workspace, fixtureDir)).toBe(true);
        const merged = JSON.parse(
          readFileSync(path.join(workspace, '.opencode', 'flowguard.json'), 'utf8'),
        ) as { policy: { mode?: string; riskTriggerPaths?: unknown[] } };
        expect(merged.policy.mode).toBe('team');
        expect(merged.policy.riskTriggerPaths).toEqual([
          { trigger: 'state_integrity', pattern: 'src/main/java/fixture/state/**' },
        ]);
      } finally {
        rmSync(workspace, { recursive: true, force: true });
        rmSync(fixtureDir, { recursive: true, force: true });
      }
    });

    it('is a no-op when the fixture has no repo config', () => {
      const workspace = tempDir('fg-fixture-workspace-');
      const fixtureDir = tempDir('fg-fixture-source-');
      try {
        mkdirSync(path.join(workspace, '.opencode'), { recursive: true });
        const installed = `${JSON.stringify({ schemaVersion: 'v1', policy: { mode: 'team' } }, null, 2)}\n`;
        writeFileSync(path.join(workspace, '.opencode', 'flowguard.json'), installed);
        expect(applyFixtureRepoConfig(workspace, fixtureDir)).toBe(false);
        expect(readFileSync(path.join(workspace, '.opencode', 'flowguard.json'), 'utf8')).toBe(
          installed,
        );
      } finally {
        rmSync(workspace, { recursive: true, force: true });
        rmSync(fixtureDir, { recursive: true, force: true });
      }
    });
  });

  describe('EDGE — the fixture risk trigger mapping is frozen in the policy snapshot', () => {
    it('freezes the shipped fixture config into policySnapshot.riskTriggerPaths', async () => {
      const fixtureConfig = FlowGuardConfigSchema.parse(
        JSON.parse(readFileSync(REAL_FIXTURE_CONFIG, 'utf8')),
      );
      const snapshot = freezePolicySnapshot(
        await resolveNewPolicyResolution(fixtureConfig, {}),
        FROZEN_AT,
        digestText,
      );
      expect(snapshot.riskTriggerPaths).toEqual([
        { trigger: 'state_integrity', pattern: 'src/main/java/fixture/state/**' },
      ]);

      // Contrast: the same resolution without the fixture config freezes no
      // mapping and produces a different snapshot hash (the mapping is
      // integrity-covered).
      const withoutConfig = FlowGuardConfigSchema.parse({ schemaVersion: 'v1' });
      const snapshotWithout = freezePolicySnapshot(
        await resolveNewPolicyResolution(withoutConfig, {}),
        FROZEN_AT,
        digestText,
      );
      expect(snapshotWithout.riskTriggerPaths).toEqual([]);
      expect(snapshot.hash).not.toBe(snapshotWithout.hash);
    });
  });
});

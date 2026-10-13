/**
 * @module documentation/demo-assurance-wiring.test
 * @description Contract wiring for the demo-assurance fixes: every runner must
 * use the shared forensic primitives, and the wrapper must isolate the installer.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 * @version v1
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DEMOS = join(process.cwd(), 'demos');
const readDemo = (relative: string): string => readFileSync(join(DEMOS, relative), 'utf8');

describe('demo assurance wiring', () => {
  describe('HAPPY — shared forensic primitives are used', () => {
    it('matrix recovery is occurrence-bound and fails closed on unreadable transcripts', () => {
      const matrix = readDemo('java-task-manager/run-live-matrix.mjs');
      expect(matrix).toContain('sameTurnRecoveryProofs');
      expect(matrix).toContain('transcriptTrust');
    });

    it('risk and replan drive the plan gate through the shared continuation', () => {
      expect(readDemo('risk-trigger-fixture/run-live-risk-trigger-controls.mjs')).toContain(
        'convergePlanGate',
      );
      expect(readDemo('risk-trigger-fixture/run-live-replan-recovery.mjs')).toContain(
        'convergePlanGate',
      );
    });
  });

  describe('BAD — the previously no-op gates are real', () => {
    it('claim controls enforce the pinned toolchain', () => {
      expect(readDemo('java-task-manager/run-live-claim-controls.mjs')).toContain(
        'assertToolchain(pins)',
      );
    });

    it('claim negative proof checks real completion-package absence', () => {
      expect(readDemo('java-task-manager/run-live-claim-controls.mjs')).toContain(
        'assertNoCompletionPackage',
      );
    });
  });

  describe('CORNER — operator intent is documented where it is needed', () => {
    it('replan usage header names the explicit old-control override', () => {
      const replan = readDemo('risk-trigger-fixture/run-live-replan-recovery.mjs');
      expect(replan).toContain('--allow-old-plan-override');
    });

    it('runner-local install lock isolation is wired through the wrapper', () => {
      expect(existsSync(join(DEMOS, 'run-all-demos.sh'))).toBe(true);
      expect(readDemo('run-all-demos.sh')).toContain('FLOWGUARD_INSTALL_LOCK_PATH');
    });
  });

  describe('EDGE — product identity and run lease are bound', () => {
    it('acquires the exclusive lease before any build', () => {
      const wrapper = readDemo('run-all-demos.sh');
      const leaseIndex = wrapper.indexOf('run-lease.mjs" acquire');
      const buildIndex = wrapper.indexOf('npm run build');
      expect(leaseIndex).toBeGreaterThan(-1);
      expect(buildIndex).toBeGreaterThan(-1);
      expect(leaseIndex).toBeLessThan(buildIndex);
      expect(wrapper).toContain('trap release_lease');
    });

    it('hands one immutable, digest-recorded tarball to every runner', () => {
      const wrapper = readDemo('run-all-demos.sh');
      expect(wrapper).toContain('GATE_DIGEST=');
      expect(wrapper).toContain('--tarball "$GATE_TARBALL"');
      expect(wrapper).toContain('--product-sha "$GATE_SHA"');
    });

    it('every runner checks the declared product identity', () => {
      expect(readDemo('java-task-manager/run-live-matrix.mjs')).toContain('options.productSha');
      expect(readDemo('java-task-manager/run-live-claim-controls.mjs')).toContain('productSha');
      expect(readDemo('risk-trigger-fixture/run-live-risk-trigger-controls.mjs')).toContain(
        'expectedProductSha',
      );
      expect(readDemo('risk-trigger-fixture/run-live-replan-recovery.mjs')).toContain(
        'options.productSha',
      );
    });

    it('replan installs its second workspace from the bound product artifact', () => {
      const replan = readDemo('risk-trigger-fixture/run-live-replan-recovery.mjs');
      expect(replan).toContain('installerCli(');
      expect(replan).toContain("'.tooling', 'product-cli'");
    });
  });

  describe('EDGE — result taxonomy is shared, not re-invented', () => {
    it('runners import the shared result kinds', () => {
      for (const runner of [
        'java-task-manager/run-live-matrix.mjs',
        'java-task-manager/run-live-claim-controls.mjs',
        'risk-trigger-fixture/run-live-risk-trigger-controls.mjs',
        'risk-trigger-fixture/run-live-replan-recovery.mjs',
      ]) {
        expect(readDemo(runner), runner).toContain("'../lib/results.mjs'");
      }
    });
  });
});

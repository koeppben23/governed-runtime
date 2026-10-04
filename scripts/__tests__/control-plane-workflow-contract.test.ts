/**
 * @module scripts/__tests__/control-plane-workflow-contract
 * @description Guards the release/control-plane wiring and the alignment
 * between the executable contract and its human documentation.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONTROL_PLANE_CONTRACT, REQUIRED_STATUS_CHECKS } from '../control-plane-contract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf-8').replace(/\r\n/g, '\n');
}

describe('scripts/control-plane-workflow-contract', () => {
  describe('release workflow', () => {
    const workflow = readRepoFile('.github/workflows/release.yml');

    it('runs the strict post-tag preflight before the verification jobs', () => {
      expect(workflow).toContain('  preflight:');
      expect(workflow).toContain('node scripts/verify-release-tag.js "$GITHUB_REF_NAME"');
      expect(workflow).toContain('CONTROL_PLANE_TOKEN: ${{ secrets.CONTROL_PLANE_READ_TOKEN }}');
      expect(workflow).toContain('  verify:\n    name: verify\n    needs: preflight');
      expect(workflow).toContain(
        'needs: [preflight, verify, release-smoke, verify-runtime, mutation]',
      );
    });

    it('no longer duplicates the tag-target check inline', () => {
      expect(workflow).not.toContain('Require tag target to equal protected main');
      expect(workflow).not.toContain(
        'Release tag must target the exact current origin/main commit',
      );
    });

    it('derives prerelease publication from the preflight decision authority', () => {
      expect(workflow).toContain('prerelease: ${{ steps.verify.outputs.prerelease }}');
      expect(workflow).toContain('needs.preflight.outputs.prerelease');
      expect(workflow).toContain('--prerelease');
    });

    it('publishes without requiring a git checkout in the write job', () => {
      const releaseJob = workflow.slice(workflow.indexOf('  release:'));
      expect(releaseJob).not.toContain('actions/checkout');
      expect(releaseJob).toContain('--repo "$GITHUB_REPOSITORY"');
    });
  });

  describe('control-plane drift workflow', () => {
    const workflow = readRepoFile('.github/workflows/control-plane-drift.yml');

    it('runs partial verification on pull requests without the privileged token', () => {
      const verifyJob = workflow.slice(
        workflow.indexOf('  verify:'),
        workflow.indexOf('  remediate:'),
      );
      expect(verifyJob).toContain('--mode partial');
      expect(verifyJob).toContain("if: github.event_name == 'pull_request'");
      const partialStep = verifyJob.slice(
        verifyJob.indexOf('Verify live control plane (pull request, partial)'),
        verifyJob.indexOf('Verify live control plane (trusted, strict)'),
      );
      expect(partialStep).not.toContain('CONTROL_PLANE_TOKEN');
    });

    it('runs strict verification with the read token on trusted events', () => {
      const verifyJob = workflow.slice(
        workflow.indexOf('  verify:'),
        workflow.indexOf('  remediate:'),
      );
      expect(verifyJob).toContain('--mode strict');
      expect(verifyJob).toContain("if: github.event_name != 'pull_request'");
      expect(verifyJob).toContain('CONTROL_PLANE_TOKEN: ${{ secrets.CONTROL_PLANE_READ_TOKEN }}');
      expect(verifyJob).not.toContain('issues: write');
    });

    it('runs privileged remediation only on trusted non-PR events', () => {
      expect(workflow).toContain("if: failure() && github.event_name != 'pull_request'");
      const remediateJob = workflow.slice(workflow.indexOf('  remediate:'));
      expect(remediateJob).toContain('issues: write');
      expect(remediateJob).not.toContain('actions/checkout');
    });

    it('never grants contents write', () => {
      expect(workflow).not.toContain('contents: write');
    });
  });

  describe('documentation alignment', () => {
    const branchProtection = readRepoFile('.github/BRANCH-PROTECTION.md');

    it('documents every required status check from the executable contract', () => {
      for (const check of REQUIRED_STATUS_CHECKS) {
        expect(branchProtection).toContain(`- \`${check}\``);
      }
    });

    it('documents both tag rulesets, the release environment, and the Actions policy', () => {
      expect(branchProtection).toContain(CONTROL_PLANE_CONTRACT.tagRulesets[0]?.name);
      expect(branchProtection).toContain(CONTROL_PLANE_CONTRACT.tagRulesets[1]?.name);
      expect(branchProtection).toContain('wait timer');
      expect(branchProtection).toContain('Actions policy');
    });

    it('documents the strict/partial verification modes and the read token', () => {
      expect(branchProtection).toContain('strict');
      expect(branchProtection).toContain('PARTIAL_VERIFICATION');
      expect(branchProtection).toContain('CONTROL_PLANE_READ_TOKEN');
    });
  });
});

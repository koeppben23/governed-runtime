/**
 * @module scripts/__tests__/control-plane-workflow-contract
 * @description Guards the release/control-plane wiring and the alignment
 * between the executable contract and its human documentation.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONTROL_PLANE_CONTRACT,
  REQUIRED_STATUS_CHECKS,
  TAG_RULESET_CONTRACTS,
} from '../control-plane-contract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf-8').replace(/\r\n/g, '\n');
}

describe('scripts/control-plane-workflow-contract', () => {
  describe('release workflow', () => {
    const workflow = readRepoFile('.github/workflows/release.yml');

    it('runs the post-tag preflight before the verification jobs', () => {
      expect(workflow).toContain('  preflight:');
      expect(workflow).toContain('node scripts/verify-release-tag.js "$GITHUB_REF_NAME"');
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

    it('publishes SemVer prereleases as GitHub prereleases', () => {
      expect(workflow).toContain('if [[ "$GITHUB_REF_NAME" == *-* ]]');
      expect(workflow).toContain('--prerelease');
    });
  });

  describe('control-plane drift workflow', () => {
    const workflow = readRepoFile('.github/workflows/control-plane-drift.yml');

    it('keeps pull_request verification read-only', () => {
      const verifyJob = workflow.slice(
        workflow.indexOf('  verify:'),
        workflow.indexOf('  remediate:'),
      );
      expect(verifyJob).toContain('GITHUB_TOKEN: ${{ github.token }}');
      expect(verifyJob).not.toContain('issues: write');
      expect(workflow).not.toContain('contents: write');
    });

    it('runs privileged remediation only on trusted non-PR events', () => {
      expect(workflow).toContain("if: failure() && github.event_name != 'pull_request'");
      const remediateJob = workflow.slice(workflow.indexOf('  remediate:'));
      expect(remediateJob).toContain('issues: write');
      expect(remediateJob).not.toContain('actions/checkout');
    });
  });

  describe('documentation alignment', () => {
    const branchProtection = readRepoFile('.github/BRANCH-PROTECTION.md');

    it('documents every required status check from the executable contract', () => {
      for (const check of REQUIRED_STATUS_CHECKS) {
        expect(branchProtection).toContain(`- \`${check}\``);
      }
    });

    it('documents both tag rulesets and the release environment', () => {
      expect(branchProtection).toContain(TAG_RULESET_CONTRACTS[0]?.name);
      expect(branchProtection).toContain(TAG_RULESET_CONTRACTS[1]?.name);
      expect(branchProtection).toContain('release');
      expect(branchProtection).toContain('wait timer');
    });
  });

  describe('contract sanity', () => {
    it('keeps tag creation and immutability as separate policies', () => {
      expect(TAG_RULESET_CONTRACTS).toHaveLength(2);
      const [creation, immutability] = TAG_RULESET_CONTRACTS;
      expect(creation).toBeDefined();
      expect(immutability).toBeDefined();
      expect(creation?.requiredRules).toEqual(['creation']);
      expect(creation?.expectsBypassActor).toBe(true);
      expect(immutability?.requiredRules).toEqual(['update', 'deletion', 'non_fast_forward']);
      expect(immutability?.expectsBypassActor).toBe(false);
    });

    it('requires no approving review for the solo-maintainer ruleset', () => {
      expect(CONTROL_PLANE_CONTRACT.branchRuleset.pullRequest.requiredApprovingReviewCount).toBe(0);
    });
  });
});

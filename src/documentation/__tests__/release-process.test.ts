/**
 * @module documentation/__tests__/release-process
 * @description Guards the protected-main release process against unsafe local tag flows.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 * @version v1
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf-8').replace(/\r\n/g, '\n');
}

function packageScripts(): Record<string, string> {
  return JSON.parse(readRepoFile('package.json')).scripts;
}

describe('documentation/release-process', () => {
  describe('HAPPY — safe release scripts are present', () => {
    it('exposes prepare, verify, and pre-tag assertion scripts', () => {
      const scripts = packageScripts();

      expect(scripts['release:prepare']).toBe('node scripts/prepare-release.js');
      expect(scripts['release:verify']).toContain('npm run test:install-verify');
      expect(scripts['release:assert-main-tag']).toBe('node scripts/assert-main-release-tag.js');
    });
  });

  describe('BAD — unsafe release primitives stay removed', () => {
    it('does not use npm version lifecycle hooks for releases', () => {
      const scripts = packageScripts();

      expect(scripts.preversion).toBeUndefined();
      expect(scripts.postversion).toBeUndefined();
    });

    it('does not skip git hooks in package scripts', () => {
      const scripts = Object.values(packageScripts()).join('\n');

      expect(scripts).not.toContain('--no-verify');
    });
  });

  describe('CORNER — docs require PR before tag', () => {
    it('contributing guidance owns the PR-first, tag-after-merge ordering', () => {
      const contributing = readRepoFile('CONTRIBUTING.md');

      expect(contributing).toContain('Create and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`');
      expect(contributing).toContain('npm run release:assert-main-tag -- vX.Y.Z');
      expect(contributing).toContain('`npm version` for FlowGuard releases');
      expect(contributing).toContain(
        'If a release tag is pushed before the release commit is merged',
      );
      expect(contributing).toContain('Do not overwrite or force-push the tag');
    });

    it('README delegates the release process instead of duplicating the checklist', () => {
      const readme = readRepoFile('README.md');

      expect(readme).toContain('Releases are\nPR-first');
      expect(readme).toContain('docs/release-policy.md');
      expect(readme).not.toContain('npm run release:assert-main-tag');
    });

    it('release policy binds v-tags to origin/main commits', () => {
      const policy = readRepoFile('docs/release-policy.md');

      expect(policy).toContain(
        'A `v*` tag\nmust point at a commit already contained in `origin/main`',
      );
      expect(policy).toContain('recovery procedure for a tag published before merge');
    });
  });

  describe('EDGE — release artifacts stay checksum-bound', () => {
    it('verifies the runtime test artifact before installing it', () => {
      const workflow = readRepoFile('.github/workflows/release.yml');
      const runtimeJob = workflow.slice(
        workflow.indexOf('  verify-runtime:'),
        workflow.indexOf('  release-smoke:'),
      );

      expect(runtimeJob).toContain('sha256sum --check checksums.sha256');
      expect(runtimeJob.indexOf('sha256sum --check checksums.sha256')).toBeLessThan(
        runtimeJob.indexOf('npm install "$GITHUB_WORKSPACE/flowguard-core-"*.tgz'),
      );
    });

    it('documents prerelease state incompatibility without a migration claim', () => {
      const upgrade = readRepoFile('docs/upgrade-rollback.md');

      expect(upgrade).toContain('No forward-compatibility guarantee.');
      expect(upgrade).toContain('policy-digest.v3');
      expect(upgrade).toContain('Do not edit persisted state to bridge that');
    });
  });

  describe('EDGE — contributing guidance matches the protected-main model', () => {
    it('documents release branches and the pre-tag assertion', () => {
      const contributing = readRepoFile('CONTRIBUTING.md');

      expect(contributing).toContain('release/vX.Y.Z');
      expect(contributing).toContain('npm run release:assert-main-tag -- vX.Y.Z');
      expect(contributing).toContain('Create and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`');
    });
  });
});

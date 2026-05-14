/**
 * @module documentation/__tests__/project-governance
 * @description Guards ticket and PR governance templates against process drift.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 * @version v1
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

const ISSUE_TEMPLATES = [
  'bug.yml',
  'feature.yml',
  'quality.yml',
  'high-risk.yml',
  'release.yml',
  'docs.yml',
] as const;

function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf-8').replace(/\r\n/g, '\n');
}

describe('documentation/project-governance', () => {
  describe('HAPPY — templates exist', () => {
    it('provides issue templates and PR template', () => {
      for (const template of ISSUE_TEMPLATES) {
        expect(existsSync(join(REPO_ROOT, '.github', 'ISSUE_TEMPLATE', template))).toBe(true);
      }

      expect(existsSync(join(REPO_ROOT, '.github', 'PULL_REQUEST_TEMPLATE.md'))).toBe(true);
    });
  });

  describe('BAD — definition of done remains explicit', () => {
    it('requires clean conventional branch, docs, changelog, and verification in issue templates', () => {
      for (const template of ISSUE_TEMPLATES.filter((name) => name !== 'release.yml')) {
        const content = readRepoFile(`.github/ISSUE_TEMPLATE/${template}`);

        expect(content).toContain('Clean conventional branch');
        expect(content).toContain('Documentation');
        expect(content).toContain('CHANGELOG.md');
        expect(content).toContain('Verification');
      }
    });

    it('requires docs and changelog decisions in the PR template', () => {
      const content = readRepoFile('.github/PULL_REQUEST_TEMPLATE.md');

      expect(content).toContain('## Documentation');
      expect(content).toContain('## Changelog');
      expect(content).toContain('Reason if not needed');
      expect(content).toContain('## Verification');
    });
  });

  describe('CORNER — high-risk work has stronger contract', () => {
    it('requires fail-closed behavior, negative path, authority, and recovery', () => {
      const content = readRepoFile('.github/ISSUE_TEMPLATE/high-risk.yml');

      expect(content).toContain('Fail-closed behavior preserved');
      expect(content).toContain('No duplicate runtime authority');
      expect(content).toContain('Negative-path tests');
      expect(content).toContain('Rollback Or Recovery');
    });
  });

  describe('EDGE — project governance docs expose ready gate and project fields', () => {
    it('documents readiness, project fields, docs contract, and changelog contract', () => {
      const content = readRepoFile('docs/project-governance.md');

      expect(content).toContain('## Ready For Work Gate');
      expect(content).toContain('## Recommended Project Fields');
      expect(content).toContain('## Documentation Contract');
      expect(content).toContain('## Changelog Contract');
      expect(content).toContain('## High-Risk Contract');
    });
  });
});

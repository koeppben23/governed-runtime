/**
 * @module documentation/__tests__/testing-strategy
 * @description Drift guards for testing strategy claims that affect CI risk posture.
 *
 * @test-policy HAPPY, BAD, CORNER
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

function mutationTargets(): string[] {
  return JSON.parse(readRepoFile('stryker.conf.json')).mutate;
}

describe('documentation/testing-strategy', () => {
  it('HAPPY: documents the current mutation target count from stryker.conf.json', () => {
    const docs = readRepoFile('docs/testing-strategy.md');
    const count = mutationTargets().length;

    expect(docs).toContain(`${count} security-critical`);
    expect(docs).toContain(
      `| **Total**                                                                                                       | **${count}** |`,
    );
  });

  it('BAD: does not claim mutation is a pull-request required check', () => {
    const docs = readRepoFile('docs/testing-strategy.md');
    const branchProtection = readRepoFile('.github/BRANCH-PROTECTION.md');

    expect(branchProtection).toContain('intentionally **not** required');
    expect(docs).toContain('not a pull-request required check');
    expect(docs).not.toContain('The `mutation` CI job is blocking.');
  });

  it('CORNER: mutation workflow is not triggered directly by pull_request', () => {
    const workflow = readRepoFile('.github/workflows/mutation.yml');

    expect(workflow).not.toMatch(/^\s*pull_request:/m);
    expect(workflow).toContain('workflow_dispatch');
    expect(workflow).toContain('schedule:');
  });
});

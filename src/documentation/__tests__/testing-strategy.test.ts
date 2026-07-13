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

const INTEGRITY_MUTATION_TARGETS = [
  // audit integrity
  'src/audit/completeness.ts',
  'src/audit/integrity.ts',
  // policy and reasons
  'src/config/policy.ts',
  'src/config/reasons.ts',
  // identity
  'src/identity/token-verifier.ts',
  'src/identity/key-resolver.ts',
];

const CRITICAL_MUTATION_TARGETS = [
  'src/integration/review/orchestrator-detection.ts',
  'src/integration/review/orchestrator-output.ts',
  'src/integration/review/agent-resolution.ts',
  'src/integration/tools/review-validation-mode.ts',
  'src/shared/canonical-json.ts',
  'src/integration/plugin-audit-lifecycle-reason.ts',
  'src/templates/codex-plugin.ts',
  'src/templates/claude-code-plugin.ts',
  ...INTEGRITY_MUTATION_TARGETS,
];

describe('documentation/testing-strategy', () => {
  it('HAPPY: documents the current mutation target count from stryker.conf.json', () => {
    const docs = readRepoFile('docs/testing-strategy.md');
    const count = mutationTargets().length;

    expect(docs).toContain(`${count} security-critical`);
    expect(docs).toMatch(
      new RegExp(`\\|\\s*\\*\\*Total\\*\\*\\s*\\|\\s*\\*\\*${count}\\*\\*\\s*\\|`),
    );
  });

  it('HAPPY: includes documented critical mutation targets in stryker.conf.json', () => {
    const targets = mutationTargets();

    for (const target of CRITICAL_MUTATION_TARGETS) {
      expect(targets).toContain(target);
    }
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

  it('HAPPY: documents threshold and admission rule rationale', () => {
    const docs = readRepoFile('docs/testing-strategy.md');

    expect(docs).toContain('Threshold And Admission Rule');
    expect(docs).toContain('`break: 80`');
    expect(docs).toContain('no per-area lower thresholds');
    expect(docs).toContain('targeted `--mutate` run');
    expect(docs).toContain('`StringLiteral`');
    expect(docs).toContain('`ArrayDeclaration`');
  });
});

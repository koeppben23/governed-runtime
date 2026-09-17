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
import {
  MUTATION_AUTHORITY_INVENTORY,
  type RequiredAuthorityEntry,
} from '../../architecture/__tests__/mutation-authority-inventory.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf-8').replace(/\r\n/g, '\n');
}

function mutationTargets(): string[] {
  return JSON.parse(readRepoFile('stryker.conf.json')).mutate;
}

const requiredEntries = MUTATION_AUTHORITY_INVENTORY.filter(
  (entry): entry is RequiredAuthorityEntry => entry.classification === 'required',
);
const deferredEntries = MUTATION_AUTHORITY_INVENTORY.filter(
  (entry) => entry.classification !== 'required',
);
const baseCriticalTargets = requiredEntries
  .filter((entry) => entry.profile === 'base' && entry.critical === true)
  .map((entry) => entry.target);

function admissionBacklogSection(docs: string): string {
  const start = docs.indexOf('### Admission Backlog');
  expect(start, 'docs/testing-strategy.md lacks the Admission Backlog section').toBeGreaterThan(-1);
  const rest = docs.slice(start);
  const nextHeading = rest.indexOf('\n### ', 1);
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}

describe('documentation/testing-strategy', () => {
  it('HAPPY: documents the current mutation target count from stryker.conf.json', () => {
    const docs = readRepoFile('docs/testing-strategy.md');
    const count = mutationTargets().length;

    expect(docs).toContain(`${count} security-critical`);
    expect(docs).toMatch(
      new RegExp(`\\|\\s*\\*\\*Total\\*\\*\\s*\\|\\s*\\*\\*${count}\\*\\*\\s*\\|`),
    );
  });

  it('HAPPY: every "N files are mutated" claim matches the mutate list', () => {
    const docs = readRepoFile('docs/testing-strategy.md');
    const count = mutationTargets().length;
    const claims = [...docs.matchAll(/(\d+) files are mutated/g)].map((match) => Number(match[1]));

    expect(claims.length).toBeGreaterThan(0);
    expect(claims.filter((claim) => claim !== count)).toEqual([]);
  });

  it('HAPPY: the machine scope list names current modules only', () => {
    const docs = readRepoFile('docs/testing-strategy.md');

    expect(docs).not.toContain('next-action');
    expect(docs).toContain('workflow-directive');
  });

  it('HAPPY: includes documented critical mutation targets in stryker.conf.json', () => {
    const targets = mutationTargets();

    expect(baseCriticalTargets.length).toBeGreaterThan(0);
    for (const target of baseCriticalTargets) {
      expect(targets).toContain(target);
    }
  });

  it('HAPPY: every deferred authority is listed in the Admission Backlog', () => {
    const backlog = admissionBacklogSection(readRepoFile('docs/testing-strategy.md'));

    for (const entry of deferredEntries) {
      const label = 'root' in entry ? `${entry.root}/**` : entry.target;
      expect(backlog, `${label} missing from the Admission Backlog`).toContain(label);
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

  it('HAPPY: documents the per-profile admission policy', () => {
    const docs = readRepoFile('docs/testing-strategy.md');

    expect(docs).toContain('Threshold And Admission Rule');
    expect(docs).toContain('`break: 80`');
    expect(docs).toContain('no per-area lower thresholds');
    expect(docs).toContain('Targeted runs are diagnostic only');
    expect(docs).toContain('Admission evidence is the profile full run');
    expect(docs).toContain('per-target break threshold');
    expect(docs).toContain('aggregate');
  });

  it('HAPPY: documents threshold and admission rule rationale', () => {
    const docs = readRepoFile('docs/testing-strategy.md');

    expect(docs).toContain('`StringLiteral`');
    expect(docs).toContain('`ArrayDeclaration`');
    expect(docs).toContain('mutation-authority-inventory.ts');
    expect(docs).toContain('verify-mutation-admission.mjs');
  });
});

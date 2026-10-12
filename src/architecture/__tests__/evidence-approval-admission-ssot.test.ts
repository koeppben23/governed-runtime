/**
 * @module architecture/evidence-approval-admission-ssot
 * @description Anti-drift guard for the ephemeral approval admission boundary.
 *
 * Exactly one module issues an admission (the canonical protected application
 * after it checked the approval authority and the evidence preflight) and
 * exactly one module consumes it (the lowest persistence boundary). A new
 * issuer or consumer caller outside that set would let a module mint or spend
 * an approval capability without the canonical checks.
 *
 * @version v1
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(process.cwd(), 'src');

const ISSUER = 'issueEvidenceApprovalAdmission';
const CONSUMER = 'consumeEvidenceApprovalAdmission';

const ISSUER_FILES = new Set([
  'audit/proofgraph/evidence-approval-admission.ts',
  'rails/evidence-approval-application.ts',
]);
const CONSUMER_FILES = new Set([
  'audit/proofgraph/evidence-approval-admission.ts',
  'adapters/persistence.ts',
]);

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__') continue;
        walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      if (entry.name.endsWith('.test.ts')) continue;
      out.push(full.slice(SRC_ROOT.length + 1));
    }
  };
  walk(SRC_ROOT);
  return out;
}

function referencingFiles(symbol: string): string[] {
  return sourceFiles().filter((rel) => readFileSync(join(SRC_ROOT, rel), 'utf8').includes(symbol));
}

describe('evidence-approval admission SSOT', () => {
  it('issues admissions only from the canonical protected application', () => {
    expect(referencingFiles(ISSUER)).toEqual([...ISSUER_FILES].sort());
  });

  it('consumes admissions only at the lowest persistence boundary', () => {
    expect(referencingFiles(CONSUMER)).toEqual([...CONSUMER_FILES].sort());
  });
});

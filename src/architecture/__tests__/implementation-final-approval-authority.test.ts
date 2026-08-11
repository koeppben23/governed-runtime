/**
 * @module architecture/implementation-final-approval-authority
 * @description Anti-drift guard: Implementation Final Approval Authority.
 *
 *              Enforces that the candidate-bound final approval path is the
 *              single authority for creating an ImplementationApprovalCertificate
 *              and transitioning to COMPLETE for the implementation flow.
 *
 *              Enforces:
 *              1. Only validateImplementationApprovalBinding constructs a binding.
 *              2. Only createImplementationApprovalCertificate constructs a certificate.
 *              3. No rail or presentation layer calls resolveImplementationCandidate directly.
 *              4. Rails never import the candidate resolver.
 *              5. No duplicate validate/hasCurrent implementation exists outside the authority file.
 *              6. The implementation-approval-binding module is the single validation authority.
 *              7. Implementation review tools cannot synthesize review provenance.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(process.cwd(), 'src');

const APPROVAL_BINDING_AUTHORITY = 'state/implementation-approval-binding.ts';
const APPROVAL_CERTIFICATE_AUTHORITY = 'state/evidence-implementation-approval.ts';
const CANDIDATE_RESOLVER = 'integration/implementation-candidate.ts';

function* walkTsFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '__tests__') {
      yield* walkTsFiles(full);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      yield full;
    }
  }
}

function relativePath(abs: string): string {
  return abs.replace(SRC_ROOT + '/', '');
}

describe('implementation-final-approval authority', () => {
  it('only the canonical binding module exports validateImplementationApprovalBinding', () => {
    const offenders: string[] = [];
    for (const fp of walkTsFiles(SRC_ROOT)) {
      const rel = relativePath(fp);
      if (rel === APPROVAL_BINDING_AUTHORITY) continue;
      const content = readFileSync(fp, 'utf-8');
      if (
        content.includes('export function validateImplementationApprovalBinding') ||
        content.includes('export async function validateImplementationApprovalBinding')
      ) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('only the canonical certificate module exports ImplementationApprovalCertificate', () => {
    const offenders: string[] = [];
    for (const fp of walkTsFiles(SRC_ROOT)) {
      const rel = relativePath(fp);
      if (rel === APPROVAL_CERTIFICATE_AUTHORITY) continue;
      const content = readFileSync(fp, 'utf-8');
      if (content.includes('export const ImplementationApprovalCertificate')) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('rails never import the implementation candidate resolver', () => {
    const offenders: string[] = [];
    const railsDir = join(SRC_ROOT, 'rails');
    for (const fp of walkTsFiles(railsDir)) {
      const content = readFileSync(fp, 'utf-8');
      if (content.includes("'../integration/implementation-candidate'")) {
        offenders.push(relativePath(fp));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no duplicate hasCurrentImplementationApprovalCertificate exists', () => {
    const offenders: string[] = [];
    for (const fp of walkTsFiles(SRC_ROOT)) {
      const rel = relativePath(fp);
      if (rel === APPROVAL_BINDING_AUTHORITY) continue;
      const content = readFileSync(fp, 'utf-8');
      if (
        content.includes('function hasCurrentImplementationApprovalCertificate') ||
        content.includes('export function hasCurrentImplementationApprovalCertificate')
      ) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('only the approval binding module defines validateCurrentImplementationApprovalCertificate', () => {
    const offenders: string[] = [];
    for (const fp of walkTsFiles(SRC_ROOT)) {
      const rel = relativePath(fp);
      if (rel === APPROVAL_BINDING_AUTHORITY) continue;
      const content = readFileSync(fp, 'utf-8');
      if (content.includes('export function validateCurrentImplementationApprovalCertificate')) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('implementation review never creates or binds review provenance from submitted findings', () => {
    const content = readFileSync(join(SRC_ROOT, 'integration/tools/implement-review.ts'), 'utf-8');
    expect(content).not.toContain("status: 'bound'");
    expect(content).not.toContain('buildInvocationEvidence(');
    expect(content).not.toContain('ReviewInvocationEvidence');
  });

  it('only the canonical assurance binder can bind host review evidence', () => {
    const assurance = readFileSync(
      join(SRC_ROOT, 'integration/review/host-review-assurance-binding.ts'),
      'utf-8',
    );
    expect(assurance).toContain('export function bindHostReviewInvocation');
    expect(assurance).toContain("invocation.invocationMode === 'host_subagent_task'");
  });
});

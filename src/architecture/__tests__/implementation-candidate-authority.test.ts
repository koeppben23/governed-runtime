/**
 * @module architecture/implementation-candidate-authority
 * @description Anti-drift guard: Candidate Authority must not fragment.
 *
 *              Only the dedicated candidate resolver may construct a canonical
 *              ImplementationCandidate. Rails must never compute candidate
 *              identity. The candidate model itself is the single schema
 *              authority; no parallel digest definitions may exist.
 *
 *              Enforces:
 *              1. computeCandidateDigest is called only from the authority files.
 *              2. No rail file imports candidate-digest computation directly.
 *              3. No lifecycle consumer computes its own candidate digest.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(process.cwd(), 'src');

const CANDIDATE_SCHEMA_AUTHORITY = 'state/evidence-candidate.ts';
const CANDIDATE_RESOLVER = 'integration/implementation-candidate.ts';

/** Files that may legitimately call computeCandidateDigest. */
const DIGEST_COMPUTATION_AUTHORITIES = new Set([
  CANDIDATE_SCHEMA_AUTHORITY,
  CANDIDATE_RESOLVER,
  'fixtures.ts',
]);

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

describe('implementation-candidate authority', () => {
  it('computeCandidateDigest is only called from authority files', () => {
    const offenders: string[] = [];
    for (const fp of walkTsFiles(SRC_ROOT)) {
      if (DIGEST_COMPUTATION_AUTHORITIES.has(relativePath(fp))) continue;
      const content = readFileSync(fp, 'utf-8');
      if (content.includes('computeCandidateDigest')) {
        offenders.push(relativePath(fp));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('rails never import computeCandidateDigest or computeContentDigest directly', () => {
    const offenders: string[] = [];
    const railsDir = join(SRC_ROOT, 'rails');
    for (const fp of walkTsFiles(railsDir)) {
      const content = readFileSync(fp, 'utf-8');
      if (content.includes('computeCandidateDigest') || content.includes('computeContentDigest')) {
        offenders.push(relativePath(fp));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('only the dedicated resolver defines resolveImplementationCandidate', () => {
    const implementers: string[] = [];
    for (const abs of walkTsFiles(SRC_ROOT)) {
      const rel = relativePath(abs);
      if (rel === CANDIDATE_RESOLVER) continue;
      const content = readFileSync(abs, 'utf-8');
      if (
        content.includes('export async function resolveImplementationCandidate') ||
        content.includes('export function resolveImplementationCandidate')
      ) {
        implementers.push(rel);
      }
    }
    expect(implementers).toEqual([]);
  });

  it('candidate identity model lives only in evidence-candidate.ts', () => {
    const offenders: string[] = [];
    for (const fp of walkTsFiles(SRC_ROOT)) {
      const rel = relativePath(fp);
      if (rel === CANDIDATE_SCHEMA_AUTHORITY) continue;
      const content = readFileSync(fp, 'utf-8');
      // Look for files that define a shape with all three candidate-identity
      // fields, indicating a duplicate schema.
      if (
        content.includes('version: z.literal(1)') &&
        content.includes('baseHeadSha') &&
        content.includes('candidateDigest')
      ) {
        offenders.push(rel);
      }
    }
    // Only the schema authority and the fixture may define these shape fields.
    const allowed = [CANDIDATE_SCHEMA_AUTHORITY, 'fixtures.ts'];
    const violations = offenders.filter((f) => !allowed.includes(f));
    expect(violations).toEqual([]);
  });
});

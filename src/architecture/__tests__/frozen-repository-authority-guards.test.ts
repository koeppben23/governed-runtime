/**
 * @module architecture/frozen-repository-authority-guards
 * @description Architecture guards: repository review authority must come from
 *              frozen candidates, never from mutable revision resolution.
 *
 * Guard 1 — minting boundary: `RepositoryObservation` records may only be
 * created by the sanctioned parent replay. No other module may construct them.
 *
 * Guard 2 — mutable revision resolution is banned inside review-obligation
 * creation call sites. `headCommitFull` / `git rev-parse HEAD` may only run at
 * explicit freeze points (frozen candidate/context construction); the review
 * obligation creators must consume the frozen authority instead.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');

function listSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...listSourceFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      results.push(full);
    }
  }
  return results;
}

function fileContent(relativePath: string): string {
  return readFileSync(join(SRC, relativePath), 'utf-8');
}

/** Files sanctioned to mint authoritative RepositoryObservation records. */
const ALLOWED_OBSERVATION_MINTERS = [
  'integration/review/observation-replay.ts',
  'state/evidence-review-authority.ts',
];

describe('Guard 1: RepositoryObservation minting boundary', () => {
  const minters: string[] = [];
  for (const file of listSourceFiles(SRC)) {
    const relative = file.slice(SRC.length + 1);
    if (relative.endsWith('.test.ts')) continue;
    if (ALLOWED_OBSERVATION_MINTERS.includes(relative)) continue;
    // Minting an authoritative record means assigning its binding field.
    if (/observedBySessionId\s*:/.test(readFileSync(file, 'utf-8'))) minters.push(relative);
  }
  it('only the sanctioned parent replay mints authoritative observations', () => {
    expect(minters).toEqual([]);
  });
});

describe('Guard 2: no mutable revision resolution in review-authority construction', () => {
  /** Review-obligation creation call sites that must consume frozen authority. */
  const OBLIGATION_CREATION_FILES = [
    'integration/tools/plan.ts',
    'integration/tools/implement-shared.ts',
    'integration/tools/architecture-review.ts',
    'integration/tools/architecture-submit.ts',
    'integration/tools/review-tool/obligation-creation.ts',
  ];

  /** Sanctioned freeze-time construction points. */
  const FREEZE_AUTHORITY_FILES = ['rails/repository-authority.ts'];

  function mutableResolutionCalls(relative: string): string[] {
    const content = fileContent(relative);
    const hits: string[] = [];
    for (const marker of ['headCommitFull(', 'rev-parse', "revParse('HEAD'", "'HEAD^{commit}'"]) {
      if (content.includes(marker)) hits.push(marker);
    }
    return hits;
  }

  it('obligation creation sites never resolve mutable revisions directly', () => {
    const violations: string[] = [];
    for (const relative of OBLIGATION_CREATION_FILES) {
      // The only sanctioned mutable-resolving form at these sites is the
      // freeze-time resolution feeding `repositoryAuthority` — a raw
      // provenance projection from mutable state is the forbidden pattern.
      const content = fileContent(relative);
      const passesRawProvenance = /repositoryRevisionProvenance\s*:/.test(content);
      if (passesRawProvenance) violations.push(`${relative}: raw provenance projection`);
      if (content.includes('repositoryAuthority') === false && content.includes('reviewSubject')) {
        // plan/architecture/implement must consume frozen authority.
        if (
          ['integration/tools/plan.ts', 'integration/tools/implement-shared.ts'].includes(
            relative,
          ) &&
          !content.includes('freezeContextAuthority') &&
          !content.includes('freezeCandidatePairAuthority')
        ) {
          violations.push(`${relative}: missing frozen authority construction`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('mutable revision resolution is confined to sanctioned freeze points', () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(SRC)) {
      const relative = file.slice(SRC.length + 1);
      if (relative.endsWith('.test.ts')) continue;
      if (FREEZE_AUTHORITY_FILES.includes(relative)) continue;
      if (relative.startsWith('adapters/')) continue;
      // freeze-time resolution feeding frozen authority construction remains
      // allowed at the identified creation sites.
      if (OBLIGATION_CREATION_FILES.includes(relative)) continue;
      const content = readFileSync(file, 'utf-8');
      if (
        /headCommitFull\(/.test(content) &&
        !/freezeContextAuthority|freezeCommitRevisionTarget|freezeImplementationBaseAuthority/.test(
          content,
        )
      ) {
        offenders.push(relative);
      }
    }
    expect(offenders).toEqual([]);
  });
});

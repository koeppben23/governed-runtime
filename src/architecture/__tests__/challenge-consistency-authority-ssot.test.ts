/**
 * @module architecture/challenge-consistency-authority-ssot.test
 * @description Anti-drift guard (#747): challenge requirement, evidence,
 * distinctness, outcome, and resolution-verdict coherence has exactly ONE
 * authority — `src/integration/review/enforcement/challenge-consistency.ts`.
 * It must NOT be duplicated into `findings-consistency.ts`, which owns only the
 * verdict/blocking-issues coherence rule (F12).
 *
 * The ticket separates the two authorities deliberately:
 *   verdict/blocking-issues consistency  !=  challenge/resolution consistency
 *
 * This guard fails closed: the dedicated authority file must exist, and no
 * challenge/resolution consistency symbol may reappear in findings-consistency.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ENFORCEMENT_DIR = join(process.cwd(), 'src', 'integration', 'review', 'enforcement');

const CHALLENGE_AUTHORITY = join(ENFORCEMENT_DIR, 'challenge-consistency.ts');
const FINDINGS_AUTHORITY = join(ENFORCEMENT_DIR, 'findings-consistency.ts');

/**
 * Symbols that belong exclusively to the challenge/resolution authority. If any
 * of these appear in findings-consistency.ts, the authorities were merged or
 * duplicated.
 */
const CHALLENGE_SYMBOLS = [
  'validateChallengeConsistency',
  'validateResolutionVerdicts',
  'validateChallengeSubstance',
  'challengeSubstanceSignature',
  'ChallengeConsistencyInput',
  'ChallengeConsistencyResult',
  'resolutionVerdicts',
  'unresolvedImplementationChallengeIds',
];

function findLeakedSymbols(content: string): string[] {
  return CHALLENGE_SYMBOLS.filter((symbol) => content.includes(symbol));
}

describe('challenge-consistency authority SSOT (#747 anti-duplication)', () => {
  it('the dedicated challenge-consistency authority file exists (fail-closed)', () => {
    expect(existsSync(CHALLENGE_AUTHORITY)).toBe(true);
  });

  it('challenge/resolution consistency logic does not leak into findings-consistency.ts', () => {
    const content = readFileSync(FINDINGS_AUTHORITY, 'utf8');
    const leaked = findLeakedSymbols(content);
    if (leaked.length > 0) {
      console.error(
        'Challenge/resolution consistency symbol(s) found in findings-consistency.ts ' +
          '(the two authorities must stay separate, #747):',
        leaked,
      );
    }
    expect(leaked).toEqual([]);
  });

  it('the challenge authority actually owns the canonical entrypoint', () => {
    const content = readFileSync(CHALLENGE_AUTHORITY, 'utf8');
    expect(content).toContain('export function validateChallengeConsistency');
  });

  describe('negative fixture — proves the detector fires', () => {
    it('flags a challenge symbol reintroduced into findings-consistency content', () => {
      const fixture = 'export function validateChallengeConsistency(input) { return input; }';
      expect(findLeakedSymbols(fixture)).toContain('validateChallengeConsistency');
    });
  });
});

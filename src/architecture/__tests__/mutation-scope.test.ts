/**
 * @module architecture/mutation-scope
 * @description Guards the mutation scope against silent erosion.
 *
 * A path in `stryker.conf.json` that no longer resolves does not fail the
 * mutation run — it simply mutates nothing, so the file drops out of the
 * trusted computing base while the gate still reports success. That failure
 * mode is invisible in a green run, which is precisely how a production
 * regression in `plugin-workspace.ts` passed every required check while the
 * file was outside the scope.
 *
 * These guards are static: they assert the scope is well-formed and that the
 * authorities it is supposed to cover are actually listed. They do not measure
 * a mutation score.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..', '..');

interface StrykerConfig {
  readonly mutate: readonly string[];
}

function strykerConfig(): StrykerConfig {
  return JSON.parse(readFileSync(join(ROOT, 'stryker.conf.json'), 'utf-8')) as StrykerConfig;
}

/**
 * Authorities that must never leave the mutation scope. Each one decides
 * admissibility, durability, or composition of governed evidence, so a
 * surviving mutant there is a real assurance gap rather than a style issue.
 */
const REQUIRED_IN_SCOPE = [
  // Composition boundary: production wiring of the workspace surface.
  'src/integration/plugin-workspace.ts',
  'src/integration/plugin.ts',
  // Durable audit authorities.
  'src/adapters/persistence.ts',
  'src/adapters/persistence-audit.ts',
  'src/audit/integrity.ts',
  'src/audit/timestamp-verification.ts',
  // Archive verification verdict surface.
  'src/adapters/workspace/archive-verify-chain.ts',
  'src/adapters/workspace/archive-verify-helpers.ts',
  // Evidence identity and fencing.
  'src/integration/review/enforcement/challenge-binding.ts',
  'src/integration/review/enforcement/challenge-consistency.ts',
  'src/integration/runtime-lease.ts',
  'src/state/evidence-mutation-episode.ts',
];

describe('mutation scope', () => {
  it('lists only paths that still exist', () => {
    const stale = strykerConfig().mutate.filter((entry) => !existsSync(join(ROOT, entry)));
    expect(stale).toEqual([]);
  });

  it('lists every path exactly once', () => {
    const mutate = strykerConfig().mutate;
    const duplicates = mutate.filter((entry, index) => mutate.indexOf(entry) !== index);
    expect(duplicates).toEqual([]);
  });

  it('covers the authorities that must never leave the trusted computing base', () => {
    const mutate = new Set(strykerConfig().mutate);
    const missing = REQUIRED_IN_SCOPE.filter((entry) => !mutate.has(entry));
    expect(missing).toEqual([]);
  });
});

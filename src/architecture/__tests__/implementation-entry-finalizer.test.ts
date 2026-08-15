/**
 * @module architecture/implementation-entry-finalizer.test
 * @description Anti-drift guard for the implementation-entry invariant:
 *
 *   ANY state transition X → IMPLEMENTATION
 *   ⇒ implementationBaseAuthority is frozen
 *
 * Constructive enforcement lives at the single persistence boundary, not per
 * rail: `adapters/persistence.ts` refuses to write an IMPLEMENTATION-phase
 * state without a frozen base (pure guard, covers every direct writer), and
 * the governed tool persistence path (`integration/tools/helpers.ts`)
 * performs the freeze via the single transition finalizer
 * `adapters/implementation-base-authority.ts#finalizeImplementationEntry`
 * BEFORE any derived artifact is computed.
 *
 * The guard fails closed on:
 *   1. the persistence boundary not invoking the entry guard;
 *   2. the governed persistence path not invoking the finalizer;
 *   3. a duplicate freeze/enforcement authority outside the adapter module
 *      (the rail-side eager freezes were removed for exactly this reason);
 *   4. an implementation-review activation caller not handling the blocked
 *      mint-gate branch (no bindable obligation ⇒ no IMPL_REVIEW persist).
 *
 * Comment lines are skipped. Production scan excludes `*.test.ts`/`__tests__/`.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(process.cwd(), 'src');

/** The single adapter-layer authority for the implementation-entry freeze. */
const FINALIZER_AUTHORITY = 'adapters/implementation-base-authority.ts';
const PERSISTENCE_BOUNDARY = 'adapters/persistence.ts';
const GOVERNED_PERSIST_PATH = 'integration/tools/helpers.ts';

function read(rel: string): string {
  return readFileSync(join(SRC_ROOT, rel), 'utf-8');
}

function sourceFilePaths(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      if (entry.name.endsWith('.test.ts')) continue;
      out.push(relative(SRC_ROOT, full).replace(/\\/g, '/'));
    }
  };
  walk(SRC_ROOT);
  return out;
}

describe('implementation-entry invariant (persistence boundary + single finalizer)', () => {
  it('the persistence boundary invokes the entry guard before writing', () => {
    expect(read(PERSISTENCE_BOUNDARY)).toContain('assertImplementationEntryFrozen(');
  });

  it('the governed persistence path invokes the transition finalizer before derived artifacts', () => {
    const helpers = read(GOVERNED_PERSIST_PATH);
    expect(helpers).toContain('finalizeImplementationEntry(');
    // The finalize step must run BEFORE the ProofGraph refresh so the
    // persisted state, its hashes, and its artifacts include the frozen base.
    expect(helpers.indexOf('finalizeImplementationEntry(')).toBeLessThan(
      helpers.indexOf('refreshProofGraph('),
    );
  });

  it('the freeze authority is defined only in the adapter-layer finalizer module', () => {
    const definitions = sourceFilePaths().filter((rel) => {
      const content = read(rel);
      return (
        content.includes('export async function freezeImplementationBaseAuthority(') ||
        content.includes('export async function ensureImplementationBase(')
      );
    });
    expect(definitions).toEqual([FINALIZER_AUTHORITY]);
  });

  it('no production module outside the authority re-imports the freeze functions (no rail-side duplicate enforcement)', () => {
    const offenders = sourceFilePaths()
      .filter((rel) => rel !== FINALIZER_AUTHORITY)
      .filter((rel) => {
        const content = read(rel);
        return (
          content.includes('freezeImplementationBaseAuthority') ||
          content.includes('ensureImplementationBase')
        );
      });
    expect(offenders).toEqual([]);
  });

  it('every implementation-review activation caller handles the blocked mint-gate branch', () => {
    const callers = [
      'integration/tools/run-check-tool.ts',
      'integration/tools/implement-record.ts',
    ];
    for (const rel of callers) {
      const content = read(rel);
      expect(content).toContain('activateReviewObligationAndPersist(');
      expect(content).toContain("'response' in activation");
      expect(content).toContain('activation.response');
    }
  });
});

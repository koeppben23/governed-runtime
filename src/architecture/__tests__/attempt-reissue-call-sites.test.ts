/**
 * @module architecture/attempt-reissue-call-sites
 * @description Architecture guard: minting a NEW attempt for an existing
 * obligation is a transition authority. `createAttemptForExistingObligation`
 * may only be called from the productive dispatch-recovery site, which routes
 * through `authorizeDispatchRearm`. The origin parameter must not become a
 * public backdoor.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRelative } from '../support/repo-path.js';
import { isTestSourcePath } from '../support/module-classification.js';

const SRC = join(process.cwd(), 'src');

/** Production files that may call `createAttemptForExistingObligation(...)`. */
const ALLOWED_CALLERS = [
  'integration/review/dispatch/durable-dispatch.ts',
  'integration/review/obligations/incoherent-capture-rearm.ts',
];

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

function filesCallingCreateAttempt(): string[] {
  return listSourceFiles(SRC)
    .filter((p) => /\bcreateAttemptForExistingObligation\s*\(/.test(readFileSync(p, 'utf8')))
    .map((p) => repoRelative(SRC, p));
}

describe('createAttemptForExistingObligation call-site whitelist', () => {
  it('is called only from authorized transition sites', () => {
    const callers = filesCallingCreateAttempt();
    const unauthorized = callers.filter(
      (p) =>
        !ALLOWED_CALLERS.includes(p) &&
        p !== 'integration/review/obligations/attempt-lifecycle.ts' && // definition site
        p !== 'integration/review/obligations/assurance.ts', // re-export barrel
    );
    expect(unauthorized).toEqual([]);
  });

  it('the durable re-arm site routes through the canonical dispatch-rearm authority', () => {
    const durableRearm = readFileSync(
      join(SRC, 'integration/review/dispatch/durable-dispatch.ts'),
      'utf8',
    );
    expect(durableRearm).toContain('authorizeDispatchRearm');
    expect(durableRearm).not.toContain('authorizeOutputRepairReissue');
    expect(durableRearm).not.toContain('authorizeTaskLifecycleRearm');
    // Reviewer-Task interception is removed: the afterhook must never mint an
    // attempt or re-arm the retired Task lifecycle.
    const afterhooks = readFileSync(join(SRC, 'integration/plugin-afterhooks.ts'), 'utf8');
    expect(afterhooks).not.toContain('authorizeDispatchRearm');
    expect(afterhooks).not.toContain('createAttemptForExistingObligation');
  });

  it('the F12 incoherent-capture re-arm site routes through its canonical authority', () => {
    const rearm = readFileSync(
      join(SRC, 'integration/review/obligations/incoherent-capture-rearm.ts'),
      'utf8',
    );
    expect(rearm).toContain('authorizeIncoherentCaptureRearm');
    expect(rearm).not.toContain('markDispatchOutcomeUnknown');
  });

  it('writes the consistency-invalid marker only at the vocabulary enum, the lineage reader, and the F12 re-arm', () => {
    const allowed = new Set([
      'state/evidence-review.ts',
      'state/evidence-review-ledger-refinements.ts',
      'integration/review/obligations/incoherent-capture-rearm.ts',
    ]);
    const offenders = listSourceFiles(SRC)
      .filter((path) => !isTestSourcePath(repoRelative(SRC, path)))
      .filter((path) => readFileSync(path, 'utf8').includes("'consistency_invalid'"))
      .map((path) => repoRelative(SRC, path))
      .filter((path) => !allowed.has(path));
    expect(offenders).toEqual([]);
  });

  it('the removed repair and task-rearm authorities have no production reference', () => {
    for (const file of listSourceFiles(SRC)) {
      const content = readFileSync(file, 'utf8');
      const relative = repoRelative(SRC, file);
      expect(content, `${relative} must not reference the removed repair authority`).not.toContain(
        'authorizeOutputRepairReissue',
      );
      expect(
        content,
        `${relative} must not reference the removed task-rearm authority`,
      ).not.toContain('authorizeTaskLifecycleRearm');
      expect(content, `${relative} must not use the removed output_repair origin`).not.toContain(
        "'output_repair'",
      );
      expect(content, `${relative} must not use the removed task_rearm origin`).not.toContain(
        "'task_rearm'",
      );
    }
  });
});

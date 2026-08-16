/**
 * @module architecture/attempt-reissue-call-sites
 * @description Architecture guard: minting a NEW attempt for an existing
 * obligation is a transition authority. `createAttemptForExistingObligation`
 * may only be called from productive sites that route through the matching
 * transition authority (`authorizeOutputRepairReissue` for output repairs,
 * `authorizeTaskLifecycleRearm` for task-lifecycle re-arms). The origin
 * parameter must not become a public backdoor.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');

/** Production files that may call `createAttemptForExistingObligation(...)`. */
const ALLOWED_CALLERS = [
  'integration/plugin-afterhooks.ts',
  'integration/tools/review-tool/obligation-creation.ts',
  'integration/tools/review-tool/continuation.ts',
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
    .map((p) => p.slice(SRC.length + 1));
}

describe('createAttemptForExistingObligation call-site whitelist', () => {
  it('is called only from authorized transition sites', () => {
    const callers = filesCallingCreateAttempt();
    const unauthorized = callers.filter(
      (p) =>
        !ALLOWED_CALLERS.includes(p) &&
        p !== 'integration/review/attempt-lifecycle.ts' && // definition site
        p !== 'integration/review/assurance.ts', // re-export barrel
    );
    expect(unauthorized).toEqual([]);
  });

  it('every allowed caller routes through its matching transition authority', () => {
    const outputRepairSites = [
      'integration/tools/review-tool/obligation-creation.ts',
      'integration/tools/review-tool/continuation.ts',
    ];
    for (const file of outputRepairSites) {
      const content = readFileSync(join(SRC, file), 'utf8');
      expect(content, `${file} must route through authorizeOutputRepairReissue`).toContain(
        'authorizeOutputRepairReissue',
      );
      expect(content, `${file} must not use the task-rearm authority`).not.toContain(
        'authorizeTaskLifecycleRearm',
      );
    }
    const rearm = readFileSync(join(SRC, 'integration/plugin-afterhooks.ts'), 'utf8');
    expect(rearm).toContain('authorizeTaskLifecycleRearm');
    expect(rearm).not.toContain('authorizeOutputRepairReissue');
  });
});

/**
 * @module cli/doctor-command.test
 * @description Contract tests for the doctor() public API.
 *
 * Verifies that doctor() never throws, always returns DoctorCheck[],
 * and correctly classifies missing/error artifacts on empty or partial
 * installations. Full 47-check validation is exercised by smoke tests.
 *
 * @test-policy HAPPY, BAD, CORNER
 */

import { describe, expect, it } from 'vitest';
import { doctor } from './doctor-command.js';
import { repoArgs, globalArgs, setupCliTestEnvironment } from './install-test-helpers.test.js';
import type { DoctorCheck } from './install-types.js';

const VALID_STATUSES = [
  'ok',
  'missing',
  'modified',
  'unmanaged',
  'version_mismatch',
  'instruction_missing',
  'instruction_stale',
  'error',
  'warn',
] as const;

function hasMissingFor(check: string, checks: DoctorCheck[]): boolean {
  return checks.some((c) => c.file?.includes(check) && c.status === 'missing');
}

function hasError(checks: DoctorCheck[]): boolean {
  return checks.some((c) => c.status === 'error');
}

setupCliTestEnvironment();

describe('doctor', () => {
  it('returns array without throwing on empty repo directory', async () => {
    const checks = await doctor(repoArgs({ action: 'doctor', installPlatform: 'opencode' }));
    expect(Array.isArray(checks)).toBe(true);
    expect(checks.length).toBeGreaterThan(0);
  });

  it('reports missing mandates on empty repo directory', async () => {
    const checks = await doctor(repoArgs({ action: 'doctor', installPlatform: 'opencode' }));
    expect(hasMissingFor('mandates', checks)).toBe(true);
  });

  it('reports config error on empty repo directory', async () => {
    const checks = await doctor(repoArgs({ action: 'doctor', installPlatform: 'opencode' }));
    expect(hasError(checks)).toBe(true);
  });

  it('returns checks for global scope without throwing', async () => {
    const checks = await doctor(globalArgs({ action: 'doctor', installPlatform: 'opencode' }));
    expect(Array.isArray(checks)).toBe(true);
    expect(checks.length).toBeGreaterThan(0);
  });

  it('all returned checks have valid status values', async () => {
    const checks = await doctor(repoArgs({ action: 'doctor', installPlatform: 'opencode' }));
    for (const check of checks) {
      expect(VALID_STATUSES).toContain(check.status);
    }
  });
});

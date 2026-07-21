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
import { formatDoctor } from './install.js';
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
  'info',
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

describe('formatDoctor', () => {
  it('reports HEALTHY when all checks pass', () => {
    const result = formatDoctor([{ file: 'x', status: 'ok' }], 'opencode');
    expect(result).toContain('Status: HEALTHY');
    expect(result).toContain('1/1 actionable checks passed');
  });

  it('reports HEALTHY_WITH_WARNINGS with trust/context recovery', () => {
    const result = formatDoctor(
      [
        { file: 'x', status: 'ok' },
        { file: 'y', status: 'warn', detail: 'not verified' },
      ],
      'opencode',
    );
    expect(result).toContain('Status: HEALTHY_WITH_WARNINGS');
    expect(result).toContain('trust/context warning');
    expect(result).toContain('review check details');
  });

  it('reports HEALTHY_WITH_WARNINGS with shipped-executable reinstall recovery', () => {
    const result = formatDoctor(
      [
        { file: 'x', status: 'ok' },
        { file: 'node', status: 'warn', check: 'shipped-executable' as unknown as string },
        { file: 'y', status: 'warn' },
      ],
      'opencode',
    );
    expect(result).toContain('Status: HEALTHY_WITH_WARNINGS');
    expect(result).toContain('shipped-executable warning');
    expect(result).toContain('install --force');
    expect(result).toContain('trust/context warning');
  });

  it('reports NOT_VERIFIED when missing checks exist', () => {
    const result = formatDoctor(
      [
        { file: 'x', status: 'ok' },
        { file: 'y', status: 'missing' },
      ],
      'opencode',
    );
    expect(result).toContain('Status: NOT_VERIFIED');
    expect(result).toContain('install --force');
  });

  it('reports NOT_VERIFIED for empty check list', () => {
    const result = formatDoctor([], 'opencode');
    expect(result).toContain('Status: NOT_VERIFIED');
    expect(result).toContain('0/0 actionable checks passed');
  });

  it('names the selected host platform in recovery', () => {
    const result = formatDoctor(
      [{ file: 'x', status: 'warn', detail: 'not verified' }],
      'claude-code',
    );
    expect(result).toContain('Claude Code');
  });
});

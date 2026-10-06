/**
 * @module cli/install-outcome.test
 * @description Pure outcome classification tests (C1/E6).
 *
 * @test-policy HAPPY, BAD, CORNER
 */

import { describe, expect, it } from 'vitest';
import { classifyInstallOutcome } from './install-outcome.js';
import type { CliResult } from './install-types.js';

function result(ops: CliResult['ops'], errors: string[] = []): Pick<CliResult, 'errors' | 'ops'> {
  return { errors, ops };
}

describe('classifyInstallOutcome', () => {
  it('is failed when any error was recorded, even with written ops', () => {
    expect(
      classifyInstallOutcome(
        result([{ path: '/a', action: 'written' }], ['NON_OPENCODE_CONFIG_EXISTS']),
      ),
    ).toBe('failed');
  });

  it('is applied when at least one artifact was written', () => {
    expect(classifyInstallOutcome(result([{ path: '/a', action: 'written' }]))).toBe('applied');
  });

  it('is applied when at least one artifact was merged', () => {
    expect(classifyInstallOutcome(result([{ path: '/a', action: 'merged' }]))).toBe('applied');
  });

  it('is applied for a mix of written and skipped operations', () => {
    expect(
      classifyInstallOutcome(
        result([
          { path: '/a', action: 'written' },
          { path: '/b', action: 'skipped', reason: 'already exists' },
        ]),
      ),
    ).toBe('applied');
  });

  it('is skipped for an idempotent no-op', () => {
    expect(
      classifyInstallOutcome(result([{ path: '/a', action: 'skipped', reason: 'already exists' }])),
    ).toBe('skipped');
  });

  it('is skipped when nothing was recorded at all', () => {
    expect(classifyInstallOutcome(result([]))).toBe('skipped');
  });
});

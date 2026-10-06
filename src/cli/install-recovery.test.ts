/**
 * @module cli/install-recovery.test
 * @description Typed error propagation and recovery hints (C1/E5): both
 * installer error classes must keep their code end-to-end.
 *
 * @test-policy HAPPY, BAD, CORNER
 */

import { describe, expect, it } from 'vitest';
import { CliInstallError } from './errors.js';
import { InstallError, formatRecoveryLines, pushError, toCliError } from './install-recovery.js';
import type { CliError } from './install-types.js';

describe('toCliError', () => {
  it('preserves an InstallError code', () => {
    expect(toCliError(new InstallError('ALREADY_INSTALLED', 'already'))).toEqual({
      code: 'ALREADY_INSTALLED',
      message: 'already',
    });
  });

  it('preserves a CliInstallError code', () => {
    expect(toCliError(new CliInstallError('NON_OPENCODE_CONFIG_EXISTS', 'exists'))).toEqual({
      code: 'NON_OPENCODE_CONFIG_EXISTS',
      message: 'exists',
    });
  });

  it('leaves uncoded errors uncoded', () => {
    expect(toCliError(new Error('boom'))).toEqual({ message: 'boom' });
  });
});

describe('pushError', () => {
  it('preserves a CliInstallError code', () => {
    const errors: string[] = [];
    const details: CliError[] = [];
    pushError(errors, details, new CliInstallError('TRANSACTION_PHASE_INVALID', 'phase'));

    expect(errors).toEqual(['phase']);
    expect(details).toEqual([{ code: 'TRANSACTION_PHASE_INVALID', message: 'phase' }]);
  });

  it('attaches recovery context without changing the code', () => {
    const errors: string[] = [];
    const details: CliError[] = [];
    pushError(errors, details, new InstallError('INSTALL_LOCK_CONFLICT', 'locked'), {
      path: '/tmp/lock',
    });

    expect(details[0]?.code).toBe('INSTALL_LOCK_CONFLICT');
    expect(details[0]).toMatchObject({ recoveryContext: { path: '/tmp/lock' } });
  });
});

describe('formatRecoveryLines', () => {
  it('emits a code-specific recovery line for new C1 codes', () => {
    const lines = formatRecoveryLines([{ code: 'NON_OPENCODE_CONFIG_EXISTS', message: 'exists' }]);
    expect(lines.join('\n')).toContain('--force');
    expect(lines.some((line) => line.includes('doctor'))).toBe(false);
  });

  it('emits a code-specific recovery line for partial installs', () => {
    const lines = formatRecoveryLines([{ code: 'PARTIAL_INSTALL_CONFLICT', message: 'partial' }]);
    expect(lines.join('\n')).toContain('--force');
  });

  it('falls back to the generic plan for a coded error without a map entry', () => {
    const lines = formatRecoveryLines([{ code: 'TRANSACTION_PHASE_INVALID', message: 'phase' }]);
    expect(lines.join('\n')).toContain('flowguard doctor');
  });
});

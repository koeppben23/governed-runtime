/**
 * @module discovery/package-script-command.test
 * @description Tests for package-manager-specific script command building.
 */

import { describe, expect, it } from 'vitest';
import { buildScriptInvocation, isSupportedPackageManager } from './package-script-command.js';

describe('buildScriptInvocation', () => {
  it('npm: npm run test --', () => {
    const inv = buildScriptInvocation('npm', 'test');
    expect(inv.command).toBe('npm run test --');
    expect(inv.forwardsArguments).toBe(true);
  });

  it('pnpm: pnpm test (auto-forwards)', () => {
    const inv = buildScriptInvocation('pnpm', 'test');
    expect(inv.command).toBe('pnpm test');
    expect(inv.forwardsArguments).toBe(true);
  });

  it('yarn: yarn test (auto-forwards)', () => {
    const inv = buildScriptInvocation('yarn', 'test');
    expect(inv.command).toBe('yarn test');
    expect(inv.forwardsArguments).toBe(true);
  });

  it('bun: bun run test --', () => {
    const inv = buildScriptInvocation('bun', 'test');
    expect(inv.command).toBe('bun run test --');
    expect(inv.forwardsArguments).toBe(true);
  });

  it('all PMs support forwarding', () => {
    for (const pm of ['npm' as const, 'pnpm' as const, 'yarn' as const, 'bun' as const]) {
      const inv = buildScriptInvocation(pm, 'lint');
      expect(inv.forwardsArguments).toBe(true);
    }
  });
});

describe('isSupportedPackageManager', () => {
  it('accepts the 4 known PMs', () => {
    expect(isSupportedPackageManager('npm')).toBe(true);
    expect(isSupportedPackageManager('pnpm')).toBe(true);
    expect(isSupportedPackageManager('yarn')).toBe(true);
    expect(isSupportedPackageManager('bun')).toBe(true);
  });

  it('rejects unknown', () => {
    expect(isSupportedPackageManager('gradle')).toBe(false);
    expect(isSupportedPackageManager('maven')).toBe(false);
    expect(isSupportedPackageManager('')).toBe(false);
  });
});

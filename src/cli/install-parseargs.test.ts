/**
 * @module cli/install-parseargs.test
 * @description Tests for parseArgs and resolveTarget CLI functions.
 * @test-policy HAPPY, BAD, CORNER, EDGE, PERF — all five categories present.
 */

import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs, resolveTarget } from './install.js';
import { setupCliTestEnvironment } from './install-test-helpers.test.js';

setupCliTestEnvironment();

// ─── parseArgs ────────────────────────────────────────────────────────────────

describe('cli/parseArgs', () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    it("parses 'install' with defaults", () => {
      const result = parseArgs(['install']);
      expect(result).not.toBeNull();
      expect(result!.args).toEqual({
        action: 'install',
        installScope: 'global',
        policyMode: 'solo',
        force: false,
        coreTarball: undefined,
        vendorDir: undefined,
      });
      expect(result!.deprecations).toEqual([]);
    });

    it("parses 'install --install-scope repo'", () => {
      const result = parseArgs(['install', '--install-scope', 'repo']);
      expect(result).not.toBeNull();
      expect(result!.args.installScope).toBe('repo');
      expect(result!.deprecations).toEqual([]);
    });

    it("parses 'install --policy-mode team'", () => {
      const result = parseArgs(['install', '--policy-mode', 'team']);
      expect(result).not.toBeNull();
      expect(result!.args.policyMode).toBe('team');
    });

    it("parses 'install --policy-mode regulated --force'", () => {
      const result = parseArgs(['install', '--policy-mode', 'regulated', '--force']);
      expect(result).not.toBeNull();
      expect(result!.args.policyMode).toBe('regulated');
      expect(result!.args.force).toBe(true);
    });

    it("parses 'install --policy-mode team-ci'", () => {
      const result = parseArgs(['install', '--policy-mode', 'team-ci']);
      expect(result).not.toBeNull();
      expect(result!.args.policyMode).toBe('team-ci');
    });

    it("parses 'install --core-tarball <path>'", () => {
      const result = parseArgs([
        'install',
        '--core-tarball',
        '/path/to/flowguard-core-${VERSION}.tgz',
      ]);
      expect(result).not.toBeNull();
      expect(result!.args.coreTarball).toBe('/path/to/flowguard-core-${VERSION}.tgz');
    });

    it("parses 'install --core-tarball with all options'", () => {
      const result = parseArgs([
        'install',
        '--core-tarball',
        './flowguard-core-${VERSION}.tgz',
        '--install-scope',
        'repo',
        '--policy-mode',
        'regulated',
        '--force',
      ]);
      expect(result).not.toBeNull();
      expect(result!.args.coreTarball).toBe('./flowguard-core-${VERSION}.tgz');
      expect(result!.args.installScope).toBe('repo');
      expect(result!.args.policyMode).toBe('regulated');
      expect(result!.args.force).toBe(true);
    });

    it("parses 'uninstall --install-scope global'", () => {
      const result = parseArgs(['uninstall', '--install-scope', 'global']);
      expect(result).not.toBeNull();
      expect(result!.args.action).toBe('uninstall');
      expect(result!.args.installScope).toBe('global');
    });

    it("parses 'doctor'", () => {
      const result = parseArgs(['doctor']);
      expect(result).not.toBeNull();
      expect(result!.args.action).toBe('doctor');
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe('BAD', () => {
    it('returns null for unknown action', () => {
      expect(parseArgs(['deploy'])).toBeNull();
    });

    it('returns null for --policy-mode without value', () => {
      expect(parseArgs(['install', '--policy-mode'])).toBeNull();
    });

    it('returns null for --policy-mode with invalid value', () => {
      expect(parseArgs(['install', '--policy-mode', 'enterprise'])).toBeNull();
    });

    it('returns null for --install-scope without value', () => {
      expect(parseArgs(['install', '--install-scope'])).toBeNull();
    });

    it('returns null for --install-scope with invalid value', () => {
      expect(parseArgs(['install', '--install-scope', 'cloud'])).toBeNull();
    });

    it('returns null for unknown flag', () => {
      expect(parseArgs(['install', '--verbose'])).toBeNull();
    });

    it('returns null for --mode without value (deprecated alias)', () => {
      expect(parseArgs(['install', '--mode'])).toBeNull();
    });

    it('returns null for --mode with invalid value (deprecated alias)', () => {
      expect(parseArgs(['install', '--mode', 'enterprise'])).toBeNull();
    });

    it('returns null for --core-tarball without value', () => {
      expect(parseArgs(['install', '--core-tarball'])).toBeNull();
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    it('deprecated --global sets installScope to global with deprecation warning', () => {
      const result = parseArgs(['install', '--global']);
      expect(result).not.toBeNull();
      expect(result!.args.installScope).toBe('global');
      expect(result!.deprecations).toContain('--global is deprecated, use --install-scope global');
    });

    it('deprecated --project sets installScope to repo with deprecation warning', () => {
      const result = parseArgs(['install', '--project']);
      expect(result).not.toBeNull();
      expect(result!.args.installScope).toBe('repo');
      expect(result!.deprecations).toContain('--project is deprecated, use --install-scope repo');
    });

    it('deprecated --mode sets policyMode with deprecation warning', () => {
      const result = parseArgs(['install', '--mode', 'team']);
      expect(result).not.toBeNull();
      expect(result!.args.policyMode).toBe('team');
      expect(result!.deprecations).toContain('--mode is deprecated, use --policy-mode');
    });

    it('--project then --global: last one wins (both deprecated)', () => {
      const result = parseArgs(['install', '--project', '--global']);
      expect(result).not.toBeNull();
      expect(result!.args.installScope).toBe('global');
      expect(result!.deprecations.length).toBe(2);
    });

    it('--global then --project: last one wins (both deprecated)', () => {
      const result = parseArgs(['install', '--global', '--project']);
      expect(result).not.toBeNull();
      expect(result!.args.installScope).toBe('repo');
    });

    it('all four policy modes are accepted via --policy-mode', () => {
      for (const mode of ['solo', 'team', 'team-ci', 'regulated'] as const) {
        const result = parseArgs(['install', '--policy-mode', mode]);
        expect(result).not.toBeNull();
        expect(result!.args.policyMode).toBe(mode);
      }
    });

    it('both install scopes are accepted via --install-scope', () => {
      for (const scope of ['global', 'repo'] as const) {
        const result = parseArgs(['install', '--install-scope', scope]);
        expect(result).not.toBeNull();
        expect(result!.args.installScope).toBe(scope);
      }
    });
  });

  // ─── EDGE ─────────────────────────────────────────────────
  describe('EDGE', () => {
    it('all three actions are accepted', () => {
      for (const action of ['install', 'uninstall', 'doctor'] as const) {
        const result = parseArgs([action]);
        expect(result).not.toBeNull();
        expect(result!.args.action).toBe(action);
      }
    });

    it('--force without --policy-mode still defaults to solo', () => {
      const result = parseArgs(['install', '--force']);
      expect(result).not.toBeNull();
      expect(result!.args.policyMode).toBe('solo');
      expect(result!.args.force).toBe(true);
    });

    it('mixing new and deprecated flags works', () => {
      const result = parseArgs([
        'install',
        '--install-scope',
        'repo',
        '--mode',
        'regulated',
        '--force',
      ]);
      expect(result).not.toBeNull();
      expect(result!.args.installScope).toBe('repo');
      expect(result!.args.policyMode).toBe('regulated');
      expect(result!.args.force).toBe(true);
      expect(result!.deprecations).toContain('--mode is deprecated, use --policy-mode');
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe('PERF', () => {
    it('parseArgs is sub-millisecond for complex flags', () => {
      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        parseArgs(['install', '--install-scope', 'repo', '--policy-mode', 'regulated', '--force']);
      }
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(50);
    });
  });
});

// ─── resolveTarget ────────────────────────────────────────────────────────────

describe('cli/resolveTarget', () => {
  describe('HAPPY', () => {
    it('global resolves to OPENCODE_CONFIG_DIR when set', () => {
      // setupCliTestEnvironment sets OPENCODE_CONFIG_DIR to tmpDir
      const target = resolveTarget('global');
      expect(target).toBe(process.env.OPENCODE_CONFIG_DIR);
      expect(path.isAbsolute(target)).toBe(true);
    });

    it('repo resolves to .opencode in cwd', () => {
      const target = resolveTarget('repo');
      expect(target).toContain('.opencode');
      expect(path.isAbsolute(target)).toBe(true);
    });
  });

  describe('BAD', () => {
    it('global target starts with homedir when no env override', () => {
      const original = process.env.OPENCODE_CONFIG_DIR;
      try {
        delete process.env.OPENCODE_CONFIG_DIR;
        const target = resolveTarget('global');
        expect(target.startsWith(os.homedir())).toBe(true);
      } finally {
        if (original !== undefined) {
          process.env.OPENCODE_CONFIG_DIR = original;
        }
      }
    });
  });

  describe('CORNER', () => {
    it('repo target uses the current working directory', () => {
      const target = resolveTarget('repo');
      expect(target).toBe(path.resolve('.opencode'));
    });
  });

  describe('EDGE', () => {
    it('both scopes return absolute paths', () => {
      for (const scope of ['global', 'repo'] as const) {
        expect(path.isAbsolute(resolveTarget(scope))).toBe(true);
      }
    });

    it('global respects OPENCODE_CONFIG_DIR env var', () => {
      const original = process.env.OPENCODE_CONFIG_DIR;
      try {
        process.env.OPENCODE_CONFIG_DIR = '/custom/config/path';
        const target = resolveTarget('global');
        expect(target).toBe('/custom/config/path');
      } finally {
        if (original === undefined) {
          delete process.env.OPENCODE_CONFIG_DIR;
        } else {
          process.env.OPENCODE_CONFIG_DIR = original;
        }
      }
    });

    it('global falls back to homedir when OPENCODE_CONFIG_DIR is unset', () => {
      const original = process.env.OPENCODE_CONFIG_DIR;
      try {
        delete process.env.OPENCODE_CONFIG_DIR;
        const target = resolveTarget('global');
        expect(target.startsWith(os.homedir())).toBe(true);
        expect(target).toContain(path.join('.config', 'opencode'));
      } finally {
        if (original !== undefined) {
          process.env.OPENCODE_CONFIG_DIR = original;
        }
      }
    });

    it('repo scope is unaffected by OPENCODE_CONFIG_DIR', () => {
      const original = process.env.OPENCODE_CONFIG_DIR;
      try {
        process.env.OPENCODE_CONFIG_DIR = '/custom/config/path';
        const target = resolveTarget('repo');
        expect(target).toBe(path.resolve('.opencode'));
      } finally {
        if (original === undefined) {
          delete process.env.OPENCODE_CONFIG_DIR;
        } else {
          process.env.OPENCODE_CONFIG_DIR = original;
        }
      }
    });
  });

  describe('PERF', () => {
    it('resolveTarget is sub-millisecond', () => {
      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        resolveTarget('global');
        resolveTarget('repo');
      }
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(50);
    });
  });
});

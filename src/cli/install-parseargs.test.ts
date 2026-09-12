/**
 * @module cli/install-parseargs.test
 * @description Tests for parseArgs and resolveTarget CLI functions.
 * @test-policy HAPPY, BAD, CORNER, EDGE, PERF — all five categories present.
 */

import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs } from './install.js';
import { resolveTarget, formatTargetPath } from './install-helpers.js';
import type { CliArgs } from './install-types.js';
import { setupCliTestEnvironment } from './install-test-helpers.test.js';
import { withTestEnv } from '../integration/test-helpers.js';

setupCliTestEnvironment();

// ─── parseArgs ────────────────────────────────────────────────────────────────

describe('cli/parseArgs', () => {
  function okResult(result: ReturnType<typeof parseArgs>): CliArgs {
    expect(result.kind).toBe('ok');
    return (result as { kind: 'ok'; value: CliArgs }).value;
  }

  function errorResult(result: ReturnType<typeof parseArgs>) {
    expect(result.kind).not.toBe('ok');
  }

  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    it("parses 'install' with defaults", () => {
      const args = okResult(parseArgs(['install']));
      expect(args).toEqual({
        action: 'install',
        installScope: 'global',
        scopeSource: 'default',
        installPlatform: 'opencode',
        policyMode: 'team',
        force: false,
        coreTarball: undefined,
        checksumsFile: undefined,
        allowUnverifiedTarball: false,
        logMode: undefined,
      });
    });

    it("parses 'install --install-scope repo'", () => {
      expect(okResult(parseArgs(['install', '--install-scope', 'repo'])).installScope).toBe('repo');
    });

    it("parses 'install --policy-mode team'", () => {
      expect(okResult(parseArgs(['install', '--policy-mode', 'team'])).policyMode).toBe('team');
    });

    it("parses 'install --platform claude-code'", () => {
      expect(okResult(parseArgs(['install', '--platform', 'claude-code'])).installPlatform).toBe(
        'claude-code',
      );
    });

    it("parses 'install --host claude-code' as the supported platform alias", () => {
      expect(okResult(parseArgs(['install', '--host', 'claude-code'])).installPlatform).toBe(
        'claude-code',
      );
    });

    it("parses 'install --policy-mode regulated --force'", () => {
      const args = okResult(parseArgs(['install', '--policy-mode', 'regulated', '--force']));
      expect(args.policyMode).toBe('regulated');
      expect(args.force).toBe(true);
    });

    it("parses 'install --policy-mode team-ci'", () => {
      expect(okResult(parseArgs(['install', '--policy-mode', 'team-ci'])).policyMode).toBe('team-ci');
    });

    it("parses 'install --core-tarball <path>'", () => {
      const args = okResult(
        parseArgs(['install', '--core-tarball', '/path/to/flowguard-core-${VERSION}.tgz']),
      );
      expect(args.coreTarball).toBe('/path/to/flowguard-core-${VERSION}.tgz');
    });

    it("parses 'install --core-tarball with all options'", () => {
      const args = okResult(
        parseArgs([
          'install',
          '--core-tarball',
          './flowguard-core-${VERSION}.tgz',
          '--install-scope',
          'repo',
          '--policy-mode',
          'regulated',
          '--force',
        ]),
      );
      expect(args.coreTarball).toBe('./flowguard-core-${VERSION}.tgz');
      expect(args.installScope).toBe('repo');
      expect(args.policyMode).toBe('regulated');
      expect(args.force).toBe(true);
    });

    it('parses --checksums-file', () => {
      const args = okResult(
        parseArgs([
          'install',
          '--core-tarball',
          './flowguard-core-1.0.0.tgz',
          '--checksums-file',
          './checksums.sha256',
        ]),
      );
      expect(args.checksumsFile).toBe('./checksums.sha256');
    });

    it('parses --allow-unverified-tarball', () => {
      const args = okResult(
        parseArgs([
          'install',
          '--core-tarball',
          './flowguard-core-1.0.0.tgz',
          '--allow-unverified-tarball',
        ]),
      );
      expect(args.allowUnverifiedTarball).toBe(true);
    });

    it('rejects --checksums-file without value', () => {
      errorResult(parseArgs(['install', '--core-tarball', './x.tgz', '--checksums-file']));
    });

    it('rejects ambiguous checksum verification and opt-out flags', () => {
      errorResult(
        parseArgs([
          'install',
          '--core-tarball',
          './flowguard-core-1.0.0.tgz',
          '--checksums-file',
          './checksums.sha256',
          '--allow-unverified-tarball',
        ]),
      );
    });

    it("parses 'uninstall --install-scope global'", () => {
      const args = okResult(parseArgs(['uninstall', '--install-scope', 'global']));
      expect(args.action).toBe('uninstall');
      expect(args.installScope).toBe('global');
    });

    it("parses 'doctor'", () => {
      expect(okResult(parseArgs(['doctor'])).action).toBe('doctor');
    });

    it("delegates 'run' arguments without install-parser rejection", () => {
      expect(okResult(parseArgs(['run', '--host', 'claude-code', '--', 'Run /validate'])).action).toBe(
        'run',
      );
    });

    it("delegates 'serve' arguments without install-parser rejection", () => {
      expect(okResult(parseArgs(['serve', '--host', 'opencode', '--port', '4096'])).action).toBe(
        'serve',
      );
    });

    it("delegates 'inspect' arguments without install-parser rejection", () => {
      expect(okResult(parseArgs(['inspect', '--session', 'some-id', '--json'])).action).toBe(
        'inspect',
      );
    });

    it('returns help for --help flag', () => {
      expect(parseArgs(['install', '--help']).kind).toBe('help');
    });

    it('returns help for -h flag', () => {
      expect(parseArgs(['install', '-h']).kind).toBe('help');
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe('BAD', () => {
    it('returns error for unknown action', () => {
      const result = parseArgs(['deploy']);
      expect(result.kind).toBe('error');
      if (result.kind === 'error') expect(result.error).toContain('Unknown');
    });

    it('returns error for --policy-mode without value', () => {
      errorResult(parseArgs(['install', '--policy-mode']));
    });

    it('returns error for --policy-mode with invalid value', () => {
      errorResult(parseArgs(['install', '--policy-mode', 'enterprise']));
    });

    it('returns error for --install-scope without value', () => {
      errorResult(parseArgs(['install', '--install-scope']));
    });

    it('returns error for --install-scope with invalid value', () => {
      errorResult(parseArgs(['install', '--install-scope', 'cloud']));
    });

    it('returns error for --platform with invalid value', () => {
      errorResult(parseArgs(['install', '--platform', 'unknown-host']));
    });

    it('returns error for --host with invalid value', () => {
      errorResult(parseArgs(['install', '--host', 'unknown-host']));
    });

    it('returns error for unknown flag', () => {
      errorResult(parseArgs(['install', '--verbose']));
    });

    it.each([
      ['--mode', 'team'],
      ['--global'],
      ['--project'],
    ])('rejects removed install option %s', (...args) => {
      const result = parseArgs(['install', ...args]);
      expect(result.kind).toBe('error');
      if (result.kind === 'error') expect(result.error).toContain(`Unknown option: ${args[0]}`);
    });

    it('returns error for --core-tarball without value', () => {
      errorResult(parseArgs(['install', '--core-tarball']));
    });

    it('returns error for no command', () => {
      expect(parseArgs([]).kind).toBe('error');
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    it('all four policy modes are accepted via --policy-mode', () => {
      for (const mode of ['solo', 'team', 'team-ci', 'regulated'] as const) {
        expect(okResult(parseArgs(['install', '--policy-mode', mode])).policyMode).toBe(mode);
      }
    });

    it('both install scopes are accepted via --install-scope', () => {
      for (const scope of ['global', 'repo'] as const) {
        expect(okResult(parseArgs(['install', '--install-scope', scope])).installScope).toBe(scope);
      }
    });
  });

  // ─── EDGE ─────────────────────────────────────────────────
  describe('EDGE', () => {
    it('all three install actions are accepted', () => {
      for (const action of ['install', 'uninstall', 'doctor'] as const) {
        expect(okResult(parseArgs([action])).action).toBe(action);
      }
    });

    it('--force without --policy-mode defaults to team (human-gated)', () => {
      const args = okResult(parseArgs(['install', '--force']));
      expect(args.policyMode).toBe('team');
      expect(args.force).toBe(true);
    });

    it('canonical scope, policy and force flags compose deterministically', () => {
      const args = okResult(
        parseArgs([
          'install',
          '--install-scope',
          'repo',
          '--policy-mode',
          'regulated',
          '--force',
        ]),
      );
      expect(args.installScope).toBe('repo');
      expect(args.policyMode).toBe('regulated');
      expect(args.force).toBe(true);
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
      const target = resolveTarget('global');
      expect(target).toBe(process.env.OPENCODE_CONFIG_DIR);
      expect(path.isAbsolute(target)).toBe(true);
    });

    it('repo resolves to .opencode in cwd', () => {
      const target = resolveTarget('repo');
      expect(target).toContain('.opencode');
      expect(path.isAbsolute(target)).toBe(true);
    });

    it('repo resolves platform-specific roots for Claude and Codex', () => {
      expect(resolveTarget('repo', 'claude-code')).toBe(path.resolve('.claude'));
      expect(resolveTarget('repo', 'codex')).toBe(path.resolve('plugins', 'flowguard'));
    });
  });

  describe('BAD', () => {
    it('global target starts with homedir when no env override', () => {
      const restoreEnv = withTestEnv({ OPENCODE_CONFIG_DIR: undefined });
      try {
        const target = resolveTarget('global');
        expect(target.startsWith(os.homedir())).toBe(true);
      } finally {
        restoreEnv();
      }
    });
  });

  describe('CORNER', () => {
    it('repo target uses the current working directory', () => {
      expect(resolveTarget('repo')).toBe(path.resolve('.opencode'));
    });
  });

  describe('EDGE', () => {
    it('both scopes return absolute paths', () => {
      for (const scope of ['global', 'repo'] as const) {
        expect(path.isAbsolute(resolveTarget(scope))).toBe(true);
      }
    });

    it('global respects OPENCODE_CONFIG_DIR env var', () => {
      const restoreEnv = withTestEnv({ OPENCODE_CONFIG_DIR: '/custom/config/path' });
      try {
        expect(resolveTarget('global')).toBe('/custom/config/path');
      } finally {
        restoreEnv();
      }
    });

    it('global falls back to homedir when OPENCODE_CONFIG_DIR is unset', () => {
      const restoreEnv = withTestEnv({ OPENCODE_CONFIG_DIR: undefined });
      try {
        const target = resolveTarget('global');
        expect(target.startsWith(os.homedir())).toBe(true);
        expect(target).toContain(path.join('.config', 'opencode'));
      } finally {
        restoreEnv();
      }
    });

    it('repo scope is unaffected by OPENCODE_CONFIG_DIR', () => {
      const restoreEnv = withTestEnv({ OPENCODE_CONFIG_DIR: '/custom/config/path' });
      try {
        expect(resolveTarget('repo')).toBe(path.resolve('.opencode'));
      } finally {
        restoreEnv();
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

// ─── formatTargetPath ─────────────────────────────────────────────────────────

describe('formatTargetPath', () => {
  it('formats global scope with homedir replacement', () => {
    const target = os.homedir() + '/.config/opencode';
    const result = formatTargetPath(target, 'global', process.cwd());
    expect(result).toBe('~/.config/opencode');
    expect(result.startsWith('~')).toBe(true);
  });

  it('formats repo scope as relative to cwd', () => {
    const cwd = process.cwd();
    expect(formatTargetPath(cwd + '/.opencode', 'repo', cwd)).toBe('./.opencode');
  });

  it('handles cwd itself as repo target', () => {
    expect(formatTargetPath(process.cwd(), 'repo', process.cwd())).toBe('./');
  });
});

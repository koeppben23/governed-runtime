/** Shell routing/fail-closed tests; the packed smoke test owns real V2 install proof. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const LIB = resolve('demos/java-task-manager/install-flowguard-lib.sh');
let root: string;

describe.skipIf(process.platform === 'win32')('Java demo V2 verification routing', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fg-demo-verify-'));
    mkdirSync(join(root, 'bin'));
    writeFileSync(
      join(root, 'bin/npx'),
      '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$NPX_ARGS"\nexit "${FAKE_DOCTOR_STATUS:-0}"\n',
      { mode: 0o755 },
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function verify(scope: string, status = 0) {
    return spawnSync(
      'bash',
      [
        '-c',
        'set -e; source "$1"; flowguard_verify_install "$2" "$3"; echo VERIFIED',
        'bash',
        LIB,
        join(root, 'current package.tgz'),
        scope,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`,
          HOME: root,
          OPENCODE_CONFIG_DIR: join(root, 'global'),
          NPX_ARGS: join(root, 'npx.args'),
          FAKE_DOCTOR_STATUS: String(status),
        },
        timeout: 10_000,
      },
    );
  }

  function reviewer(scope: 'repo' | 'global', content = '---\n') {
    const target = join(root, scope === 'repo' ? '.opencode' : 'global', 'agents');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'flowguard-reviewer.md'), content);
  }

  it.each(['repo', 'global'] as const)(
    'delegates %s verification to the same tarball doctor without requiring V1 files',
    (scope) => {
      reviewer(scope);
      const result = verify(scope);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('VERIFIED');
      expect(readFileSync(join(root, 'npx.args'), 'utf8').trim().split('\n')).toEqual([
        '--package',
        join(root, 'current package.tgz'),
        'flowguard',
        'doctor',
        '--install-scope',
        scope,
      ]);
      expect(existsSync(join(root, 'opencode.json'))).toBe(false);
      expect(existsSync(join(root, '.opencode/tools/flowguard.ts'))).toBe(false);
    },
  );

  it.each(['repo', 'global'] as const)(
    'blocks %s when the canonical doctor reports a broken install',
    (scope) => {
      reviewer(scope);
      const result = verify(scope, 17);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Do not start the demo');
      expect(result.stdout).not.toContain('VERIFIED');
    },
  );

  it.each(['repo', 'global'] as const)(
    'requires the %s reviewer even when doctor only warns',
    (scope) => {
      const missing = verify(scope);
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain('MISSING:');
      reviewer(scope, '');
      expect(verify(scope).status).toBe(1);
    },
  );

  it('rejects unknown scope instead of silently inspecting repo files', () => {
    expect(verify('bogus').status).toBe(1);
    expect(existsSync(join(root, 'npx.args'))).toBe(false);
  });
});

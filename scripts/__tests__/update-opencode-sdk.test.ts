import { describe, expect, it } from 'vitest';
import { validateTarget } from '../update-opencode-sdk.mjs';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('native API updater target validation', () => {
  it.each(['2.2.4', '2.3.0', '2.3.0-beta.1'])('accepts one exact V2 target: %s', (version) => {
    expect(validateTarget(version)).toBe(version);
  });
  it.each(['1.19.5', '^2.2.4', '~2.2.4', 'latest', '', 'unknown', '2.2', '2.2.4\n1.19.5'])(
    'rejects removed, ambiguous or unresolved target %j',
    (version) => {
      expect(() => validateTarget(version)).toThrow('Expected one exact OpenCode V2 version');
    },
  );

  it('rejects the removed host argument before install or changing host provenance', () => {
    const files = [
      'package.json',
      'package-lock.json',
      '.sdk-baselines/opencode/host-version.json',
      '.sdk-baselines/opencode/docs-hashes.json',
      'src/cli/opencode-runtime-compat.ts',
    ];
    const before = files.map((file) => readFileSync(file));
    const result = spawnSync(
      process.execPath,
      ['scripts/update-opencode-sdk.mjs', '2.2.4', '1.19.5'],
      { cwd: resolve(import.meta.dirname, '../..'), encoding: 'utf8' },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Host targets are not accepted');
    expect(files.map((file) => readFileSync(file))).toEqual(before);
  });

  it('does not dispatch the API update workflow as host drift recovery', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/check-opencode-host-drift.mjs', '--trigger'],
      { cwd: resolve(import.meta.dirname, '../..'), encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'BLOCKED: native API updates cannot certify installed host versions',
    );
  });
});

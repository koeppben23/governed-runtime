import { describe, expect, it } from 'vitest';
import { validateTarget } from '../update-opencode-sdk.mjs';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { validatePrDocumentation } from '../check-pr-documentation.mjs';

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

describe('native API updater workflow changelog step', () => {
  const root = resolve(import.meta.dirname, '../..');
  const workflow = parse(
    readFileSync(join(root, '.github/workflows/opencode-sdk-update.yml'), 'utf8'),
  ) as {
    jobs: { update: { steps: Array<{ name: string; run?: string }> } };
  };
  const command = workflow.jobs.update.steps.find(
    (step) => step.name === 'Record completed API update in changelog',
  )?.run;

  it.each([
    {
      valid: true,
      changelog: '# Changelog\n\n## [Unreleased]\n\n### Changed\n\n- Existing change.\n',
    },
    {
      valid: false,
      changelog:
        '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Existing change.\n\n## [1.0.0]\n\n### Changed\n\n- Historical change.\n',
    },
  ])(
    'executes the actual quoted JavaScript heredoc without shell expansion (valid=$valid)',
    ({ valid, changelog }) => {
      expect(command).toMatch(/^node --input-type=module <<'NODE'\n[\s\S]*\nNODE\n?$/);
      const directory = mkdtempSync(join(tmpdir(), 'flowguard-sdk-workflow-'));
      try {
        mkdirSync(join(directory, 'scripts'));
        copyFileSync(
          join(root, 'scripts/sdk-type-snapshot.mjs'),
          join(directory, 'scripts/sdk-type-snapshot.mjs'),
        );
        const file = join(directory, 'CHANGELOG.md');
        writeFileSync(file, changelog);
        const result = spawnSync('bash', ['-c', command!], {
          cwd: directory,
          encoding: 'utf8',
          env: { ...process.env, TARGET: '2.2.5' },
        });
        expect(result.error).toBeUndefined();
        const after = readFileSync(file, 'utf8');
        if (valid) {
          expect(result.status, result.stderr).toBe(0);
          expect(after).toContain('native OpenCode API packages and type baselines to 2.2.5');
          expect(after).not.toContain('${process.env.TARGET}');
          expect(validatePrDocumentation(changelog, after).ok).toBe(true);
        } else {
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain('Missing Unreleased Changed heading');
          expect(result.stderr).toContain('SDK_CONTRACT_INVALID');
          expect(after).toBe(changelog);
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});

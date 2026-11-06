/** The CI worker budget must not reduce test scope or swallow failing checks. */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('coverage runner', () => {
  it.each([false, true])('keeps both projects and the coverage gate, CI=%s', (ci) => {
    const root = mkdtempSync(join(tmpdir(), 'fg-coverage-runner-'));
    try {
      const script = join(root, 'npx.cjs');
      writeFileSync(
        script,
        `console.log(JSON.stringify({args:process.argv.slice(2),perf:process.env.FLOWGUARD_PERF}));process.exit(Number(process.env.PROBE_EXIT ?? 0));`,
      );
      const command = join(root, process.platform === 'win32' ? 'npx.cmd' : 'npx');
      writeFileSync(
        command,
        process.platform === 'win32'
          ? `@"${process.execPath}" "${script}" %*\r\n`
          : `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(script).href)});\n`,
      );
      chmodSync(command, 0o755);
      const result = spawnSync(
        process.execPath,
        [resolve('scripts/coverage.mjs'), ...(ci ? ['--ci'] : [])],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${root}${delimiter}${process.env.PATH}`,
            FLOWGUARD_PERF: '1',
            PROBE_EXIT: '37',
          },
        },
      );
      expect(result.status, result.stderr).toBe(37);
      const observed = JSON.parse(result.stdout.trim());
      expect(observed).toEqual({
        args: [
          'vitest',
          'run',
          '--project',
          'unit',
          '--project',
          'integration',
          '--coverage',
          ...(ci ? ['--coverage.reporter=json-summary', '--maxWorkers=2'] : []),
        ],
        perf: '0',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

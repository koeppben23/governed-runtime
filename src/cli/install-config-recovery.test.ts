/** Breaking config recovery through the real installer and config reader. */
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { install } from './install.js';
import { readConfig } from '../adapters/persistence-config.js';
import {
  tmpDir,
  repoArgs,
  globalArgs,
  createMockTarball,
  setupCliTestEnvironment,
} from './install-test-helpers.test.js';

vi.mock('node:child_process', async (importOriginal) => {
  const helpers = await import('./install-test-helpers.test.js');
  return helpers.childProcessMockFactory()(importOriginal);
});

describe('installer rejects obsolete config; recovery is manual', () => {
  setupCliTestEnvironment();

  it.each(['repo', 'global'] as const)(
    '%s install --force preserves invalid bytes and accepts manually corrected settings',
    async (scope) => {
      const coreTarball = await createMockTarball();
      const args = scope === 'repo' ? repoArgs({ coreTarball }) : globalArgs({ coreTarball });
      expect((await install(args)).errors).toEqual([]);
      const configPath = path.join(
        tmpDir,
        ...(scope === 'repo' ? ['.opencode'] : []),
        'flowguard.json',
      );
      const read = async () =>
        JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>;
      const write = (raw: unknown) => fs.writeFile(configPath, `${JSON.stringify(raw)}\n`, 'utf8');
      const raw = await read();
      expect(raw.reviewer).toEqual({ executionTimeoutMs: 600_000 });
      for (const obsolete of [
        {
          reviewer: {
            outputTokenMax: 'host',
            toolTimeoutMs: 30_000,
            reviewTimeoutMs: 480_000,
            serializationTimeoutMs: 60_000,
            executionTimeoutMs: 300_000,
          },
        },
        { presentation: { opencode: { glyphProfile: 'ascii' } } },
      ]) {
        await write({ ...raw, ...obsolete });
        const before = await fs.readFile(configPath, 'utf8');
        await expect(readConfig(scope === 'repo' ? tmpDir : undefined)).rejects.toMatchObject({
          code: 'SCHEMA_VALIDATION_FAILED',
        });
        expect((await install({ ...args, force: true })).errors.length).toBeGreaterThan(0);
        expect(await fs.readFile(configPath, 'utf8')).toBe(before);
      }
      await write({
        ...raw,
        presentation: { glyphProfile: 'ascii' },
        reviewer: { executionTimeoutMs: 300_000 },
      });
      expect((await install({ ...args, force: true })).errors).toEqual([]);
      expect((await read()).reviewer).toEqual({ executionTimeoutMs: 300_000 });
      expect((await read()).presentation).toEqual({ glyphProfile: 'ascii' });
    },
  );
});

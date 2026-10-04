import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import {
  buildRollbackSnapshot,
  initInstallContext,
  writeArtifacts,
  type ValidatedTarball,
} from './install-steps.js';
import {
  VERSION,
  createMockTarball,
  repoArgs,
  setupCliTestEnvironment,
  tmpDir,
} from './install-test-helpers.test.js';

setupCliTestEnvironment();

describe('installer mandate ownership', () => {
  it('fails before mutation when a same-named mandate file is customer-owned', async () => {
    const tarballPath = await createMockTarball();
    const target = path.join(tmpDir, '.opencode');
    const mandatesPath = path.join(target, 'flowguard-mandates.md');
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(mandatesPath, '# Customer-owned instructions\n', 'utf-8');

    const ctx = initInstallContext(repoArgs({ coreTarball: tarballPath, force: true }));
    const tarball: ValidatedTarball = {
      valid: true,
      path: tarballPath,
      name: path.basename(tarballPath),
      version: VERSION,
    };
    const snapshot = await buildRollbackSnapshot(ctx, tarball.name);

    await expect(writeArtifacts(ctx, tarball, snapshot)).rejects.toThrow(
      'MANAGED_ARTIFACT_CONFLICT',
    );

    await expect(fs.readFile(mandatesPath, 'utf-8')).resolves.toBe(
      '# Customer-owned instructions\n',
    );
    expect(existsSync(path.join(target, 'vendor', tarball.name))).toBe(false);
    expect(existsSync(path.join(target, 'tools'))).toBe(false);
  });
});

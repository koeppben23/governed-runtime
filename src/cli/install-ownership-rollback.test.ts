import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  childProcessMockFactory,
  createMockTarball,
  repoArgs,
  setupCliTestEnvironment,
  tmpDir,
} from './install-test-helpers.test.js';

vi.mock('node:child_process', childProcessMockFactory());

const ownershipMocks = vi.hoisted(() => ({
  writeInstallOwnershipManifest: vi.fn(),
}));

vi.mock('./install-ownership.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./install-ownership.js')>();
  return {
    ...actual,
    writeInstallOwnershipManifest: ownershipMocks.writeInstallOwnershipManifest,
  };
});

import { install } from './install.js';
import { INSTALL_OWNERSHIP_FILENAME } from './install-ownership.js';
import { MANDATES_FILENAME } from './templates.js';

setupCliTestEnvironment();

describe('install ownership transaction boundary', () => {
  beforeEach(() => {
    ownershipMocks.writeInstallOwnershipManifest.mockReset();
    ownershipMocks.writeInstallOwnershipManifest.mockRejectedValue(
      new Error('simulated ownership persistence failure'),
    );
  });

  it('fails installation and rolls back managed state when ownership cannot be persisted', async () => {
    const tarball = await createMockTarball();
    const target = path.join(tmpDir, '.opencode');

    const result = await install(repoArgs({ coreTarball: tarball }));

    expect(result.errors.join('\n')).toContain('simulated ownership persistence failure');
    expect(ownershipMocks.writeInstallOwnershipManifest).toHaveBeenCalledTimes(1);
    expect(existsSync(path.join(target, INSTALL_OWNERSHIP_FILENAME))).toBe(false);
    expect(existsSync(path.join(target, MANDATES_FILENAME))).toBe(false);
    expect(existsSync(path.join(target, 'package.json'))).toBe(false);
    expect(existsSync(path.join(target, 'node_modules'))).toBe(false);
    expect(result.ops).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: 'rolled_back' })]),
    );
  });
});

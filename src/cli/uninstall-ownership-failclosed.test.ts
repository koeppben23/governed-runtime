import { existsSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { install, uninstall, resolveTarget } from './install.js';
import { INSTALL_OWNERSHIP_FILENAME } from './install-ownership.js';
import {
  deriveInstallOwnershipManifest,
  writeInstallOwnershipManifest,
} from './install-ownership.js';
import {
  repoArgs,
  setupCliTestEnvironment,
  tmpDir,
  createMockTarball,
} from './install-test-helpers.test.js';

setupCliTestEnvironment();

describe('uninstall ownership fail-closed', () => {
  it.each(['claude-code', 'codex'] as const)(
    'also rejects obsolete %s installer provenance before writes, without a migration fallback',
    async (platform) => {
      const target = resolveTarget('repo', platform);
      await fs.mkdir(target, { recursive: true });
      const file = path.join(target, INSTALL_OWNERSHIP_FILENAME);
      const original = JSON.stringify({
        schemaVersion: 1,
        platform,
        scope: 'repo',
        packageJson: { created: true, zodAdded: true, previousCoreDependency: null },
      });
      await fs.writeFile(file, original);
      const result = await install(
        repoArgs({
          installPlatform: platform,
          coreTarball: await createMockTarball(),
          force: true,
        }),
      );
      expect(result.ops).toEqual([]);
      expect(result.errorDetails).toContainEqual(
        expect.objectContaining({ code: 'OWNERSHIP_MANIFEST_INVALID' }),
      );
      expect(await fs.readFile(file, 'utf8')).toBe(original);
    },
  );
  it.each([
    { platform: 'opencode' as const, scope: 'global' as const },
    { platform: 'codex' as const, scope: 'repo' as const },
  ])(
    'preserves current-format provenance owned by another host/scope: %j',
    async ({ platform, scope }) => {
      const target = path.join(tmpDir, '.opencode');
      await fs.mkdir(target, { recursive: true });
      const manifest = deriveInstallOwnershipManifest({
        platform,
        scope,
        packageJsonExisted: false,
        packageJsonCurrentContent: JSON.stringify({
          dependencies: { '@flowguard/core': 'file:./vendor/flowguard-core-2.0.0.tgz' },
        }),
      });
      await writeInstallOwnershipManifest(target, manifest);
      const sentinel = path.join(target, 'flowguard.json');
      await fs.writeFile(sentinel, 'scope-bound config bytes');
      const result = await uninstall(repoArgs({ action: 'uninstall' }));
      expect(result.ops).toEqual([]);
      expect(result.errorDetails).toContainEqual(
        expect.objectContaining({ code: 'OWNERSHIP_MANIFEST_SCOPE_MISMATCH' }),
      );
      expect(await fs.readFile(sentinel, 'utf8')).toBe('scope-bound config bytes');
      const installation = await install(
        repoArgs({ coreTarball: await createMockTarball(), force: true }),
      );
      expect(installation.ops).toEqual([]);
      expect(installation.errorDetails).toContainEqual(
        expect.objectContaining({ code: 'OWNERSHIP_MANIFEST_SCOPE_MISMATCH' }),
      );
      expect(await fs.readFile(sentinel, 'utf8')).toBe('scope-bound config bytes');
      expect(
        JSON.parse(await fs.readFile(path.join(target, INSTALL_OWNERSHIP_FILENAME), 'utf8')),
      ).toEqual(manifest);
    },
  );
  it('preserves an invalid ownership manifest and refuses destructive cleanup', async () => {
    const target = path.join(tmpDir, '.opencode');
    await fs.mkdir(target, { recursive: true });
    const manifestPath = path.join(target, INSTALL_OWNERSHIP_FILENAME);
    const malformed = '{"schemaVersion":999,"unexpected":true}\n';
    await fs.writeFile(manifestPath, malformed, 'utf-8');

    const sentinelPath = path.join(target, 'customer-sentinel.txt');
    await fs.writeFile(sentinelPath, 'customer-owned\n', 'utf-8');

    const result = await uninstall(repoArgs({ action: 'uninstall' }));

    expect(result.errors.join('\n')).toContain('ownership manifest');
    expect(result.errors.join('\n')).toContain('refusing uninstall');
    expect(existsSync(manifestPath)).toBe(true);
    expect(await fs.readFile(manifestPath, 'utf-8')).toBe(malformed);
    expect(await fs.readFile(sentinelPath, 'utf-8')).toBe('customer-owned\n');
  });

  it('preserves package.json byte-for-byte when dependency ownership is not proven', async () => {
    const target = path.join(tmpDir, '.opencode');
    await fs.mkdir(target, { recursive: true });
    const packagePath = path.join(target, 'package.json');
    const customerPackage =
      '{\n    "name":"customer-owned",\n    "dependencies": { "@flowguard/core": "customer-pin", "zod":"^4.0.0" }\n}\n\n';
    await fs.writeFile(packagePath, customerPackage, 'utf-8');

    const result = await uninstall(repoArgs({ action: 'uninstall' }));

    expect(result.errors).toEqual([]);
    expect(result.warnings.join('\n')).toContain('preserving package.json byte-for-byte');
    expect(await fs.readFile(packagePath, 'utf-8')).toBe(customerPackage);
    expect(result.ops).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: realpathSync(packagePath),
          action: 'skipped',
          reason: 'ownership not proven; no mutation performed',
        }),
      ]),
    );
  });
});

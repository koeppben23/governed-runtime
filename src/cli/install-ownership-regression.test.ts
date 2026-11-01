import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import * as asyncFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename), writeFile: vi.fn(actual.writeFile) };
});
import { buildMandatesContent } from '../rendering/mandates-renderer.js';
import { computeMandatesDigest } from './install-helpers.js';
import { formatRecoveryLines } from './install-recovery.js';
import {
  assertManagedMandatesOwnership,
  assertNativeOpenCodeInstallTarget,
  deriveInstallOwnershipManifest,
  readInstallOwnershipManifest,
  writeInstallOwnershipManifest,
  INSTALL_OWNERSHIP_FILENAME,
} from './install-ownership.js';

const input = {
  platform: 'opencode' as const,
  scope: 'repo' as const,
  packageJsonExisted: true,
  packageJsonOriginalContent: Buffer.from(
    JSON.stringify({ dependencies: { '@flowguard/core': 'workspace:*', zod: '^3.22.0' } }),
  ),
  packageJsonCurrentContent: JSON.stringify({
    dependencies: { '@flowguard/core': 'file:./vendor/flowguard-core-2.0.0.tgz', zod: '^3.22.0' },
  }),
};
describe('installer ownership regressions', () => {
  it.each([{ scope: 'global' as const }, { platform: 'codex' as const }])(
    'refuses to replace another host/scope manifest: %j',
    async (change) => {
      const dir = mkdtempSync(join(tmpdir(), 'fg-owned-scope-'));
      try {
        await writeInstallOwnershipManifest(dir, deriveInstallOwnershipManifest(input));
        const before = readFileSync(join(dir, INSTALL_OWNERSHIP_FILENAME), 'utf8');
        await expect(
          writeInstallOwnershipManifest(
            dir,
            deriveInstallOwnershipManifest({ ...input, ...change }),
          ),
        ).rejects.toMatchObject({ code: 'OWNERSHIP_MANIFEST_SCOPE_MISMATCH' });
        expect(readFileSync(join(dir, INSTALL_OWNERSHIP_FILENAME), 'utf8')).toBe(before);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
  it.each(['missing', '', 123])(
    'rejects unavailable installed dependency provenance %j with its typed cause',
    (core) => {
      const dependencies = core === 'missing' ? {} : { '@flowguard/core': core };
      try {
        deriveInstallOwnershipManifest({
          ...input,
          packageJsonCurrentContent: JSON.stringify({ dependencies }),
        });
        expect.unreachable();
      } catch (error) {
        expect(error).toMatchObject({ code: 'INSTALL_OWNERSHIP_UNAVAILABLE' });
      }
    },
  );
  it.each([null, 'not a dependency map'])(
    'does not invent a previous dependency from malformed package shape %j',
    (dependencies) => {
      expect(
        deriveInstallOwnershipManifest({
          ...input,
          packageJsonOriginalContent: Buffer.from(JSON.stringify({ dependencies })),
        }).packageJson,
      ).toMatchObject({ previousCoreDependency: null, zodAdded: true });
    },
  );
  it('preserves malformed manifest bytes when asked to write current provenance', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fg-invalid-ownership-'));
    try {
      const file = join(dir, INSTALL_OWNERSHIP_FILENAME);
      writeFileSync(file, '{broken');
      await expect(
        writeInstallOwnershipManifest(dir, deriveInstallOwnershipManifest(input)),
      ).rejects.toMatchObject({ code: 'OWNERSHIP_MANIFEST_INVALID' });
      expect(readFileSync(file, 'utf8')).toBe('{broken');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('does not treat an unreadable manifest path as absence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fg-manifest-directory-'));
    try {
      mkdirSync(join(dir, INSTALL_OWNERSHIP_FILENAME));
      await expect(readInstallOwnershipManifest(dir)).resolves.toBeNull();
      await expect(
        writeInstallOwnershipManifest(dir, deriveInstallOwnershipManifest(input)),
      ).rejects.toMatchObject({ code: 'OWNERSHIP_MANIFEST_INVALID' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('writes manifest provenance exclusively and preserves existing bytes on failed rename', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fg-manifest-rename-'));
    try {
      const first = deriveInstallOwnershipManifest(input);
      vi.mocked(asyncFs.writeFile).mockClear();
      await writeInstallOwnershipManifest(dir, first);
      expect(vi.mocked(asyncFs.writeFile).mock.calls[0]?.[2]).toEqual({
        encoding: 'utf-8',
        flag: 'wx',
      });
      const before = readFileSync(join(dir, INSTALL_OWNERSHIP_FILENAME), 'utf8');
      const failure = new Error('rename failed');
      vi.mocked(asyncFs.rename).mockRejectedValueOnce(failure);
      await expect(writeInstallOwnershipManifest(dir, first)).rejects.toBe(failure);
      expect(readFileSync(join(dir, INSTALL_OWNERSHIP_FILENAME), 'utf8')).toBe(before);
      expect(await asyncFs.readdir(dir)).toEqual([INSTALL_OWNERSHIP_FILENAME]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('keeps customer AGENTS.md references byte-for-byte, without claiming them as authority', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fg-user-instructions-'));
    try {
      const content = '{ // customer instructions\n "instructions":["AGENTS.md"] }\n';
      writeFileSync(join(dir, 'opencode.jsonc'), content);
      await assertNativeOpenCodeInstallTarget(dir, [dir]);
      expect(readFileSync(join(dir, 'opencode.jsonc'), 'utf8')).toBe(content);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('classifies unmanaged mandate conflicts with non-destructive recovery', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fg-ownership-conflict-'));
    const path = join(dir, 'flowguard-mandates.md');
    try {
      writeFileSync(path, '# customer content\n');
      await expect(assertManagedMandatesOwnership(path)).rejects.toMatchObject({
        code: 'MANAGED_ARTIFACT_CONFLICT',
      });
      const recovery = formatRecoveryLines([
        { code: 'MANAGED_ARTIFACT_CONFLICT', message: 'conflict' },
      ]).join('\n');
      expect(recovery).toContain('Move or rename');
      expect(recovery).not.toContain('--force');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('accepts a managed mandate header as file ownership, not activation evidence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fg-managed-mandate-'));
    const path = join(dir, 'flowguard-mandates.md');
    try {
      writeFileSync(path, buildMandatesContent('1.0.0', computeMandatesDigest()));
      await expect(assertManagedMandatesOwnership(path)).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('records only dependency provenance, not task permissions or activation', () => {
    const manifest = deriveInstallOwnershipManifest(input);
    expect(manifest).toEqual({
      schemaVersion: 2,
      platform: 'opencode',
      scope: 'repo',
      packageJson: {
        created: false,
        zodAdded: false,
        previousCoreDependency: 'workspace:*',
        installedCoreDependency: 'file:./vendor/flowguard-core-2.0.0.tgz',
      },
    });
  });
  it('retains first-install provenance across force reinstalls', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fg-ownership-chain-'));
    try {
      const first = deriveInstallOwnershipManifest(input);
      await writeInstallOwnershipManifest(dir, first);
      const next = deriveInstallOwnershipManifest({
        ...input,
        packageJsonCurrentContent: JSON.stringify({
          dependencies: { '@flowguard/core': 'file:./vendor/flowguard-core-3.0.0.tgz' },
        }),
      });
      await writeInstallOwnershipManifest(dir, next);
      await expect(readInstallOwnershipManifest(dir)).resolves.toEqual({
        ...first,
        packageJson: {
          ...first.packageJson,
          installedCoreDependency: 'file:./vendor/flowguard-core-3.0.0.tgz',
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('rejects the obsolete ownership format without rewriting it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fg-old-ownership-'));
    try {
      const obsolete = JSON.stringify({
        ...deriveInstallOwnershipManifest(input),
        schemaVersion: 1,
        opencode: { taskHardeningAdded: true },
      });
      writeFileSync(join(dir, INSTALL_OWNERSHIP_FILENAME), obsolete);
      await expect(readInstallOwnershipManifest(dir)).resolves.toBeNull();
      await expect(assertNativeOpenCodeInstallTarget(dir, [dir])).rejects.toMatchObject({
        code: 'OPENCODE_FRESH_INSTALL_REQUIRED',
      });
      expect(readFileSync(join(dir, INSTALL_OWNERSHIP_FILENAME), 'utf8')).toBe(obsolete);
      expect(
        formatRecoveryLines([
          { code: 'OPENCODE_FRESH_INSTALL_REQUIRED', message: 'obsolete' },
        ]).join('\n'),
      ).toContain('byte-for-byte');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

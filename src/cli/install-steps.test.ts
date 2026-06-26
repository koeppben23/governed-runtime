/**
 * @module cli/install-steps.test
 * @description Contract tests for the public API of install-steps.
 *
 * Covers initInstallContext (pure), validateTarball (FS-dependent),
 * and emitPostInstallWarnings (pure). Remaining pipeline functions
 * are intentionally left to integration-level tests.
 *
 * @test-policy HAPPY, BAD, CORNER
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initInstallContext, validateTarball, emitPostInstallWarnings } from './install-steps.js';
import { PACKAGE_VERSION } from './install-helpers.js';
import { repoArgs, globalArgs } from './install-test-helpers.test.js';

const VERSION = PACKAGE_VERSION();

async function createTarballFixture(
  dir: string,
  options: { writeChecksum?: boolean; checksumContent?: string } = {},
): Promise<string> {
  const tarballPath = join(dir, `flowguard-core-${VERSION}.tgz`);
  const content = 'mock tarball content';
  await writeFile(tarballPath, content);
  if (options.writeChecksum !== false) {
    const hash = createHash('sha256').update(content).digest('hex');
    const line = options.checksumContent ?? `${hash}  flowguard-core-${VERSION}.tgz\n`;
    await writeFile(join(dir, 'checksums.sha256'), line);
  }
  return tarballPath;
}

describe('initInstallContext', () => {
  it('creates repo-scoped context with opencode platform', () => {
    const ctx = initInstallContext(repoArgs({ installPlatform: 'opencode' }));
    expect(ctx.installPlatform).toBe('opencode');
    expect(ctx.target).toContain('.opencode');
    expect(ctx.ops).toEqual([]);
    expect(ctx.errors).toEqual([]);
    expect(ctx.warnings).toEqual([]);
    expect(ctx.args.installScope).toBe('repo');
  });

  it('creates global-scoped context with non-empty target', () => {
    const ctx = initInstallContext(globalArgs());
    expect(ctx.target.length).toBeGreaterThan(0);
    expect(ctx.ops).toEqual([]);
    expect(ctx.warnings).toEqual([]);
    expect(ctx.args.installScope).toBe('global');
  });

  it('creates claude-code platform context', () => {
    const ctx = initInstallContext(repoArgs({ installPlatform: 'claude-code' }));
    expect(ctx.installPlatform).toBe('claude-code');
  });
});

describe('validateTarball', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'fg-install-steps-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it('returns ValidatedTarball for valid tarball with matching checksum', async () => {
    const tarballPath = await createTarballFixture(testDir);
    const ctx = initInstallContext(repoArgs({ coreTarball: tarballPath }));
    const result = await validateTarball(ctx);
    expect(result).not.toBeNull();
    expect(result!.valid).toBe(true);
    expect(result!.name).toContain(`flowguard-core-${VERSION}`);
    expect(result!.version).toBe(VERSION);
  });

  it('returns null when tarball does not exist', async () => {
    const ctx = initInstallContext(repoArgs({ coreTarball: join(testDir, 'nonexistent.tgz') }));
    const result = await validateTarball(ctx);
    expect(result).toBeNull();
    expect(ctx.errors.length).toBeGreaterThan(0);
    expect(ctx.errors.some((e) => e.includes('not found'))).toBe(true);
  });

  it('returns null on checksum mismatch', async () => {
    const tarballPath = await createTarballFixture(testDir, {
      checksumContent: `0000000000000000000000000000000000000000000000000000000000000000  flowguard-core-${VERSION}.tgz\n`,
    });
    const ctx = initInstallContext(repoArgs({ coreTarball: tarballPath }));
    const result = await validateTarball(ctx);
    expect(result).toBeNull();
    expect(ctx.errors.length).toBeGreaterThan(0);
    expect(ctx.errors.some((e) => e.includes('integrity'))).toBe(true);
  });

  it('returns null when checksums file is missing', async () => {
    const tarballPath = await createTarballFixture(testDir, { writeChecksum: false });
    const ctx = initInstallContext(repoArgs({ coreTarball: tarballPath }));
    const result = await validateTarball(ctx);
    expect(result).toBeNull();
    expect(ctx.errors.length).toBeGreaterThan(0);
  });
});

describe('emitPostInstallWarnings', () => {
  it('adds restart warning for opencode platform', () => {
    const ctx = initInstallContext(repoArgs({ installPlatform: 'opencode' }));
    emitPostInstallWarnings(ctx);
    expect(ctx.warnings.length).toBeGreaterThan(0);
    expect(ctx.warnings.some((w) => w.includes('Restart'))).toBe(true);
  });

  it('adds plugin-dir guidance for claude-code', () => {
    const ctx = initInstallContext(repoArgs({ installPlatform: 'claude-code' }));
    emitPostInstallWarnings(ctx);
    expect(ctx.warnings.some((w) => w.includes('claude --plugin-dir'))).toBe(true);
  });

  it('adds marketplace registration note for codex', () => {
    const ctx = initInstallContext(repoArgs({ installPlatform: 'codex' }));
    emitPostInstallWarnings(ctx);
    expect(ctx.warnings.some((w) => w.includes('Codex'))).toBe(true);
  });
});

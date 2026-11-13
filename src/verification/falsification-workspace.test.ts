/** Private source-copy contract: fidelity, drift and containment failures. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withFalsificationWorkspace } from './falsification-workspace.js';

let root: string;
let worktree: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'flowguard-variant-'));
  worktree = join(root, 'worktree');
  await mkdir(join(worktree, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: worktree });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: worktree });
  await writeFile(join(worktree, 'src/guard.txt'), 'guard enabled\n');
  await writeFile(join(worktree, 'tool.sh'), '#!/bin/sh\nexit 0\n');
  await chmod(join(worktree, 'tool.sh'), 0o755);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const VARIANT = { path: 'src/guard.txt', before: 'guard enabled', after: 'guard removed' };

describe('withFalsificationWorkspace', () => {
  it('copies exact bytes and modes, mutates only the variant, and cleans up', async () => {
    let controlRoot = '';
    let variantRoot = '';
    const outcome = await withFalsificationWorkspace(worktree, VARIANT, async (workspace) => {
      controlRoot = workspace.control;
      variantRoot = workspace.variant;
      expect(await readFile(join(workspace.control, 'src/guard.txt'), 'utf8')).toBe(
        'guard enabled\n',
      );
      expect(await readFile(join(workspace.variant, 'src/guard.txt'), 'utf8')).toBe(
        'guard removed\n',
      );
      expect((await lstat(join(workspace.control, 'tool.sh'))).mode & 0o111).not.toBe(0);
      expect(workspace.controlSourceDigest).not.toBe(workspace.variantSourceDigest);
      await workspace.attest();
      return 'ok';
    });
    expect(outcome).toBe('ok');
    expect(await readFile(join(worktree, 'src/guard.txt'), 'utf8')).toBe('guard enabled\n');
    await expect(access(controlRoot)).rejects.toThrow();
    await expect(access(variantRoot)).rejects.toThrow();
  });

  it('rejects a variant target that is not in the source snapshot', async () => {
    await expect(
      withFalsificationWorkspace(worktree, { ...VARIANT, path: 'src/missing.txt' }, async () => 1),
    ).rejects.toMatchObject({ code: 'VERIFICATION_FALSIFICATION_UNAVAILABLE' });
  });

  it('rejects a non-unique before text and leaves the original untouched', async () => {
    await writeFile(join(worktree, 'src/guard.txt'), 'guard enabled guard enabled\n');
    await expect(
      withFalsificationWorkspace(worktree, VARIANT, async () => 1),
    ).rejects.toMatchObject({ code: 'VERIFICATION_FALSIFICATION_UNAVAILABLE' });
    expect(await readFile(join(worktree, 'src/guard.txt'), 'utf8')).toBe(
      'guard enabled guard enabled\n',
    );
  });

  it('rejects a missing target in the copied snapshot', async () => {
    execFileSync('git', ['add', 'src/guard.txt'], { cwd: worktree });
    await rm(join(worktree, 'src/guard.txt'));
    await expect(
      withFalsificationWorkspace(worktree, VARIANT, async () => 1),
    ).rejects.toMatchObject({ code: 'VERIFICATION_FALSIFICATION_UNAVAILABLE' });
  });

  it('detects original source drift during the run', async () => {
    await expect(
      withFalsificationWorkspace(worktree, VARIANT, async (workspace) => {
        await writeFile(join(worktree, 'src/guard.txt'), 'drifted\n');
        await workspace.attest();
        return 1;
      }),
    ).rejects.toMatchObject({ code: 'VERIFICATION_FALSIFICATION_UNAVAILABLE' });
  });

  it('detects source membership drift during the run', async () => {
    await expect(
      withFalsificationWorkspace(worktree, VARIANT, async (workspace) => {
        await writeFile(join(worktree, 'new-source.txt'), 'new\n');
        await workspace.attest();
        return 1;
      }),
    ).rejects.toMatchObject({ code: 'VERIFICATION_FALSIFICATION_UNAVAILABLE' });
  });

  it('rejects a contained symlink whose physical target escapes the worktree', async () => {
    const outside = join(root, 'outside.txt');
    await writeFile(outside, 'outside\n');
    await symlink(outside, join(worktree, 'src/link.txt'));
    await expect(
      withFalsificationWorkspace(worktree, VARIANT, async () => 1),
    ).rejects.toMatchObject({ code: 'VERIFICATION_FALSIFICATION_UNAVAILABLE' });
  });

  it('normalizes wrapped blocked errors without mutating the original', async () => {
    await expect(
      withFalsificationWorkspace(worktree, { ...VARIANT, path: '.git/config' }, async () => 1),
    ).rejects.toMatchObject({ code: 'VERIFICATION_FALSIFICATION_UNAVAILABLE' });
    expect(await readFile(join(worktree, 'src/guard.txt'), 'utf8')).toBe('guard enabled\n');
  });
});

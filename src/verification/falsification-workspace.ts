/** Private source copies for control/variant runs. This is not a process sandbox. */
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { listRepoSignals } from '../adapters/git.js';
import { canonicalRepoRelativePath } from '../shared/repo-path.js';
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { hashBuffer, hashText } from '../shared/hashing.js';
import type { FalsificationVariant } from '../state/falsification-variant.js';
import { FalsificationUnavailableError } from './errors.js';

function blocked(message: string): never {
  throw new FalsificationUnavailableError(message);
}

async function sourceFile(root: string, path: string): Promise<string | null> {
  if (canonicalRepoRelativePath(path) !== path || path.split('/').includes('.git'))
    return blocked(`Unsafe snapshot path: ${path}`);
  const file = join(root, path);
  try {
    const actual = await realpath(file);
    if (!actual.startsWith(`${await realpath(root)}${sep}`) || !(await lstat(file)).isFile())
      return blocked(`Snapshot requires contained regular files: ${path}`);
    return file;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function sourceDigest(root: string, paths: readonly string[]): Promise<string> {
  const entries = [];
  for (const path of paths) {
    const file = await sourceFile(root, path);
    entries.push({
      path,
      content: file === null ? null : hashBuffer(await readFile(file)),
      mode: file === null ? null : (await lstat(file)).mode,
    });
  }
  return hashText(canonicalJsonStringify(entries));
}

export async function withFalsificationWorkspace<T>(
  worktree: string,
  variant: FalsificationVariant,
  run: (workspace: {
    control: string;
    variant: string;
    controlSourceDigest: string;
    variantSourceDigest: string;
    attest: () => Promise<void>;
  }) => Promise<T>,
): Promise<T> {
  const paths = [...new Set((await listRepoSignals(worktree)).files)].sort();
  if (!paths.includes(variant.path)) return blocked('Variant target is not in the source snapshot');
  const originalDigest = await sourceDigest(worktree, paths);
  const owned = await mkdtemp(join(tmpdir(), 'flowguard-falsification-'));
  try {
    const control = join(owned, 'control');
    const variantRoot = join(owned, 'variant');
    await mkdir(control);
    await mkdir(variantRoot);
    for (const path of paths) {
      const file = await sourceFile(worktree, path);
      if (file === null) continue;
      for (const root of [control, variantRoot]) {
        const destination = join(root, path);
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(file, destination);
        // Wrapper scripts (mvnw/gradlew) must stay executable: copyFile does
        // not guarantee the source mode.
        await chmod(destination, (await lstat(file)).mode & 0o777);
      }
    }
    if (
      (await sourceDigest(control, paths)) !== originalDigest ||
      (await sourceDigest(variantRoot, paths)) !== originalDigest
    )
      return blocked('Source changed while the isolated copies were prepared');
    const target = join(variantRoot, variant.path);
    const content = await readFile(target, 'utf8').catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return blocked('Variant target is missing from the source snapshot');
      throw error;
    });
    if (content.split(variant.before).length !== 2)
      return blocked('Variant before text must match exactly once');
    await writeFile(
      target,
      content.replace(variant.before, () => variant.after),
    );
    const variantSourceDigest = await sourceDigest(variantRoot, paths);
    if (variantSourceDigest === originalDigest)
      return blocked('Variant did not change the snapshot');
    const attest = async (): Promise<void> => {
      if (
        (await sourceDigest(worktree, paths)) !== originalDigest ||
        (await sourceDigest(control, paths)) !== originalDigest ||
        (await sourceDigest(variantRoot, paths)) !== variantSourceDigest
      )
        return blocked('Source drift during falsification execution');
      const currentPaths = [...new Set((await listRepoSignals(worktree)).files)].sort();
      if (canonicalJsonStringify(currentPaths) !== canonicalJsonStringify(paths))
        return blocked('Original worktree membership changed during falsification');
    };
    return await run({
      control,
      variant: variantRoot,
      controlSourceDigest: originalDigest,
      variantSourceDigest,
      attest,
    });
  } finally {
    await rm(owned, { recursive: true, force: true });
  }
}

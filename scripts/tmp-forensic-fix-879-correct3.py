from pathlib import Path

p = Path('scripts/tmp-forensic-fix-879.py')
s = p.read_text()
extra = r'''

# 11) Remove the FlowGuard-generated dependency tree only when package provenance proves
# the installer-created package shell was restored to absence. If package.json is
# preserved because the user added/changed content, node_modules is preserved too.
replace(
    "src/cli/uninstall-command.ts",
    "import { existsSync } from 'node:fs';",
    "import { existsSync } from 'node:fs';\nimport { lstat } from 'node:fs/promises';",
)
replace(
    "src/cli/uninstall-command.ts",
    """async function cleanupOpencodeConfig(
""",
    """async function cleanupOwnedDependencyTree(
  target: string,
  packageOps: readonly FileOp[],
): Promise<FileOp[]> {
  const packageRestoredToAbsent = packageOps.some(
    (op) =>
      op.action === 'removed' &&
      op.reason === 'installer-created package restored to absent pre-state',
  );
  if (!packageRestoredToAbsent) return [];

  const modulesPath = join(target, 'node_modules');
  try {
    const stat = await lstat(modulesPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return [
        {
          path: modulesPath,
          action: 'skipped',
          reason: 'dependency-tree ownership/type mismatch; preserved',
        },
      ];
    }
    await rm(modulesPath, { recursive: true });
    return [
      {
        path: modulesPath,
        action: 'removed',
        reason: 'removed dependency tree owned by installer-created package shell',
      },
    ];
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [{ path: modulesPath, action: 'not_found' }];
    }
    throw error;
  }
}

async function cleanupOpencodeConfig(
""",
)
replace(
    "src/cli/uninstall-command.ts",
    """    await removeManagedFiles(target, installPlatform, ops, warnings);
    ops.push(...(await cleanupPackageJson(target, ownership, warnings)));
    ops.push(...(await cleanupOpencodeConfig(args, target, ownership)));
""",
    """    await removeManagedFiles(target, installPlatform, ops, warnings);
    const packageOps = await cleanupPackageJson(target, ownership, warnings);
    ops.push(...packageOps);
    ops.push(...(await cleanupOwnedDependencyTree(target, packageOps)));
    ops.push(...(await cleanupOpencodeConfig(args, target, ownership)));
""",
)

# 12) Regression: a user-authored @flowguard/core change after install must survive uninstall.
needle = """    it('uninstall preserves package.json when scripts exist', async () => {
"""
insert = """    it('uninstall preserves a user-modified @flowguard/core value after install', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));

      const pkgPath = path.join(tmpDir, '.opencode', 'package.json');
      const installed = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
      installed.dependencies['@flowguard/core'] = '^9.9.9';
      await fs.writeFile(pkgPath, JSON.stringify(installed, null, 2) + '\\n', 'utf-8');

      const result = await uninstall(repoArgs({ action: 'uninstall' }));

      expect(result.errors).toEqual([]);
      expect(result.warnings).toContainEqual(
        expect.stringContaining('@flowguard/core changed after FlowGuard installation'),
      );
      const after = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
      expect(after.dependencies['@flowguard/core']).toBe('^9.9.9');
    });

""" + needle
replace("src/cli/install-uninstall.test.ts", needle, insert)

# 13) Codex target IS the plugin root. After owned config + provenance files are removed,
# prune that root only if it is actually empty. Never do this for Claude because its
# target is the whole .claude configuration directory.
replace(
    "src/cli/uninstall-command.ts",
    "import { readdir, rm, writeFile } from 'node:fs/promises';",
    "import { readdir, rm, rmdir, writeFile } from 'node:fs/promises';",
)
replace(
    "src/cli/uninstall-command.ts",
    """export async function uninstall(args: CliArgs): Promise<CliResult> {
""",
    """async function cleanupEmptyCodexTarget(target: string): Promise<FileOp> {
  try {
    await rmdir(target);
    return { path: target, action: 'removed', reason: 'empty FlowGuard Codex target' };
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      if (error.code === 'ENOENT') return { path: target, action: 'not_found' };
      if (error.code === 'ENOTEMPTY' || error.code === 'EEXIST') {
        return {
          path: target,
          action: 'skipped',
          reason: 'Codex target contains preserved or non-FlowGuard content',
        };
      }
    }
    throw error;
  }
}

export async function uninstall(args: CliArgs): Promise<CliResult> {
""",
)
replace(
    "src/cli/uninstall-command.ts",
    """    const removedManifest = await safeUnlink(manifestPath);
    ops.push({ path: manifestPath, action: removedManifest ? 'removed' : 'not_found' });
""",
    """    const removedManifest = await safeUnlink(manifestPath);
    ops.push({ path: manifestPath, action: removedManifest ? 'removed' : 'not_found' });
    if (installPlatform === 'codex') ops.push(await cleanupEmptyCodexTarget(target));
""",
)

# 14) Lifecycle timestamps are carried explicitly; the old builder clock parameter is dead.
replace(
    "src/integration/review/shared-helpers.ts",
    """  obligation: { mandateDigest: string; criteriaVersion: string },
  now: string,
): ReturnType<typeof buildInvocationEvidence> {
""",
    """  obligation: { mandateDigest: string; criteriaVersion: string },
): ReturnType<typeof buildInvocationEvidence> {
""",
)
replace(
    "src/integration/review/shared-helpers.ts",
    "const invocation = buildSdkSessionInvocation(params, obligation, now2);",
    "const invocation = buildSdkSessionInvocation(params, obligation);",
)
'''
p.write_text(s + extra)

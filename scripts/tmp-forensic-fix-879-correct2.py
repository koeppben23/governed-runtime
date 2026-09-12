from pathlib import Path

p = Path('scripts/tmp-forensic-fix-879.py')
s = p.read_text()
needle = "installedCoreDependency: z.string().min(1),"
if s.count(needle) != 1:
    raise SystemExit(f'installedCoreDependency schema patch count={s.count(needle)}')
s = s.replace(needle, "installedCoreDependency: z.string().min(1).optional(),")

extra = r'''

# 9) Non-OpenCode plugin ownership: remove only exact FlowGuard-owned files and prune empty dirs.
replace(
    "src/cli/install-types.ts",
    "  | 'LEGACY_INSTRUCTION_AMBIGUOUS'\n  | 'DEPENDENCY_INSTALL_FAILED'",
    "  | 'LEGACY_INSTRUCTION_AMBIGUOUS'\n  | 'INSTALL_OWNERSHIP_UNAVAILABLE'\n  | 'DEPENDENCY_INSTALL_FAILED'",
)
replace(
    "src/cli/claude-code-plugin-install.ts",
    """export async function writeClaudeCodePluginInstallHint(target: string): Promise<FileOp> {
  const pluginRoot = resolveClaudeCodePluginRoot(target);
  const hintPath = join(pluginRoot, 'INSTALL.md');
  const content = `# FlowGuard Claude Code Plugin

Load this plugin in Claude Code with:

\`\`\`bash
claude --plugin-dir ${pluginRoot}
\`\`\`

The plugin packages FlowGuard MCP tools, hook wiring, workflow skills, and the
FlowGuard reviewer transport agent. Governance authority remains in the
FlowGuard runtime MCP tools, hooks, state, policy, and review evidence binding.
`;
  await writeFile(hintPath, content, 'utf-8');
  return { path: hintPath, action: 'written' };
}
""",
    """export function claudeCodePluginInstallHint(target: string): string {
  const pluginRoot = resolveClaudeCodePluginRoot(target);
  return `# FlowGuard Claude Code Plugin

Load this plugin in Claude Code with:

\`\`\`bash
claude --plugin-dir ${pluginRoot}
\`\`\`

The plugin packages FlowGuard MCP tools, hook wiring, workflow skills, and the
FlowGuard reviewer transport agent. Governance authority remains in the
FlowGuard runtime MCP tools, hooks, state, policy, and review evidence binding.
`;
}

export async function writeClaudeCodePluginInstallHint(target: string): Promise<FileOp> {
  const pluginRoot = resolveClaudeCodePluginRoot(target);
  const hintPath = join(pluginRoot, 'INSTALL.md');
  await writeFile(hintPath, claudeCodePluginInstallHint(target), 'utf-8');
  return { path: hintPath, action: 'written' };
}
""",
)
replace(
    "src/cli/platform-uninstall.ts",
    "import { readFile, readdir, rm, writeFile, rename, unlink } from 'node:fs/promises';",
    "import { lstat, readFile, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';",
)
replace(
    "src/cli/platform-uninstall.ts",
    "import { dirname, join, relative } from 'node:path';",
    "import { dirname, join } from 'node:path';",
)
replace(
    "src/cli/platform-uninstall.ts",
    "import { resolveClaudeCodePluginRoot } from './claude-code-plugin-install.js';",
    "import { claudeCodePluginInstallHint, resolveClaudeCodePluginRoot } from './claude-code-plugin-install.js';",
)
replace(
    "src/cli/platform-uninstall.ts",
    """async function collectFiles(root: string, current = root): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(root, full)));
    else if (entry.isFile()) files.push(relative(root, full).replace(/\\\\/g, '/'));
    else return ['__UNSUPPORTED_ENTRY__'];
  }
  return files.sort();
}

async function pluginTreeMatches(root: string, expected: Record<string, string>): Promise<boolean> {
  const actualFiles = await collectFiles(root);
  const expectedFiles = Object.keys(expected).sort();
  if (actualFiles.length !== expectedFiles.length) return false;
  if (actualFiles.some((file, index) => file !== expectedFiles[index])) return false;
  for (const file of expectedFiles) {
    try {
      if ((await readFile(join(root, file), 'utf-8')) !== expected[file]) return false;
    } catch {
      return false;
    }
  }
  return true;
}

""",
    "",
)
replace(
    "src/cli/platform-uninstall.ts",
    """export async function uninstallClaudeCodePlugin(target: string): Promise<FileOp[]> {
  const pluginRoot = resolveClaudeCodePluginRoot(target);
  const version = await readPluginVersion(pluginRoot, '.claude-plugin/plugin.json');
  if (!version) {
    return [{ path: pluginRoot, action: 'skipped', reason: 'Claude plugin ownership not proven' }];
  }
  const expected = claudeCodePluginFiles(version);
  if (!(await pluginTreeMatches(pluginRoot, expected))) {
    return [
      {
        path: pluginRoot,
        action: 'skipped',
        reason: 'Claude plugin tree differs from installed FlowGuard template; preserved',
      },
    ];
  }
  return [await removePluginTree(pluginRoot, 'FlowGuard Claude Code plugin tree')];
}

export async function uninstallCodexPlugin(scope: InstallScope): Promise<FileOp[]> {
  const ops: FileOp[] = [];
  const pluginRoot = resolveCodexPluginRoot(scope);
  const version = await readPluginVersion(pluginRoot, '.codex-plugin/plugin.json');
  if (!version) {
    ops.push({ path: pluginRoot, action: 'skipped', reason: 'Codex plugin ownership not proven' });
  } else if (await pluginTreeMatches(pluginRoot, codexPluginFiles(version))) {
    ops.push(await removePluginTree(pluginRoot, 'FlowGuard Codex plugin tree'));
  } else {
    ops.push({
      path: pluginRoot,
      action: 'skipped',
      reason: 'Codex plugin tree differs from installed FlowGuard template; preserved',
    });
  }

  ops.push(await removeCodexMarketplaceEntry(scope));
  return ops;
}

async function removePluginTree(pluginRoot: string, reason: string): Promise<FileOp> {
  try {
    await rm(pluginRoot, { recursive: true });
    return { path: pluginRoot, action: 'removed', reason };
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return { path: pluginRoot, action: 'not_found' };
    throw err;
  }
}
""",
    """export async function uninstallClaudeCodePlugin(target: string): Promise<FileOp[]> {
  const pluginRoot = resolveClaudeCodePluginRoot(target);
  const version = await readPluginVersion(pluginRoot, '.claude-plugin/plugin.json');
  if (!version) {
    return [{ path: pluginRoot, action: 'skipped', reason: 'Claude plugin ownership not proven' }];
  }
  return removeOwnedPluginFiles(
    pluginRoot,
    {
      ...claudeCodePluginFiles(version),
      'INSTALL.md': claudeCodePluginInstallHint(target),
    },
    'FlowGuard Claude Code plugin file',
  );
}

export async function uninstallCodexPlugin(scope: InstallScope): Promise<FileOp[]> {
  const ops: FileOp[] = [];
  const pluginRoot = resolveCodexPluginRoot(scope);
  const version = await readPluginVersion(pluginRoot, '.codex-plugin/plugin.json');
  if (!version) {
    ops.push({ path: pluginRoot, action: 'skipped', reason: 'Codex plugin ownership not proven' });
  } else {
    ops.push(
      ...(await removeOwnedPluginFiles(
        pluginRoot,
        codexPluginFiles(version),
        'FlowGuard Codex plugin file',
      )),
    );
  }

  ops.push(await removeCodexMarketplaceEntry(scope));
  return ops;
}

async function removeOwnedPluginFiles(
  pluginRoot: string,
  expected: Record<string, string>,
  reason: string,
): Promise<FileOp[]> {
  let rootStat;
  try {
    rootStat = await lstat(pluginRoot);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return [{ path: pluginRoot, action: 'not_found' }];
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return [{ path: pluginRoot, action: 'skipped', reason: 'plugin root ownership not proven' }];
  }

  const ops: FileOp[] = [];
  for (const [relativePath, expectedContent] of Object.entries(expected)) {
    const fullPath = join(pluginRoot, relativePath);
    try {
      const stat = await lstat(fullPath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        ops.push({ path: fullPath, action: 'skipped', reason: 'ownership/content mismatch' });
        continue;
      }
      const actual = await readFile(fullPath, 'utf-8');
      if (actual !== expectedContent) {
        ops.push({ path: fullPath, action: 'skipped', reason: 'ownership/content mismatch' });
        continue;
      }
      await unlink(fullPath);
      ops.push({ path: fullPath, action: 'removed', reason });
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    }
  }
  await pruneEmptyPluginDirectories(pluginRoot);
  return ops.length > 0 ? ops : [{ path: pluginRoot, action: 'not_found' }];
}

async function pruneEmptyPluginDirectories(root: string, current = root): Promise<void> {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await pruneEmptyPluginDirectories(root, join(current, entry.name));
  }
  const remaining = await readdir(current);
  if (remaining.length === 0) await rmdir(current);
}
""",
)

# 10) SDK content-review regression asserts host-observed lifecycle and bound attempt lineage.
replace(
    "src/integration/plugin-orchestrator-review-content.test.ts",
    """      status: 'fulfilled',
      fulfilledAt: NOW,
    });
""",
    """      status: 'fulfilled',
      fulfilledAt: expect.any(String),
    });
""",
    1,
)
replace(
    "src/integration/plugin-orchestrator-review-content.test.ts",
    """      findingsHash: expect.any(String),
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      invokedAt: NOW,
      fulfilledAt: NOW,
""",
    """      findingsHash: expect.any(String),
      attemptId: ATTEMPT_ID,
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      invokedAt: expect.any(String),
      fulfilledAt: expect.any(String),
""",
    1,
)
replace(
    "src/integration/plugin-orchestrator-review-content.test.ts",
    """    expect(invocation?.invocationId).toBe(obligation?.invocationId);
    const parsed = JSON.parse(output.output) as Record<string, unknown>;
""",
    """    expect(invocation?.invocationId).toBe(obligation?.invocationId);
    expect(Date.parse(invocation!.invokedAt)).toBeLessThanOrEqual(
      Date.parse(invocation!.fulfilledAt!),
    );
    expect(state.reviewAssurance?.attempts[0]).toMatchObject({
      attemptId: ATTEMPT_ID,
      status: 'bound',
      childSessionId: CHILD_SESSION_ID,
    });
    const parsed = JSON.parse(output.output) as Record<string, unknown>;
""",
    1,
)
'''

p.write_text(s + extra)

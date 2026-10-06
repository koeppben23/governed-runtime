/**
 * @module cli/claude-code-plugin-install
 * @description Claude Code plugin tree installer.
 */

import { chmod, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CliInstallError } from './errors.js';
import type { FileOp } from './install-types.js';
import { writeIfAbsent } from './install-helpers.js';
import type { InstallMutationSink } from './install-mutation-types.js';
import {
  CLAUDE_CODE_PLUGIN_DIR,
  CLAUDE_CODE_PLUGIN_RELATIVE_FILES,
  claudeCodePluginFiles,
} from './templates.js';

export function resolveClaudeCodePluginRoot(target: string): string {
  return join(target, CLAUDE_CODE_PLUGIN_DIR);
}

export function claudeCodePluginSnapshotPaths(target: string): string[] {
  const pluginRoot = resolveClaudeCodePluginRoot(target);
  return [
    join(pluginRoot, 'INSTALL.md'),
    ...CLAUDE_CODE_PLUGIN_RELATIVE_FILES.map((relativePath) => join(pluginRoot, relativePath)),
  ];
}

/** Every plugin file the installer writes via writeIfAbsent for this target. */
export function claudeCodePluginFilePaths(target: string): string[] {
  const pluginRoot = resolveClaudeCodePluginRoot(target);
  return CLAUDE_CODE_PLUGIN_RELATIVE_FILES.map((relativePath) => join(pluginRoot, relativePath));
}

export async function installClaudeCodePlugin(
  target: string,
  version: string,
  force: boolean,
  mutations: InstallMutationSink,
): Promise<FileOp[]> {
  const pluginRoot = resolveClaudeCodePluginRoot(target);
  const ops: FileOp[] = [];

  await mutations.ensureDir(pluginRoot);

  for (const [relativePath, content] of Object.entries(claudeCodePluginFiles(version))) {
    const filePath = join(pluginRoot, relativePath);
    await mutations.ensureDir(dirname(filePath));
    const op = await writeIfAbsent(filePath, content, force);
    if (op.action === 'skipped') {
      throw new CliInstallError(
        'NON_OPENCODE_ARTIFACT_EXISTS',
        `Plugin artifact already exists at ${filePath}; it appeared after the install preflight. Remove or rename it and retry, or run uninstall first.`,
      );
    }
    ops.push(op);
    await mutations.recordFile(filePath);

    if (relativePath.startsWith('dist/') && ops[ops.length - 1]?.action === 'written') {
      await chmod(filePath, 0o755);
    }
  }

  return ops;
}

export function claudeCodePluginInstallHint(target: string): string {
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

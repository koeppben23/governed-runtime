/**
 * @module cli/claude-code-plugin-install
 * @description Claude Code plugin tree installer.
 */

import { chmod, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FileOp } from './install-helpers.js';
import { ensureDir, writeIfAbsent } from './install-helpers.js';
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
    pluginRoot,
    join(pluginRoot, 'INSTALL.md'),
    ...CLAUDE_CODE_PLUGIN_RELATIVE_FILES.map((relativePath) => join(pluginRoot, relativePath)),
  ];
}

export async function installClaudeCodePlugin(
  target: string,
  version: string,
  force: boolean,
): Promise<FileOp[]> {
  const pluginRoot = resolveClaudeCodePluginRoot(target);
  const ops: FileOp[] = [];

  await ensureDir(pluginRoot);

  for (const [relativePath, content] of Object.entries(claudeCodePluginFiles(version))) {
    const filePath = join(pluginRoot, relativePath);
    await ensureDir(dirname(filePath));
    ops.push(await writeIfAbsent(filePath, content, force));

    if (relativePath.startsWith('dist/') && ops[ops.length - 1]?.action === 'written') {
      await chmod(filePath, 0o755);
    }
  }

  return ops;
}

export async function writeClaudeCodePluginInstallHint(target: string): Promise<FileOp> {
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

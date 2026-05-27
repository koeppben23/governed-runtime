import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CLAUDE_CODE_PLUGIN_RELATIVE_FILES,
  claudeCodeHooksJson,
  claudeCodeMcpJson,
  claudeCodePluginFiles,
  claudeCodePluginManifest,
} from './claude-code-plugin.js';

describe('Claude Code plugin templates', () => {
  it('renders a plugin manifest using documented Claude Code fields', () => {
    const manifest = JSON.parse(claudeCodePluginManifest('1.2.3'));

    expect(manifest).toMatchObject({
      name: 'flowguard',
      displayName: 'FlowGuard Governance',
      version: '1.2.3',
      skills: './skills/',
      hooks: './hooks/hooks.json',
      mcpServers: './.mcp.json',
    });
    expect(manifest.interface).toBeUndefined();
  });

  it('renders hook config in exec form with FlowGuard matchers', () => {
    const hooks = JSON.parse(claudeCodeHooksJson());
    const preHook = hooks.hooks.PreToolUse[0].hooks[0];
    const postMatcher = hooks.hooks.PostToolUse[0].matcher;

    expect(hooks.hooks.PreToolUse[0].matcher).toBe('Bash|Edit|Write|apply_patch');
    expect(preHook.command).toBe('node');
    expect(preHook.args).toEqual(['${CLAUDE_PLUGIN_ROOT}/dist/hooks/pre-tool-use.js']);
    expect(preHook.command).not.toContain('${CLAUDE_PLUGIN_ROOT}');
    expect(postMatcher).toBe('Bash|Edit|Write|apply_patch|mcp__flowguard__.*');
  });

  it('renders MCP config for the existing FlowGuard MCP server', () => {
    const config = JSON.parse(claudeCodeMcpJson());
    const server = config.mcpServers.flowguard;

    expect(server.command).toBe('node');
    expect(server.args).toEqual(['${CLAUDE_PLUGIN_ROOT}/dist/mcp-server.js']);
    expect(server.env.FLOWGUARD_PROJECT_DIR).toBe('${CLAUDE_PROJECT_DIR}');
    expect(server.env.FLOWGUARD_HOST_PLATFORM).toBe('claude-code');
  });

  it('contains every declared plugin file and no OpenCode-specific package dependency', () => {
    const files = claudeCodePluginFiles('1.2.3');

    for (const relativePath of CLAUDE_CODE_PLUGIN_RELATIVE_FILES) {
      expect(files[relativePath], relativePath).toBeDefined();
    }
    expect(JSON.stringify(files)).not.toContain('@opencode-ai/plugin');
  });

  it('keeps reviewer as transport-only and skills as MCP guidance', () => {
    const files = claudeCodePluginFiles('1.2.3');

    expect(files['agents/flowguard-reviewer.md']).toContain('transport/isolation artifacts only');
    expect(files['agents/flowguard-reviewer.md']).toContain(
      'validated, obligation-bound ReviewFindings',
    );
    expect(files['skills/plan/SKILL.md']).toContain('mcp__flowguard__flowguard_plan');
    expect(files['skills/plan/SKILL.md']).toContain(
      'Do not interpret FlowGuard phase or policy state yourself',
    );
  });

  it('pre-tool wrapper denies when the runtime hook target is unreachable', () => {
    const files = claudeCodePluginFiles('1.2.3');
    const wrapper = files['dist/hooks/pre-tool-use.js'];

    expect(wrapper).toContain('FLOWGUARD_HOOK_UNREACHABLE');
    expect(wrapper).toContain("permissionDecision: 'deny'");
    expect(wrapper).toContain("hookEventName: 'PreToolUse'");
  });

  it('renders CommonJS-parseable JavaScript wrappers', async () => {
    const files = claudeCodePluginFiles('1.2.3');
    const pluginRoot = await mkdtemp(join(tmpdir(), 'flowguard-claude-plugin-'));
    const wrapperPaths = Object.keys(files).filter((relativePath) =>
      relativePath.startsWith('dist/'),
    );

    for (const relativePath of wrapperPaths) {
      const filePath = join(pluginRoot, relativePath);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, files[relativePath] ?? '', 'utf-8');

      expect(() => execFileSync(process.execPath, ['--check', filePath])).not.toThrow();
    }
  });

  it('executes the PreToolUse wrapper as CommonJS and denies when target is missing', async () => {
    const files = claudeCodePluginFiles('1.2.3');
    const pluginRoot = await mkdtemp(join(tmpdir(), 'flowguard-claude-plugin-'));
    const filePath = join(pluginRoot, 'dist/hooks/pre-tool-use.js');
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, files['dist/hooks/pre-tool-use.js'] ?? '', 'utf-8');

    const stdout = execFileSync(process.execPath, [filePath], { encoding: 'utf-8' });
    const parsed = JSON.parse(stdout);

    expect(parsed.hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
    });
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain(
      'FLOWGUARD_HOOK_UNREACHABLE',
    );
  });
});

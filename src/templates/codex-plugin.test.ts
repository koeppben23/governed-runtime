import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CODEX_PLUGIN_RELATIVE_FILES,
  codexHooksJson,
  codexMcpJson,
  codexPluginFiles,
  codexPluginManifest,
} from './codex-plugin.js';
import { isHostToolAllowedInPhase } from '../hooks/shared/phase-gate.js';

describe('Codex plugin templates', () => {
  it('renders a plugin manifest without duplicate governance authority fields', () => {
    const manifest = JSON.parse(codexPluginManifest('1.2.3'));

    expect(manifest).toMatchObject({
      name: 'flowguard',
      displayName: 'FlowGuard Governance',
      version: '1.2.3',
      skills: './skills/',
      hooks: './hooks/hooks.json',
      mcpServers: './.mcp.json',
    });
    expect(manifest.Trust).toBeUndefined();
    expect(manifest.Governance).toBeUndefined();
    expect(manifest.Compliance).toBeUndefined();
  });

  it('renders Codex hook config with fail-closed PreToolUse wiring', () => {
    const hooks = JSON.parse(codexHooksJson());
    const preHook = hooks.hooks.PreToolUse[0].hooks[0];

    expect(hooks.hooks.PreToolUse[0].matcher).toBe('^Bash$|^apply_patch$');
    expect(preHook.command).toBe('node ${PLUGIN_ROOT}/dist/hooks/pre-tool-use.js');
    expect(preHook.args).toBeUndefined();
    expect(hooks.hooks.PostToolUse[0].matcher).toBe('^Bash$|^apply_patch$|^mcp__flowguard__.*$');

    for (const event of ['PreToolUse', 'PostToolUse', 'SessionStart', 'Stop'] as const) {
      const entries = hooks.hooks[event];
      if (!entries) continue;
      for (const entry of entries) {
        for (const hook of entry.hooks) {
          expect(hook.command).toBeDefined();
          expect(hook.args).toBeUndefined();
        }
      }
    }
  });

  it('renders MCP config for the existing FlowGuard MCP server', () => {
    const config = JSON.parse(codexMcpJson());
    const server = config.mcpServers.flowguard;

    expect(server.command).toBe('node');
    expect(server.args).toEqual(['${PLUGIN_ROOT}/dist/mcp-server.js']);
    expect(server.env.FLOWGUARD_PROJECT_DIR).toBeUndefined();
    expect(server.env.FLOWGUARD_HOST_PLATFORM).toBe('codex');
  });

  it('contains every declared plugin file and Codex guidance surfaces', () => {
    const files = codexPluginFiles('1.2.3');

    for (const relativePath of CODEX_PLUGIN_RELATIVE_FILES) {
      expect(files[relativePath], relativePath).toBeDefined();
    }
    expect(files['AGENTS.md']).toContain('not a second FlowGuard governance authority');
    expect(files['subagents/flowguard-reviewer.md']).toContain(
      'validated, obligation-bound ReviewFindings',
    );
    expect(files['skills/plan/SKILL.md']).toContain('mcp__flowguard__flowguard_plan');
  });

  it('pre-tool wrapper denies with Codex-compatible hookSpecificOutput when unreachable', async () => {
    const files = codexPluginFiles('1.2.3');
    const pluginRoot = await mkdtemp(join(tmpdir(), 'flowguard-codex-plugin-'));
    const filePath = join(pluginRoot, 'dist/hooks/pre-tool-use.js');
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, files['dist/hooks/pre-tool-use.js'] ?? '', 'utf-8');

    const stdout = execFileSync(process.execPath, [filePath], { encoding: 'utf-8' });
    const parsed = JSON.parse(stdout);

    expect(parsed).not.toHaveProperty('continue');
    expect(parsed.hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
    });
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain(
      'FLOWGUARD_HOOK_UNREACHABLE',
    );
  });

  it('renders CommonJS-parseable JavaScript wrappers', async () => {
    const files = codexPluginFiles('1.2.3');
    const pluginRoot = await mkdtemp(join(tmpdir(), 'flowguard-codex-plugin-'));
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

  it('delegates wrappers only to existing FlowGuard entrypoints', () => {
    const files = codexPluginFiles('1.2.3');

    expect(files['dist/mcp-server.js']).toContain('@flowguard/core/dist/mcp-server/index.js');
    expect(files['dist/hooks/pre-tool-use.js']).toContain(
      '@flowguard/core/dist/hooks/pre-tool-use.js',
    );
    expect(files['dist/hooks/post-tool-use.js']).toContain(
      '@flowguard/core/dist/hooks/post-tool-use.js',
    );

    for (const relativePath of Object.keys(files).filter((path) => path.startsWith('dist/'))) {
      const content = files[relativePath] ?? '';
      expect(content).not.toContain('isHostToolAllowedInPhase');
      expect(content).not.toContain('MUTATING_HOST_TOOLS');
      expect(content).not.toContain('registerTool');
      expect(content).not.toContain('policy.defaultMode');
    }
  });

  it('uses the existing FlowGuard gate for Codex PreToolUse Bash and apply_patch', () => {
    expect(isHostToolAllowedInPhase('bash', 'TICKET').allowed).toBe(false);
    expect(isHostToolAllowedInPhase('apply_patch', 'PLAN').allowed).toBe(false);
    expect(isHostToolAllowedInPhase('bash', 'IMPLEMENTATION').allowed).toBe(true);
    expect(isHostToolAllowedInPhase('apply_patch', 'IMPLEMENTATION').allowed).toBe(true);
  });

  it('keeps PostToolUse audit-only and does not claim prevention or rollback', () => {
    const files = codexPluginFiles('1.2.3');
    const hooks = JSON.parse(files['hooks/hooks.json'] ?? '{}');
    const postHook = hooks.hooks.PostToolUse[0].hooks[0];

    expect(postHook.command).toBe('node ${PLUGIN_ROOT}/dist/hooks/post-tool-use.js');
    expect(files['AGENTS.md']).toContain('PostToolUse may audit, contextualize');
    expect(files['AGENTS.md']).toContain('must not claim mutation prevention or rollback');
    expect(files['dist/hooks/post-tool-use.js']).not.toContain('permissionDecision');
    expect(files['dist/hooks/post-tool-use.js']).not.toContain('rollback');
  });
});

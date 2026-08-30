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
      mcpServers: './.mcp.json',
    });
    expect(manifest.interface).toBeUndefined();
    // Regression: hooks/hooks.json is auto-discovered at its default location.
    // Declaring it in the manifest triggers Claude Code's duplicate-hooks load
    // error, so the manifest must NOT reference it.
    expect(manifest.hooks).toBeUndefined();
    // Regression: agents/flowguard-reviewer.md is auto-discovered at its
    // default location. Declaring an `agents` key silently drops the agent
    // (Agents (0)), so the manifest must NOT reference it.
    expect(manifest.agents).toBeUndefined();
    // Structural: ObjectLiteral mutant guard — author object must have 'name'.
    expect(manifest.author).toEqual({ name: 'FlowGuard' });
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

  it('every hook slot in hooks config has the expected exec-form structure', () => {
    const hooks = JSON.parse(claudeCodeHooksJson());

    // PostToolUse — matcher + hook object
    const post = hooks.hooks.PostToolUse[0];
    expect(post.matcher).toBe('Bash|Edit|Write|apply_patch|mcp__flowguard__.*');
    expect(post.hooks[0]).toMatchObject({
      type: 'command',
      command: 'node',
      args: ['${CLAUDE_PLUGIN_ROOT}/dist/hooks/post-tool-use.js'],
      timeout: 30,
    });

    // SessionStart — matcher + hook object with statusMessage, no timeout
    const sstart = hooks.hooks.SessionStart[0];
    expect(sstart.matcher).toBe('startup');
    expect(sstart.hooks[0]).toMatchObject({
      type: 'command',
      command: 'node',
      args: ['${CLAUDE_PLUGIN_ROOT}/dist/hooks/session-start.js'],
      statusMessage: 'FlowGuard: initializing session',
    });

    // Stop — no matcher, has timeout
    const stop = hooks.hooks.Stop[0];
    expect(stop.matcher).toBeUndefined();
    expect(stop.hooks[0]).toMatchObject({
      type: 'command',
      command: 'node',
      args: ['${CLAUDE_PLUGIN_ROOT}/dist/hooks/stop.js'],
      timeout: 15,
    });

    // SubagentStop — no matcher, has timeout
    const subStop = hooks.hooks.SubagentStop[0];
    expect(subStop.matcher).toBeUndefined();
    expect(subStop.hooks[0]).toMatchObject({
      type: 'command',
      command: 'node',
      args: ['${CLAUDE_PLUGIN_ROOT}/dist/hooks/subagent-stop.js'],
      timeout: 15,
    });
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

  it('host-task verdict-only parity: review-loop skills forbid reviewFindings (not even a placeholder)', () => {
    const files = claudeCodePluginFiles('1.2.3');

    // The shared review-loop (plan/architecture/implement) must instruct
    // verdict-only submission in host-task mode, matching the runtime that
    // resolves findings from captured evidence and ignores submitted findings.
    for (const skill of [
      'skills/plan/SKILL.md',
      'skills/architecture/SKILL.md',
      'skills/implement/SKILL.md',
    ]) {
      expect(files[skill], skill).toContain('submit ONLY `reviewVerdict`');
      expect(files[skill], skill).toContain('not even an empty placeholder object');
    }
  });

  it('auto-continuation parity: implement skill records the negative verdict FIRST and continues the repair loop without intermediate cards', () => {
    const files = claudeCodePluginFiles('1.2.3');
    const implementSkill = files['skills/implement/SKILL.md'];
    const planSkill = files['skills/plan/SKILL.md'];

    // Implementation: the negative verdict is recorded before any edits
    // (verdict and record are separate single-purpose tools)...
    expect(implementSkill).toContain('do NOT edit any files before FlowGuard records it');
    // ...then the loop continues automatically through the repair-recheck cycle.
    expect(implementSkill).toContain(
      'call `mcp__flowguard__flowguard_implement` again to re-record',
    );
    expect(implementSkill).toContain('no intermediate presentation card');
    expect(implementSkill).toContain('never stop for user input between iterations');
    // Plan/architecture keep the revise-and-resubmit ordering (no verdict-first
    // preamble) so the adapter loop stays aligned with each artifact's contract.
    expect(planSkill).not.toContain('do NOT edit any files before FlowGuard records it');
  });

  it('host-task verdict-only parity: standalone /review skill has a host-task verdict-only branch', () => {
    const files = claudeCodePluginFiles('1.2.3');
    const reviewSkill = files['skills/review/SKILL.md'];

    // Host-task branch: verdict only, no reviewFindings.
    expect(reviewSkill).toContain('Host-task mode');
    expect(reviewSkill).toContain(
      '`reviewObligationId` from `requiredReviewAttestation.toolObligationId`',
    );
    expect(reviewSkill).toContain('Do NOT submit `reviewFindings`, not even an empty placeholder');
    // SDK/manual branch is preserved but now conditional.
    expect(reviewSkill).toContain('SDK/manual mode only');
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

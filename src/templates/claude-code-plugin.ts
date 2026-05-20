import { CLAUDE_REVIEWER_AGENT } from './mandates.js';

export const CLAUDE_CODE_PLUGIN_DIR = 'flowguard-plugin';

export const CLAUDE_CODE_PLUGIN_RELATIVE_FILES = [
  '.claude-plugin/plugin.json',
  'skills/start/SKILL.md',
  'skills/plan/SKILL.md',
  'skills/implement/SKILL.md',
  'agents/flowguard-reviewer.md',
  'hooks/hooks.json',
  '.mcp.json',
  'settings.json',
  'dist/mcp-server.js',
  'dist/hooks/pre-tool-use.js',
  'dist/hooks/post-tool-use.js',
  'dist/hooks/session-start.js',
  'dist/hooks/stop.js',
] as const;

const WRAPPER_RUNTIME = '../../node_modules/@flowguard/core/dist/';
const HOOK_WRAPPER_RUNTIME = '../../../node_modules/@flowguard/core/dist/hooks/';

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

function executableWrapper(target: string): string {
  return (
    `#!/usr/bin/env node
import('${target}').catch((err) => {
  const reason = err instanceof Error ? err.message : String(err);
  process.stderr.write(` +
    '`FLOWGUARD_WRAPPER_UNREACHABLE: ${reason}\n`' +
    `);
  process.exitCode = 1;
});
`
  );
}

function failClosedPreToolUseWrapper(target: string): string {
  return (
    `#!/usr/bin/env node
const { access } = require('node:fs/promises');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const wrapperDir = __dirname;
const targetPath = resolve(wrapperDir, '${target}');

async function main() {
  try {
    await access(targetPath);
    await import(pathToFileURL(targetPath).href);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: ` +
    '`FLOWGUARD_HOOK_UNREACHABLE: ${reason}`' +
    `,
      },
    }) + '\\n');
  }
}

void main();
`
  );
}

export function claudeCodePluginManifest(version: string): string {
  return json({
    name: 'flowguard',
    displayName: 'FlowGuard Governance',
    description: 'Deterministic, fail-closed governance runtime for AI-assisted software delivery',
    version,
    author: { name: 'FlowGuard' },
    skills: './skills/',
    agents: ['./agents/flowguard-reviewer.md'],
    hooks: './hooks/hooks.json',
    mcpServers: './.mcp.json',
    keywords: ['governance', 'audit', 'workflow'],
  });
}

export function claudeCodeHooksJson(): string {
  return json({
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash|Edit|Write',
          hooks: [
            {
              type: 'command',
              command: 'node',
              args: ['${CLAUDE_PLUGIN_ROOT}/dist/hooks/pre-tool-use.js'],
              timeout: 10,
              statusMessage: 'FlowGuard: checking phase gate',
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: 'Bash|Edit|Write|mcp__flowguard__.*',
          hooks: [
            {
              type: 'command',
              command: 'node',
              args: ['${CLAUDE_PLUGIN_ROOT}/dist/hooks/post-tool-use.js'],
              timeout: 30,
              statusMessage: 'FlowGuard: recording audit',
            },
          ],
        },
      ],
      SessionStart: [
        {
          matcher: 'startup',
          hooks: [
            {
              type: 'command',
              command: 'node',
              args: ['${CLAUDE_PLUGIN_ROOT}/dist/hooks/session-start.js'],
              statusMessage: 'FlowGuard: initializing session',
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: 'node',
              args: ['${CLAUDE_PLUGIN_ROOT}/dist/hooks/stop.js'],
              timeout: 15,
              statusMessage: 'FlowGuard: session checkpoint',
            },
          ],
        },
      ],
    },
  });
}

export function claudeCodeMcpJson(): string {
  return json({
    mcpServers: {
      flowguard: {
        command: 'node',
        args: ['${CLAUDE_PLUGIN_ROOT}/dist/mcp-server.js'],
        env: {
          FLOWGUARD_PROJECT_DIR: '${CLAUDE_PROJECT_DIR}',
          FLOWGUARD_HOST_PLATFORM: 'claude-code',
        },
      },
    },
  });
}

export const CLAUDE_CODE_PLUGIN_SETTINGS = json({});

export const CLAUDE_CODE_PLUGIN_SKILLS = {
  'skills/start/SKILL.md': `---
description: Start or resume a governed FlowGuard session through the FlowGuard MCP server.
---

# FlowGuard Start

Use the existing FlowGuard MCP tools. Do not infer or mutate FlowGuard state yourself.

1. Call \`mcp__flowguard__flowguard_hydrate\` with no arguments.
2. Report the returned phase label, session id when present, and next action.
3. If the tool returns a blocked or failed result, report the exact blocker and stop.

Do not use Bash, Edit, or Write in this skill.
`,
  'skills/plan/SKILL.md': `---
description: Submit a governed implementation plan through FlowGuard MCP tools.
---

# FlowGuard Plan

Use the existing FlowGuard MCP tools. Do not interpret FlowGuard phase or policy state yourself.

1. Ensure a session exists by calling \`mcp__flowguard__flowguard_status\` or hydrate if needed.
2. Submit the plan only through \`mcp__flowguard__flowguard_plan\`.
3. Treat any blocked, failed, malformed, or nonconforming tool result as terminal.
4. Do not start implementation until FlowGuard returns an explicit allowed path.

Do not use Bash, Edit, or Write in this skill.
`,
  'skills/implement/SKILL.md': `---
description: Begin governed implementation only after FlowGuard allows implementation.
---

# FlowGuard Implement

Use the existing FlowGuard MCP tools. Do not interpret FlowGuard phase or policy state yourself.

1. Call \`mcp__flowguard__flowguard_status\` to obtain the runtime-provided next action.
2. Call \`mcp__flowguard__flowguard_implement\` only with the evidence required by the tool.
3. If FlowGuard blocks, fails, or requests review evidence, report the exact blocker and stop.
4. Use mutating host tools only after FlowGuard explicitly allows implementation.
`,
} as const;

export function claudeCodePluginFiles(version: string): Record<string, string> {
  return {
    '.claude-plugin/plugin.json': claudeCodePluginManifest(version),
    ...CLAUDE_CODE_PLUGIN_SKILLS,
    'agents/flowguard-reviewer.md': CLAUDE_REVIEWER_AGENT,
    'hooks/hooks.json': claudeCodeHooksJson(),
    '.mcp.json': claudeCodeMcpJson(),
    'settings.json': CLAUDE_CODE_PLUGIN_SETTINGS,
    'dist/mcp-server.js': executableWrapper(`${WRAPPER_RUNTIME}mcp-server/index.js`),
    'dist/hooks/pre-tool-use.js': failClosedPreToolUseWrapper(
      `${HOOK_WRAPPER_RUNTIME}pre-tool-use.js`,
    ),
    'dist/hooks/post-tool-use.js': executableWrapper(`${HOOK_WRAPPER_RUNTIME}post-tool-use.js`),
    'dist/hooks/session-start.js': executableWrapper(`${HOOK_WRAPPER_RUNTIME}session-start.js`),
    'dist/hooks/stop.js': executableWrapper(`${HOOK_WRAPPER_RUNTIME}stop.js`),
  };
}

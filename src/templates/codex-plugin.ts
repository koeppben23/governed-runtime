import { CODEX_REVIEWER_SUBAGENT } from './mandates.js';

export const CODEX_PLUGIN_NAME = 'flowguard';

export const CODEX_PLUGIN_RELATIVE_FILES = [
  '.codex-plugin/plugin.json',
  'skills/start/SKILL.md',
  'skills/plan/SKILL.md',
  'skills/implement/SKILL.md',
  'subagents/flowguard-reviewer.md',
  'hooks/hooks.json',
  '.mcp.json',
  'AGENTS.md',
  'dist/mcp-server.js',
  'dist/hooks/pre-tool-use.js',
  'dist/hooks/post-tool-use.js',
  'dist/hooks/session-start.js',
  'dist/hooks/stop.js',
] as const;

const MCP_WRAPPER_RUNTIME = '../node_modules/@flowguard/core/dist/mcp-server/index.js';
const HOOK_WRAPPER_RUNTIME = '../../node_modules/@flowguard/core/dist/hooks/';

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

function executableWrapper(target: string): string {
  return (
    `#!/usr/bin/env node
const { access } = require('node:fs/promises');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const targetPath = resolve(__dirname, '${target}');

async function main() {
  try {
    await access(targetPath);
    await import(pathToFileURL(targetPath).href);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(` +
    '`FLOWGUARD_WRAPPER_UNREACHABLE: ${reason}\n`' +
    `);
    process.exitCode = 1;
  }
}

void main();
`
  );
}

function failClosedPreToolUseWrapper(target: string): string {
  return (
    `#!/usr/bin/env node
const { access } = require('node:fs/promises');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const targetPath = resolve(__dirname, '${target}');

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

export function codexPluginManifest(version: string): string {
  return json({
    name: CODEX_PLUGIN_NAME,
    displayName: 'FlowGuard Governance',
    description: 'Deterministic, fail-closed governance runtime for AI-assisted software delivery',
    version,
    skills: './skills/',
    subagents: ['./subagents/flowguard-reviewer.md'],
    hooks: './hooks/hooks.json',
    mcpServers: './.mcp.json',
  });
}

export function codexHooksJson(): string {
  return json({
    hooks: {
      PreToolUse: [
        {
          matcher: '^Bash$|^apply_patch$',
          hooks: [
            {
              type: 'command',
              command: 'node ${PLUGIN_ROOT}/dist/hooks/pre-tool-use.js',
              timeout: 10,
              statusMessage: 'FlowGuard: checking phase gate',
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: '^Bash$|^apply_patch$|^mcp__flowguard__.*$',
          hooks: [
            {
              type: 'command',
              command: 'node ${PLUGIN_ROOT}/dist/hooks/post-tool-use.js',
              timeout: 30,
              statusMessage: 'FlowGuard: recording audit',
            },
          ],
        },
      ],
      SessionStart: [
        {
          matcher: 'startup|resume|clear',
          hooks: [
            {
              type: 'command',
              command: 'node ${PLUGIN_ROOT}/dist/hooks/session-start.js',
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
              command: 'node ${PLUGIN_ROOT}/dist/hooks/stop.js',
              timeout: 15,
              statusMessage: 'FlowGuard: session checkpoint',
            },
          ],
        },
      ],
    },
  });
}

export function codexMcpJson(): string {
  return json({
    mcpServers: {
      flowguard: {
        command: 'node',
        args: ['${PLUGIN_ROOT}/dist/mcp-server.js'],
        env: {
          FLOWGUARD_HOST_PLATFORM: 'codex',
        },
      },
    },
  });
}

export const CODEX_PLUGIN_SKILLS = {
  'skills/start/SKILL.md': `---
description: Start or resume a governed FlowGuard session through the FlowGuard MCP server.
---

# FlowGuard Start

Use the existing FlowGuard MCP tools. Do not infer or mutate FlowGuard state yourself.

1. Call \`mcp__flowguard__flowguard_hydrate\` with no arguments.
2. Report the returned phase label, session id when present, and next action.
3. If the tool returns a blocked or failed result, report the exact blocker and stop.

Do not use Bash or apply_patch in this skill.
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

Do not use Bash or apply_patch in this skill.
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

export const CODEX_PLUGIN_AGENTS_MD = `# FlowGuard Codex Plugin

This plugin is an instruction, MCP, hook, and packaging adapter for Codex.
It is not a second FlowGuard governance authority.

- FlowGuard MCP tools, hooks, state, policy, audit, and review-evidence binding remain authoritative.
- Plugin skills, subagents, AGENTS.md, hooks config, and MCP config are derived integration surfaces.
- PreToolUse is a guardrail and must fail closed if the FlowGuard hook cannot be reached.
- PostToolUse may audit, contextualize, or mark continuation only; it must not claim mutation prevention or rollback.
- Do not claim native Codex plugin load or hook enforcement unless Codex loaded this plugin and plugin hooks are explicitly trusted.
`;

export function codexPluginFiles(version: string): Record<string, string> {
  return {
    '.codex-plugin/plugin.json': codexPluginManifest(version),
    ...CODEX_PLUGIN_SKILLS,
    'subagents/flowguard-reviewer.md': CODEX_REVIEWER_SUBAGENT,
    'hooks/hooks.json': codexHooksJson(),
    '.mcp.json': codexMcpJson(),
    'AGENTS.md': CODEX_PLUGIN_AGENTS_MD,
    'dist/mcp-server.js': executableWrapper(MCP_WRAPPER_RUNTIME),
    'dist/hooks/pre-tool-use.js': failClosedPreToolUseWrapper(
      `${HOOK_WRAPPER_RUNTIME}pre-tool-use.js`,
    ),
    'dist/hooks/post-tool-use.js': executableWrapper(`${HOOK_WRAPPER_RUNTIME}post-tool-use.js`),
    'dist/hooks/session-start.js': executableWrapper(`${HOOK_WRAPPER_RUNTIME}session-start.js`),
    'dist/hooks/stop.js': executableWrapper(`${HOOK_WRAPPER_RUNTIME}stop.js`),
  };
}

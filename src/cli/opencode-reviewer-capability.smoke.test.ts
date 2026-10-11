/**
 * @module cli/opencode-reviewer-capability.smoke.test
 * @description OpenCode host-parser smoke contract for reviewer capability isolation.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REVIEWER_AGENT } from '../templates/mandates.js';
import { TESTED_OPENCODE_HOST_VERSION } from './opencode-runtime-compat.js';
import {
  createIsolatedOpenCodeEnvironment,
  resolvePinnedOpenCodeHost,
  type PinnedOpenCodeHost,
} from './opencode-live-host.js';

// Cold OpenCode startup on shared CI runners can exceed the interactive budget.
const EXEC_TIMEOUT_MS = 45_000;

let tmpRoot: string;
let host: PinnedOpenCodeHost;
let hostEnv: NodeJS.ProcessEnv;

function debugReviewer(args: string[] = []): string {
  return execFileSync(
    host.command,
    [...host.argsPrefix, 'debug', 'agent', 'flowguard-reviewer', ...args],
    {
      cwd: tmpRoot,
      env: hostEnv,
      encoding: 'utf8',
      timeout: EXEC_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

function debugTool(toolName: string): string {
  try {
    return debugReviewer(['--tool', toolName, '--params', '{}']);
  } catch (error) {
    // Only a real CLI denial is an assertion input. Startup timeouts and
    // other process failures must surface as failures, never as tool results.
    if (error instanceof Error && 'status' in error && error.status === 1 && 'stderr' in error) {
      return String(error.stderr);
    }
    throw error;
  }
}

describe('OpenCode reviewer capability contract', () => {
  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-opencode-reviewer-'));
    host = resolvePinnedOpenCodeHost({
      package: 'opencode-ai',
      version: TESTED_OPENCODE_HOST_VERSION,
    });
    hostEnv = createIsolatedOpenCodeEnvironment(tmpRoot, host);
    hostEnv.OPENCODE_DISABLE_DEFAULT_PLUGINS = '1';
    const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
    // The pinned host checks each config directory's dependency graph before
    // loading custom tools. Reuse the actual npm-ci graph, not a fresh network
    // install on every CLI invocation; both package files are copied verbatim.
    for (const dir of [path.join(tmpRoot, '.opencode'), hostEnv.OPENCODE_CONFIG_DIR!]) {
      await fs.mkdir(dir, { recursive: true });
      for (const file of ['package.json', 'package-lock.json']) {
        await fs.copyFile(path.join(repoRoot, file), path.join(dir, file));
      }
      await fs.symlink(
        path.join(repoRoot, 'node_modules'),
        path.join(dir, 'node_modules'),
        'junction',
      );
    }
    const agentPath = path.join(tmpRoot, '.opencode', 'agents', 'flowguard-reviewer.md');
    await fs.mkdir(path.dirname(agentPath), { recursive: true });
    await fs.writeFile(agentPath, REVIEWER_AGENT, 'utf8');
    const toolsDir = path.join(tmpRoot, '.opencode', 'tools');
    await fs.mkdir(toolsDir, { recursive: true });
    const tool = `export default {
  description: 'Capability test tool',
  args: {},
  execute: async () => 'executed',
};\n`;
    await fs.writeFile(path.join(toolsDir, 'flowguard_hydrate.ts'), tool, 'utf8');
    await fs.writeFile(path.join(toolsDir, 'flowguard_abort_session.ts'), tool, 'utf8');
    await fs.writeFile(path.join(toolsDir, 'mcp__flowguard__hydrate.ts'), tool, 'utf8');
    await fs.writeFile(path.join(toolsDir, 'flowguard_observe_repository.ts'), tool, 'utf8');
  });

  afterAll(async () => {
    if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('loads the installed reviewer with resolved FlowGuard deny rules', () => {
    const output = debugReviewer();

    const agent = JSON.parse(output) as {
      name: string;
      mode: string;
      permission: Array<{ permission: string; action: string; pattern: string }>;
      tools: Record<string, boolean>;
    };

    expect(agent.name).toBe('flowguard-reviewer');
    expect(agent.mode).toBe('subagent');
    expect(agent.permission).toEqual(
      expect.arrayContaining([
        { permission: 'flowguard_*', action: 'deny', pattern: '*' },
        { permission: 'mcp__flowguard__*', action: 'deny', pattern: '*' },
        { permission: 'task', action: 'deny', pattern: '*' },
        { permission: 'edit', action: 'deny', pattern: '*' },
        { permission: 'bash', action: 'deny', pattern: '*' },
        { permission: 'webfetch', action: 'deny', pattern: '*' },
      ]),
    );
    expect(agent.tools).toMatchObject({ read: true, glob: true, grep: true });
  });

  it('removes direct and MCP-prefixed FlowGuard tools from the reviewer', () => {
    expect(debugTool('flowguard_hydrate')).toContain('Tool flowguard_hydrate is disabled');
    expect(debugTool('flowguard_abort_session')).toContain(
      'Tool flowguard_abort_session is disabled',
    );
    expect(debugTool('mcp__flowguard__hydrate')).toContain(
      'Tool mcp__flowguard__hydrate is disabled',
    );
    expect(debugTool('task')).toContain('Tool task is disabled');
  });

  it('carves out the sanctioned observation tool from the deny rules', () => {
    // The frozen-repository-authority generation requires EXACTLY one
    // reviewer-callable FlowGuard tool: flowguard_observe_repository. The
    // explicit allow must override the generic flowguard_* deny entries.
    const direct = debugTool('flowguard_observe_repository');
    expect(JSON.parse(direct)).toMatchObject({
      tool: 'flowguard_observe_repository',
      result: { output: 'executed' },
    });
  });
});

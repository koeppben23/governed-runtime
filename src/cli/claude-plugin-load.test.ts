/**
 * @module cli/claude-plugin-load.test
 * @description Auth-free Claude Code plugin load-integrity smoke test.
 *
 * Run with: npm run test:claude-plugin-load
 *
 * Generates the FlowGuard Claude Code plugin directory from the canonical
 * template SSOT ({@link claudeCodePluginFiles}) and asks the real `claude`
 * CLI to load it via `--plugin-dir`. This exercises Claude Code's manifest,
 * hook, and agent-frontmatter parsers without any authentication: both
 * `plugin list --json` and `plugin details` work while "Not logged in".
 *
 * Fail-closed regressions guarded here:
 *  - Defect 1 (hooks): a manifest `hooks` key pointing at the auto-discovered
 *    `hooks/hooks.json` triggers a "Duplicate hooks file detected" load error.
 *  - Defect 2 (agents): nested OpenCode `tools: { allow, deny }` agent
 *    frontmatter is unparseable by Claude Code, yielding `Agents (0)`.
 *
 * The test is a no-op skip when the `claude` CLI is not installed, so it is
 * CI-safe on hosts without Claude Code.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { claudeCodePluginFiles } from '../templates/claude-code-plugin.js';

const PLUGIN_VERSION = '1.2.0-load-test';
const EXEC_TIMEOUT_MS = 60_000;

function claudeAvailable(): boolean {
  try {
    execFileSync('claude', ['--version'], { stdio: 'pipe', timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

const CLAUDE_PRESENT = claudeAvailable();

interface PluginListEntry {
  id: string;
  version: string;
  errors?: string[];
}

let tmpRoot: string;
let pluginDir: string;

async function writePluginTree(version: string, dir: string): Promise<void> {
  const files = claudeCodePluginFiles(version);
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(dir, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, content, 'utf-8');
  }
}

function runClaude(args: string[]): string {
  return execFileSync('claude', ['--plugin-dir', pluginDir, ...args], {
    encoding: 'utf8',
    timeout: EXEC_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe.skipIf(!CLAUDE_PRESENT)('claude plugin load integrity (auth-free)', () => {
  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-cc-load-'));
    pluginDir = path.join(tmpRoot, 'flowguard-plugin');
    await writePluginTree(PLUGIN_VERSION, pluginDir);
  });

  afterAll(async () => {
    if (tmpRoot) {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('loads the plugin with zero load errors (Defect 1: duplicate hooks)', () => {
    const raw = runClaude(['plugin', 'list', '--json']);
    const entries = JSON.parse(raw) as PluginListEntry[];
    const flowguard = entries.find((e) => e.id.startsWith('flowguard'));

    expect(flowguard, `flowguard plugin not found in: ${raw}`).toBeDefined();
    expect(flowguard?.version).toBe(PLUGIN_VERSION);
    // Fail-closed: any load error (e.g. "Duplicate hooks file detected") is a
    // shipped-broken plugin and must block.
    expect(flowguard?.errors ?? []).toEqual([]);
  });

  it('loads the reviewer agent (Defect 2: agent frontmatter)', () => {
    const details = runClaude(['plugin', 'details', 'flowguard@inline']);
    const agentsMatch = details.match(/Agents \((\d+)\)/);

    expect(agentsMatch, `Agents inventory line not found in:\n${details}`).not.toBeNull();
    const agentCount = Number(agentsMatch?.[1]);
    // The flowguard-reviewer agent must load. Invalid frontmatter yields 0.
    expect(agentCount).toBeGreaterThanOrEqual(1);
  });

  it('exposes a collision-free skill set', () => {
    const details = runClaude(['plugin', 'details', 'flowguard@inline']);
    const skillsMatch = details.match(/Skills \((\d+)\)\s+([^\n]*)/);

    expect(skillsMatch, `Skills inventory line not found in:\n${details}`).not.toBeNull();
    const names = (skillsMatch?.[2] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    // No duplicate invocable names (the command/skill collision regression).
    expect(new Set(names).size).toBe(names.length);
  });
});

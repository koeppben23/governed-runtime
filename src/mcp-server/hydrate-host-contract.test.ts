/** Live MCP metadata must agree with installed Claude/Codex start skills. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, FLOWGUARD_TOOLS } from './server.js';
import {
  installClaudeCodePlugin,
  resolveClaudeCodePluginRoot,
} from '../cli/claude-code-plugin-install.js';
import { installCodexPlugin, resolveCodexPluginRoot } from '../cli/codex-plugin-install.js';
import type { InstallMutationSink } from '../cli/install-mutation-types.js';
import { setupCliTestEnvironment, tmpDir, VERSION } from '../cli/install-test-helpers.test.js';

describe('shared hydrate metadata and installed MCP host start contract', () => {
  setupCliTestEnvironment();
  let client: Client;
  let server: ReturnType<typeof createMcpServer>;
  let tools: Awaited<ReturnType<Client['listTools']>>['tools'];

  beforeAll(async () => {
    server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'hydrate-host-contract', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    tools = (await client.listTools()).tools;
  });

  afterAll(async () => {
    await client?.close();
    await server?.close();
  });

  it.each(['claude-code', 'codex'] as const)(
    '%s installs a direct hydrate start that the published MCP metadata permits',
    async (host) => {
      const recorded: string[] = [];
      const mutations: InstallMutationSink = {
        ensureDir: async (directory) => {
          await mkdir(directory, { recursive: true });
        },
        recordFile: (file) => {
          recorded.push(file);
        },
      };
      let pluginRoot: string;
      if (host === 'claude-code') {
        const target = join(tmpDir, '.claude');
        await installClaudeCodePlugin(target, VERSION, false, mutations);
        pluginRoot = resolveClaudeCodePluginRoot(target);
      } else {
        await installCodexPlugin('repo', VERSION, false, mutations);
        pluginRoot = resolveCodexPluginRoot('repo');
      }
      const skillPath = join(pluginRoot, 'skills/start/SKILL.md');
      expect(recorded).toContain(skillPath);
      const skill = await readFile(skillPath, 'utf8');
      expect(skill).toContain('1. Call `mcp__flowguard__flowguard_hydrate` with no arguments.');
      expect(skill.match(/mcp__flowguard__flowguard_\w+/g)).toEqual([
        'mcp__flowguard__flowguard_hydrate',
      ]);
      expect(skill).toContain('blocked or failed result');

      // Inspect real tools/list output, not a mocked registerTool callback.
      const metadata = tools.find((tool) => tool.name === 'flowguard_hydrate');
      expect(metadata).toBeDefined();
      expect(metadata?.description).toBe(FLOWGUARD_TOOLS.hydrate?.description);
      expect(metadata?.description).toContain('when no session exists');
      expect(metadata?.description).toContain('reload the existing bound session');
      expect(metadata?.description).toContain('host integration owns any separate activation');
      expect(metadata?.description).toContain(
        'Missing or damaged existing authority must not be recreated',
      );
      expect(metadata?.description).not.toMatch(
        /already authorized host path|Only.*Start|StartGovernance|direct hydrate cannot bootstrap/,
      );
      expect(metadata?.inputSchema.required ?? []).toEqual([]);
    },
  );
});

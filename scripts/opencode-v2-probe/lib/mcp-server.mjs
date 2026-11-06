#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const marker = process.env.FG_MCP_MARKER;
const server = new McpServer(
  { name: 'flowguard-probe-mcp', version: '0.0.0' },
  { capabilities: { tools: {} } },
);

server.tool(
  'echo',
  'Echo text and record that the MCP server was reached.',
  { text: z.string() },
  async ({ text }) => {
    if (marker) appendFileSync(marker, `called:${text}\n`);
    return { content: [{ type: 'text', text }] };
  },
);

await server.connect(new StdioServerTransport());

/**
 * @module templates/commands/host-adapt.test
 * @description Falsification-first guards for the build-time command projector.
 * Verifies cross-host command parity (basename set), Claude MCP-namespacing,
 * removal of OpenCode-only frontmatter, OpenCode byte-identical invariance, and
 * Codex fail-closed (no commands).
 */

import { describe, expect, it } from 'vitest';

import { COMMANDS } from './index.js';
import { commandsForPlatform, renderCommandForPlatform } from './host-adapt.js';

const COMMAND_BASENAMES = Object.keys(COMMANDS).sort();

describe('commandsForPlatform — parity set', () => {
  it('projects every FlowGuard command for claude-code under commands/<name>.md', () => {
    const projected = commandsForPlatform('claude-code');
    const basenames = Object.keys(projected)
      .map((p) => p.replace(/^commands\//, ''))
      .sort();
    expect(basenames).toEqual(COMMAND_BASENAMES);
    expect(Object.keys(projected).every((p) => p.startsWith('commands/'))).toBe(true);
    expect(basenames.length).toBe(20);
  });

  it('returns an empty map for codex (fail-closed: deprecated custom prompts)', () => {
    expect(commandsForPlatform('codex')).toEqual({});
  });

  it('returns an empty map for opencode (installed via the existing command path)', () => {
    expect(commandsForPlatform('opencode')).toEqual({});
  });
});

describe('renderCommandForPlatform — opencode invariance', () => {
  it('is byte-identical to the canonical source for every command', () => {
    for (const [, content] of Object.entries(COMMANDS)) {
      expect(renderCommandForPlatform(content, 'opencode')).toBe(content);
    }
  });
});

describe('renderCommandForPlatform — claude-code adaptation', () => {
  const claude = commandsForPlatform('claude-code');

  it('namespaces every bare flowguard_* tool token as an MCP tool', () => {
    for (const [path, body] of Object.entries(claude)) {
      const bareTokens = body.match(/(?<!mcp__flowguard__)\bflowguard_[a-z_]+\b/g) ?? [];
      expect(bareTokens, `bare flowguard_ token leaked in ${path}`).toEqual([]);
    }
  });

  it('produces well-formed mcp__flowguard__flowguard_* identifiers', () => {
    const status = claude['commands/status.md'];
    expect(status).toContain('mcp__flowguard__flowguard_status');
    expect(status).not.toContain('mcp__flowguard__mcp__flowguard__');
  });

  it('drops the OpenCode-only `agent: build` frontmatter line', () => {
    for (const [path, body] of Object.entries(claude)) {
      expect(body, `agent: build leaked in ${path}`).not.toMatch(/^[ \t]*agent: build/m);
    }
  });

  it('preserves the description frontmatter for commands that have it', () => {
    expect(claude['commands/review.md']).toMatch(/^description:/m);
  });

  it('maps the OpenCode webfetch primitive to Claude WebFetch', () => {
    expect(claude['commands/review.md']).not.toMatch(/\bwebfetch\b/);
    expect(claude['commands/review.md']).toContain('WebFetch');
  });

  it('retains the governance body (does not strip command content)', () => {
    expect(claude['commands/review.md']).toContain('FlowGuard');
    expect(claude['commands/review.md'].length).toBeGreaterThan(100);
  });

  it('is idempotent under repeated rendering', () => {
    for (const [, content] of Object.entries(COMMANDS)) {
      const once = renderCommandForPlatform(content, 'claude-code');
      const twice = renderCommandForPlatform(once, 'claude-code');
      expect(twice).toBe(once);
    }
  });
});

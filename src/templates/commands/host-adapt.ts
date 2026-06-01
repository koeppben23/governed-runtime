/**
 * @module templates/commands/host-adapt
 * @description Build-time projector that host-adapts FlowGuard command templates
 * for plugin bundling without mutating the canonical COMMANDS source (SSOT).
 *
 * The OpenCode command templates in COMMANDS are the single source of truth and
 * are written in OpenCode-native form: bare `flowguard_*` tool tokens and an
 * `agent: build` frontmatter line. Other hosts require a host-adapted rendering:
 *
 * - claude-code: FlowGuard tools are exposed as MCP tools named
 *   `mcp__flowguard__flowguard_*`; the OpenCode-only `agent: build` frontmatter
 *   is dropped; the OpenCode `webfetch` primitive maps to Claude's `WebFetch`.
 * - codex: custom prompts are deprecated and not plugin-shareable, so no command
 *   files are projected (fail-closed: empty map). Codex relies on skills instead.
 * - opencode: identity — rendering MUST be byte-identical to the source so the
 *   templates hash and OpenCode contract stay stable.
 *
 * This module imports only from the templates and shared layers (never cli),
 * preserving layering. The transform is pure and deterministic.
 *
 * @version v2
 */

import type { HostId } from '../../shared/hosts.js';
import { COMMANDS } from './index.js';

/**
 * Matches a bare FlowGuard tool token (snake_case), e.g. `flowguard_status`,
 * `flowguard_run_check`. A leading word boundary prevents matching tokens that
 * already carry the `mcp__flowguard__` namespace prefix (preceded by `_`),
 * keeping the transform idempotent.
 */
const BARE_FLOWGUARD_TOOL = /\bflowguard_[a-z_]+\b/g;

/** OpenCode-only frontmatter line; not meaningful for Claude Code commands. */
const AGENT_BUILD_LINE = /^[ \t]*agent: build[ \t]*\r?\n/m;

/** OpenCode primitive `webfetch` maps to Claude Code's built-in `WebFetch`. */
const WEBFETCH_PRIMITIVE = /\bwebfetch\b/g;

/**
 * Host-adapt a single command template body for the given platform.
 *
 * For `opencode` this is the identity function (byte-identical), preserving the
 * canonical source and the templates hash. For `claude-code` the FlowGuard tool
 * tokens are namespaced as MCP tools, the OpenCode-only frontmatter is dropped,
 * and the `webfetch` primitive is mapped to `WebFetch`. `codex` is treated as
 * identity at the content level; command projection is suppressed upstream.
 */
export function renderCommandForPlatform(content: string, platform: HostId): string {
  if (platform === 'claude-code') {
    return content
      .replace(AGENT_BUILD_LINE, '')
      .replace(BARE_FLOWGUARD_TOOL, (token) => `mcp__flowguard__${token}`)
      .replace(WEBFETCH_PRIMITIVE, 'WebFetch');
  }
  return content;
}

/**
 * Project the FlowGuard command set into plugin-relative `commands/<name>.md`
 * files host-adapted for the given platform.
 *
 * Only hosts whose plugin bundles slash commands receive entries:
 * - `claude-code`: all command basenames, host-adapted.
 * - `codex`: empty map (fail-closed — custom prompts are deprecated and not
 *   plugin-shareable; Codex uses skills instead).
 * - `opencode`: empty map (OpenCode commands are installed via the existing
 *   command-install path, not this plugin projector).
 */
export function commandsForPlatform(platform: HostId): Record<string, string> {
  if (platform !== 'claude-code') {
    return {};
  }
  const projected: Record<string, string> = {};
  for (const [basename, content] of Object.entries(COMMANDS)) {
    projected[`commands/${basename}`] = renderCommandForPlatform(content, platform);
  }
  return projected;
}

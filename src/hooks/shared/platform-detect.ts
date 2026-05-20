/**
 * @module hooks/shared/platform-detect
 * @description Detect the hook host platform from stdin payload shape.
 *
 * Platform detection uses unique fields present in each platform's hook protocol:
 * - Claude Code: provides `transcript_path` field (path to session transcript)
 * - Codex: provides `hook_event_name` field (event name echoed back)
 *
 * Detection is fail-safe: if neither marker is present, returns 'unknown'.
 * Hook scripts treat 'unknown' the same as 'claude-code' (universal deny format).
 *
 * Pure function, no I/O, no side effects.
 *
 * @version v1
 */

import type { HookPlatform } from './types.js';

/**
 * Detect the hook host platform from the parsed stdin payload.
 *
 * @param payload - Parsed JSON object from stdin.
 * @returns Detected platform identifier.
 */
export function detectPlatform(payload: Readonly<Record<string, unknown>>): HookPlatform {
  // Codex-specific: `hook_event_name` field is present and non-empty
  if (typeof payload['hook_event_name'] === 'string' && payload['hook_event_name'].length > 0) {
    return 'codex';
  }

  // Claude Code-specific: `transcript_path` field is present and non-empty
  if (typeof payload['transcript_path'] === 'string' && payload['transcript_path'].length > 0) {
    return 'claude-code';
  }

  return 'unknown';
}

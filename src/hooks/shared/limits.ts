/**
 * @module hooks/shared/limits
 * @description Shared transport limits for FlowGuard hook payloads.
 *
 * Command-hook stdin and HTTP hook request bodies use the same byte authority
 * so neither transport can buffer an unbounded payload before parsing.
 *
 * @version v1
 */

/** Maximum accepted hook payload size before fail-closed rejection. */
export const MAX_HOOK_PAYLOAD_BYTES = 1_048_576;

/**
 * Total git-probe budget for one hook session-authority resolution. The command
 * hook host advertises a 10s PreToolUse timeout; this bounds the two sequential
 * git probes (worktree root + remote origin), not the whole hook process
 * (Node startup and file I/O remain outside the budget).
 */
export const SESSION_AUTHORITY_DEADLINE_MS = 4_000;

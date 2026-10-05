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

export const TOOL_WRAPPER = `\
/**
 * FlowGuard tools — thin wrapper.
 * All logic lives in @flowguard/core. This file re-exports
 * the 12 named tool definitions for OpenCode to discover.
 *
 * Tool naming: OpenCode derives names as <filename>_<exportname>.
 * flowguard.ts + export const status -> flowguard_status
 *
 * @see https://opencode.ai/docs/custom-tools
 */
export {
  status,
  hydrate,
  ticket,
  plan,
  decision,
  implement,
  validate,
  review,
  continue,
  abort_session,
  archive,
  architecture,
} from "@flowguard/core/integration";
`;

// ---------------------------------------------------------------------------
// Plugin wrapper — plugins/flowguard-audit.ts
// ---------------------------------------------------------------------------

/**
 * Thin wrapper for `plugins/flowguard-audit.ts`.
 *
 * Re-exports the FlowGuardAuditPlugin from `@flowguard/core`
 * so that OpenCode can discover it.
 */
export const PLUGIN_WRAPPER = `\
/**
 * FlowGuard audit plugin — thin wrapper.
 * All logic lives in @flowguard/core. This file re-exports
 * the FlowGuardAuditPlugin for OpenCode to discover.
 *
 * @see https://opencode.ai/docs/plugins
 */
export { FlowGuardAuditPlugin } from "@flowguard/core/integration";
`;

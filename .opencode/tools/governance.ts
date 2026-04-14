/**
 * Governance tools — thin wrapper.
 * All logic lives in src/integration/. This file re-exports
 * the 9 named tool definitions for OpenCode to discover.
 *
 * Tool naming: OpenCode derives names as <filename>_<exportname>.
 * governance.ts + export const status -> governance_status
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
  abort_session,
} from "../../src/integration/index";

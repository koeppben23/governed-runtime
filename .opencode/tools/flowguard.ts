/**
 * FlowGuard tools — thin wrapper.
 * All logic lives in src/integration/. This file re-exports
 * the 10 named tool definitions for OpenCode to discover.
 *
 * Tool naming: OpenCode derives names as <filename>_<exportname>.
 * flowguard.ts + export const status -> flowguard_status
 *
 * Prerequisites: Run `npm install` in the project root after cloning.
 * The FlowGuard engine depends on zod (from root node_modules).
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
  archive,
} from "../../src/integration/index";

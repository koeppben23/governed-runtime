/**
 * FlowGuard audit plugin — thin wrapper.
 * All logic lives in src/integration/. This file re-exports
 * the FlowGuardAuditPlugin for OpenCode to discover.
 *
 * Prerequisites: Run `npm install` in the project root after cloning.
 *
 * @see https://opencode.ai/docs/plugins
 */
export { FlowGuardAuditPlugin } from "../../src/integration/index";

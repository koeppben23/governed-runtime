/**
 * Governance audit plugin — thin wrapper.
 * All logic lives in src/integration/. This file re-exports
 * the GovernanceAuditPlugin for OpenCode to discover.
 *
 * @see https://opencode.ai/docs/plugins
 */
export { GovernanceAuditPlugin } from "../../src/integration/index";

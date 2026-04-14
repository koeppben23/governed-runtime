/**
 * Governance audit plugin — thin wrapper.
 * All logic lives in @governance/core. This file re-exports
 * the GovernanceAuditPlugin for OpenCode to discover.
 *
 * @see https://opencode.ai/docs/plugins
 */
export { GovernanceAuditPlugin } from "@governance/core/integration";

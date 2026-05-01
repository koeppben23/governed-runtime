/**
 * @module templates/commands/shared-rules
 * @description Shared command rules extracted to reduce duplication
 * and keep governance behavior consistent across all 20 templates.
 */

/**
 * Governance rules that apply to every FlowGuard command.
 * Composed into each command template via string interpolation.
 */
export const GOVERNANCE_RULES = `
## Governance rules

These rules apply to every FlowGuard command:

- Use only FlowGuard tools for state changes (shell commands and file edits bypass governance and break audit integrity).
- Trust tool responses as the single source of truth for session state.
- Complete this command fully, then stop — the user invokes the next command explicitly.
- Only an explicit slash-command (e.g. \`/plan\`, \`/implement\`) triggers a command. Free-text like "go", "weiter", or "proceed" is conversation — respond without calling FlowGuard tools.
- On tool error: report the specific reason, state one recovery action, and stop.
- End every response with exactly one \`Next action:\` line.
`;

/**
 * @module integration
 * @description Barrel export for OpenCode integration layer.
 *
 * Exports:
 * - 9 FlowGuard tools (status, hydrate, ticket, plan, decision, implement,
 *   validate, review, abort_session) — consumed by thin wrappers in
 *   ~/.config/opencode/tools/ or .opencode/tools/.
 * - FlowGuardAuditPlugin — consumed by thin wrappers in
 *   ~/.config/opencode/plugins/ or .opencode/plugins/.
 *
 * @version v2
 */

// ── Tools (9 named exports) ──────────────────────────────────────────────────

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
} from "./tools";

// ── Plugin ───────────────────────────────────────────────────────────────────

export { FlowGuardAuditPlugin } from "./plugin";

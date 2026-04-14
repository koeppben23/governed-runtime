/**
 * @module integration
 * @description Barrel export for OpenCode integration layer.
 *
 * Exports:
 * - 10 FlowGuard tools (status, hydrate, ticket, plan, decision, implement,
 *   validate, review, abort_session, archive) — consumed by thin wrappers in
 *   ~/.config/opencode/tools/ or .opencode/tools/.
 * - FlowGuardAuditPlugin — consumed by thin wrappers in
 *   ~/.config/opencode/plugins/ or .opencode/plugins/.
 *
 * @version v3
 */

// ── Tools (10 named exports) ─────────────────────────────────────────────────

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
} from "./tools";

// ── Plugin ───────────────────────────────────────────────────────────────────

export { FlowGuardAuditPlugin } from "./plugin";

/**
 * @module integration
 * @description Barrel export for OpenCode integration layer.
 *
 * Exports:
 * - 11 FlowGuard tools (status, hydrate, ticket, plan, decision, implement,
 *   validate, review, abort_session, archive, architecture) — consumed by thin
 *   wrappers in ~/.config/opencode/tools/ or .opencode/tools/.
 * - FlowGuardAuditPlugin — consumed by thin wrappers in
 *   ~/.config/opencode/plugins/ or .opencode/plugins/.
 *
 * @version v3
 */

// ── Tools (11 named exports) ─────────────────────────────────────────────────

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
  architecture,
} from "./tools";

// ── Plugin ───────────────────────────────────────────────────────────────────

export { FlowGuardAuditPlugin } from "./plugin";

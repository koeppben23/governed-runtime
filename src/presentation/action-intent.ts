/**
 * @module presentation/action-intent
 * @description Host-neutral semantic action identity for FlowGuard presentation.
 *
 * ActionIntent describes WHAT the user needs to do independently from HOW a
 * specific host invokes that action. It is a semantic contract, not an
 * authorization or execution mechanism.
 *
 * Invariants:
 * - ActionIntent never creates workflow authority.
 * - ActionIntent never synthesizes allowed commands.
 * - ActionIntent never encodes host syntax, workflow phase, or copy wording.
 * - ActionIntent is read-only metadata on already-authorized actions.
 *
 * @version v1
 */

export type ActionIntent =
  | 'refresh_repository'
  | 'run_validation'
  | 'rerun_review'
  | 'inspect_status'
  | 'inspect_blocker'
  | 'request_changes'
  | 'approve'
  | 'reject'
  | 'export_result';

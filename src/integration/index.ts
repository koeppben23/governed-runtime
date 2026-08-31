/**
 * @module integration
 * @description Barrel export for OpenCode integration layer.
 *
 * All exports are re-exported here to ensure they're accessible
 * from the package entry point.
 *
 * @version v5
 */

export {
  status,
  hydrate,
  ticket,
  plan,
  decision,
  implement,
  review_implementation,
  extend_implementation_review,
  resolve_implementation_challenge,
  run_check,
  review,
  continue,
  abort_session,
  archive,
  architecture,
  help,
  declare_contract,
  observe_repository,
  reconcile_mutation_episode,
} from './tools/index.js';

export { FlowGuardAuditPlugin } from './plugin.js';

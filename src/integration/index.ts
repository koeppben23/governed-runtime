/**
 * @module integration
 * @description Barrel export for OpenCode integration layer.
 *
 * All exports are re-exported here to ensure they're accessible
 * from the package entry point.
 *
 * @version v4
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
  architecture,
} from './tools';

export { FlowGuardAuditPlugin } from './plugin';

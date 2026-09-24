/**
 * @module integration/review/enforcement
 * @description Barrel for the enforcement subdomain within the review context.
 *
 * Exports enforcement types, pending-review state, and the
 * persisted-SDK-invocation verdict gate.
 *
 * @version v2
 */

export type { EnforcementResult } from './types.js';

export { createSessionState, onFlowGuardToolAfter, enforceBeforeVerdict } from './enforcement.js';

/**
 * @module integration/plugin-mandates
 * @description Inject the canonical phase-aware mandates into verified ACTIVE
 * session requests. INACTIVE sessions receive no mandates; reviewer children
 * keep their frozen reviewer context untouched.
 */

import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';
import { renderPhaseAwareMandates } from '../rendering/mandates-renderer.js';
import type { SessionContext } from '@opencode/plugin/promise/session';
import type { ActiveGovernanceScope } from './opencode-governance.js';
import type { FlowGuardPluginRuntime } from './plugin-shared.js';
import { buildEnforcementError } from './blocked-result.js';

export async function injectActiveMandates(
  runtime: FlowGuardPluginRuntime,
  scope: ActiveGovernanceScope,
  event: SessionContext,
): Promise<void> {
  if (event.agent === REVIEWER_SUBAGENT_TYPE) return;
  if (!Array.isArray(event.system)) return;
  if (
    event.system.some(
      (part) =>
        (part.metadata as Record<string, unknown> | undefined)?.['source'] === 'flowguard-mandates',
    )
  )
    return;
  const resolution = await runtime.ws.resolveSessionAuthority(scope.root.sessionId);
  if (resolution.status !== 'resolved')
    throw buildEnforcementError(
      'GOVERNANCE_AUTHORITY_BLOCKED',
      'The ACTIVE session cannot resolve its workflow state for mandate injection.',
    );
  event.system.push({
    type: 'text',
    text: renderPhaseAwareMandates({}, resolution.state.phase),
    metadata: { source: 'flowguard-mandates', phase: resolution.state.phase },
  });
}

/** Durable native notification identity, using the existing canonical audit lock/writer. */
import {
  appendAuditEventAlreadyLocked,
  readAuditTrail,
  withAuditTrailLock,
} from '../adapters/persistence-audit.js';
import { digestToId, hashParts } from '../shared/hashing.js';
import type { SessionState } from '../state/schema.js';
import { buildEnforcementError } from './blocked-result.js';

export async function appendSessionErrorAuditOnce(input: {
  readonly sessDir: string;
  readonly governedSessionId: string;
  readonly nativeSessionId: string;
  readonly state: Pick<SessionState, 'flowguardSessionId' | 'phase'>;
  readonly errorMessage: string;
  readonly detail: Record<string, unknown>;
}): Promise<void> {
  const supplementary = input.detail.supplementary;
  const identity =
    typeof supplementary === 'object' && supplementary !== null
      ? (Reflect.get(supplementary, 'hostEventId') as unknown)
      : undefined;
  const created =
    typeof supplementary === 'object' && supplementary !== null
      ? (Reflect.get(supplementary, 'hostCreatedAt') as unknown)
      : undefined;
  if (
    typeof identity !== 'string' ||
    identity.length === 0 ||
    typeof created !== 'number' ||
    !Number.isFinite(created) ||
    !Number.isFinite(new Date(created).getTime())
  )
    throw buildEnforcementError(
      'PLUGIN_ENFORCEMENT_UNAVAILABLE',
      'Native session error identity or creation time is unavailable.',
    );
  const id = digestToId(
    hashParts(['opencode-session-error.v1', input.state.flowguardSessionId, identity]),
    5,
  );
  await withAuditTrailLock(input.sessDir, async () => {
    const previous = (await readAuditTrail(input.sessDir)).find((event) => event.id === id);
    await appendAuditEventAlreadyLocked(input.sessDir, {
      id,
      flowguardSessionId: input.state.flowguardSessionId,
      hostSessionId: input.governedSessionId,
      // Re-delivery observes the first committed phase, not a later workflow
      // phase. All immutable notification content is still compared by the
      // canonical writer; same identity with different content fails closed.
      phase: previous?.phase ?? input.state.phase,
      event: 'error:SESSION_ERROR',
      occurredAt: new Date(created).toISOString(),
      actor: 'machine',
      detail: {
        code: 'SESSION_ERROR',
        message: input.errorMessage,
        ...input.detail,
        ...(input.nativeSessionId === input.governedSessionId
          ? {}
          : { nativeSessionId: input.nativeSessionId }),
      },
    });
  });
}

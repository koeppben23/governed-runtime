import { CURRENT_AUDIT_FORMAT_VERSION, type EventBody } from './types.js';
import type { Phase } from '../state/schema.js';
import type { ActorInfo } from '../state/evidence-identity.js';

/** Build a durable semantic audit event from a state-owned outbox operation. */
export function buildSemanticAuditBody(input: {
  flowguardSessionId: string;
  hostSessionId: string | undefined;
  phase: Phase;
  detail: Record<string, unknown>;
  event: string;
  occurredAt: string;
  prevHash: string;
  operationId: string;
  preStateDigest: string;
  mutationDigest: string;
  postStateDigest: string;
  actor?: string;
  actorInfo?: ActorInfo;
}): EventBody {
  return {
    id: input.operationId,
    flowguardSessionId: input.flowguardSessionId,
    ...(input.hostSessionId ? { hostSessionId: input.hostSessionId } : {}),
    phase: input.phase,
    event: input.event,
    occurredAt: input.occurredAt,
    actor: input.actor ?? 'machine',
    auditFormatVersion: CURRENT_AUDIT_FORMAT_VERSION,
    ...(input.actorInfo ? { actorInfo: input.actorInfo } : {}),
    detail: {
      ...input.detail,
      operationId: input.operationId,
      preStateDigest: input.preStateDigest,
      mutationDigest: input.mutationDigest,
      postStateDigest: input.postStateDigest,
      stateChanged: input.preStateDigest !== input.postStateDigest,
    },
    prevHash: input.prevHash,
  };
}

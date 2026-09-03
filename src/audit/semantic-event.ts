import { CURRENT_AUDIT_FORMAT_VERSION, type EventBody } from './types.js';
import type { Phase } from '../state/schema.js';

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
}): EventBody {
  return {
    id: input.operationId,
    flowguardSessionId: input.flowguardSessionId,
    ...(input.hostSessionId ? { hostSessionId: input.hostSessionId } : {}),
    phase: input.phase,
    event: input.event,
    occurredAt: input.occurredAt,
    actor: 'machine',
    auditFormatVersion: CURRENT_AUDIT_FORMAT_VERSION,
    detail: {
      ...input.detail,
      operationId: input.operationId,
      preStateDigest: input.preStateDigest,
      mutationDigest: input.mutationDigest,
      postStateDigest: input.postStateDigest,
    },
    prevHash: input.prevHash,
  };
}

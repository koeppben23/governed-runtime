/**
 * @module audit/iso27001/live-binding
 * @description Pure evaluation of the live `export.completion` binding.
 *
 * The CLI owns the I/O (reading the live state and live audit trail); this
 * module owns the policy decision. Positive binding fields are produced only
 * after all of:
 *
 * 1. the live audit chain verifies through the canonical `verifyChain` with
 *    the expected FlowGuard session id (a foreign event fails the chain),
 * 2. the live trail extends the verified archive anchor: it carries at least
 *    the archived event count and its prefix head equals the manifest anchor
 *    (a forked or replaced trail cannot masquerade as the archived one),
 * 3. a canonical materialization transition (`EXPORT_READY` → a terminal
 *    phase, decided by the canonical terminal authority) exists inside the
 *    live extension.
 *
 * The live (mutable) state contributes only the reported package digest; the
 * materialization proof comes from the chain-verified live audit.
 *
 * @version v1
 */

import { isTerminalPhase } from '../../machine/topology.js';
import type { AuditEvent } from '../../state/evidence.js';
import { getLastChainHash, verifyChain } from '../integrity.js';
import type { LiveExportBinding } from './evidence.js';

export interface LiveExportBindingInput {
  /** Whether the live session state could be read. */
  readonly stateAvailable: boolean;
  /** Live `exportCompletionEvidence.packageDigest`, when present. */
  readonly exportCompletionPackageDigest: string | null;
  /** Whether the live audit trail could be read. */
  readonly auditReadable: boolean;
  /** The live audit events in trail order. */
  readonly liveEvents: readonly AuditEvent[];
  /** FlowGuard session identity from the VERIFIED archive state. */
  readonly flowguardSessionId: string | null;
  /** Audit event count anchored in the verified archive manifest. */
  readonly archiveAuditEventCount: number;
  /** Audit chain head anchored in the verified archive manifest. */
  readonly archiveAuditChainHead: string;
}

function unverified(input: LiveExportBindingInput): LiveExportBinding {
  return {
    stateAvailable: input.stateAvailable,
    exportCompletionPackageDigest: input.exportCompletionPackageDigest,
    liveChainVerified: false,
    materializedTransitionAt: null,
  };
}

function isMaterializationEvent(event: AuditEvent): boolean {
  if (event.event !== 'transition:EXPORT_MATERIALIZED') return false;
  if (event.detail.from !== 'EXPORT_READY') return false;
  const target = event.detail.to;
  return typeof target === 'string' && isTerminalPhase(target);
}

/** Evaluate the live binding. Pure and deterministic. */
export function evaluateLiveExportBinding(input: LiveExportBindingInput): LiveExportBinding {
  if (!input.auditReadable || input.flowguardSessionId === null) return unverified(input);

  const events = [...input.liveEvents];
  const chain = verifyChain(events, {
    expectedFlowguardSessionId: input.flowguardSessionId,
  });
  const extendsAnchor =
    events.length >= input.archiveAuditEventCount &&
    getLastChainHash(events.slice(0, input.archiveAuditEventCount)) === input.archiveAuditChainHead;
  if (!chain.valid || !extendsAnchor) return unverified(input);

  const materialized = events
    .map((event, index) => ({ event, index }))
    .filter(
      ({ event, index }) => index >= input.archiveAuditEventCount && isMaterializationEvent(event),
    )
    .at(-1);

  return {
    stateAvailable: input.stateAvailable,
    exportCompletionPackageDigest: input.exportCompletionPackageDigest,
    liveChainVerified: true,
    materializedTransitionAt: materialized?.event.occurredAt ?? null,
  };
}

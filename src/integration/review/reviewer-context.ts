/**
 * @module integration/review/reviewer-context
 * @description Freeze host-owned comparison context into reviewer material.
 */

import type { SessionState } from '../../state/schema.js';
import { canonicalJsonStringify } from '../../shared/canonical-json.js';
import { stateVerificationEvidence } from './shared-helpers.js';

function ticketProjection(state: SessionState): unknown {
  const ticket = state.ticket;
  return ticket ? { digest: ticket.digest, text: ticket.text } : null;
}

function section(heading: string, content: string): string[] {
  return [`## ${heading}`, '', content, ''];
}

/**
 * Canonical, self-contained material delivered to plan, architecture, and
 * implementation reviewers. This is created before the obligation, rather than
 * reconstructed from mutable session state while a reviewer attempt is running.
 */
export function buildFrozenReviewMaterialContent(input: {
  readonly obligationType: 'plan' | 'architecture' | 'implement';
  readonly state: SessionState;
  readonly artifact: string;
}): string {
  const ticket = section(
    'Ticket Under Review (originating request)',
    canonicalJsonStringify(ticketProjection(input.state)),
  );
  if (input.obligationType === 'plan') {
    return [...ticket, ...section('Plan Artifact', input.artifact)].join('\n');
  }
  if (input.obligationType === 'architecture') {
    return [...ticket, ...section('Architecture Decision Artifact', input.artifact)].join('\n');
  }

  const plan = input.state.plan?.current;
  const changedFiles = [...(input.state.implementation?.changedFiles ?? [])].sort();
  return [
    ...ticket,
    ...section(
      'Approved Plan (identity and content)',
      canonicalJsonStringify(
        plan ? { digest: plan.digest, planVersion: plan.planVersion, body: plan.body } : null,
      ),
    ),
    ...section('Changed Files', canonicalJsonStringify(changedFiles)),
    ...section(
      'Verification Evidence (host-executed)',
      canonicalJsonStringify(stateVerificationEvidence(input.state)),
    ),
    ...section(
      'Implementation Subject Metadata',
      canonicalJsonStringify(input.state.implementation),
    ),
    ...section('Implementation Artifact', input.artifact),
  ].join('\n');
}

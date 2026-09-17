/**
 * @module integration/status-why-finish
 * @description Presentation projection types and builders for /why and /finish.
 *
 * Extracted from status.ts to stay under the 750 LOC file-size budget.
 * These types and functions are consumed by why-presentation.ts,
 * finish-presentation.ts, and status-tool.ts.
 *
 * @version v1
 */

import type { SessionState } from '../state/schema.js';
import type { FlowGuardPolicy } from '../config/policy.js';
import { evaluate } from '../machine/evaluate.js';
import { resolveWorkflowDirective, type WorkflowDirective } from '../machine/workflow-directive.js';
import { PHASE_LABELS } from '../presentation/phase-labels.js';
import { evaluateCompleteness } from '../audit/completeness.js';
import { projectStatusActionFromCommand } from './status-conclusion.js';
import { directiveLabel, type PresentationAction } from '../presentation/index.js';
import type { BlockedProjection, FinishCard } from './status.js';
import { projectProofStatusForState } from './proofgraph/proof-summary-projectors.js';

// ─── /why Projection Types ─────────────────────────────────────────────────────

export type WhyConclusionProjection =
  | {
      readonly kind: 'next_action';
      readonly action: PresentationAction;
    }
  | {
      readonly kind: 'terminal';
      readonly message: string;
    }
  | {
      readonly kind: 'decision_required';
      readonly question: string;
      readonly actions: readonly PresentationAction[];
    }
  | {
      readonly kind: 'review_pending';
      readonly message: string;
    };

export interface WhyPresentationProjection {
  readonly phase: string;
  readonly phaseLabel: string;
  readonly blocker: BlockedProjection;
  readonly evidenceSlots: ReadonlyArray<{
    readonly slot: string;
    readonly label: string;
    readonly status: 'missing' | 'failed';
    readonly hint: string | null;
  }>;
  readonly proofSummary: import('../presentation/proof-model.js').CompactProofPresentation;
  readonly conclusion: WhyConclusionProjection;
}

// ─── /finish Projection Types ──────────────────────────────────────────────────

export type FinishConclusionProjection =
  | {
      readonly kind: 'next_action';
      readonly action: PresentationAction;
    }
  | {
      readonly kind: 'terminal';
      readonly message: string;
    };

export interface FinishPresentationProjection {
  readonly card: FinishCard;
  readonly conclusion: FinishConclusionProjection;
}

// ─── /why Builder ──────────────────────────────────────────────────────────────

export function buildWhyPresentationProjection(
  state: SessionState,
  policy: FlowGuardPolicy,
  blocker: BlockedProjection,
): WhyPresentationProjection {
  const evalResult = evaluate(state, { requireHumanGates: policy.requireHumanGates });
  const directive = resolveWorkflowDirective(state);
  const completeness = evaluateCompleteness(state);

  const evidenceSlots = completeness.slots
    .filter((slot) => slot.required && (slot.status === 'missing' || slot.status === 'failed'))
    .map((slot) => ({
      slot: slot.slot,
      label: slot.label,
      status: slot.status as 'missing' | 'failed',
      hint: slot.status === 'failed' ? (slot.detail ?? null) : null,
    }));

  return {
    phase: state.phase,
    phaseLabel: PHASE_LABELS[state.phase],
    blocker,
    evidenceSlots,
    proofSummary: projectProofStatusForState(state),
    conclusion: buildWhyConclusion(evalResult, directive),
  };
}

function buildWhyConclusion(
  evalResult: ReturnType<typeof evaluate>,
  directive: WorkflowDirective,
): WhyConclusionProjection {
  if (directive.kind === 'system_work') {
    return { kind: 'review_pending', message: directiveLabel(directive.code) };
  }
  const command = directive.commands[0];

  switch (evalResult.kind) {
    case 'waiting': {
      const actions = directive.commands.map((c) => projectStatusActionFromCommand(c, 'available'));
      if (actions.length === 0) {
        throw Object.assign(
          new Error(
            `WhyProjection: waiting gate has no canonical decision actions: ${evalResult.reason}`,
          ),
          { code: 'WHY_DECISION_PROJECTION_EMPTY' },
        );
      }
      return { kind: 'decision_required', question: evalResult.reason, actions };
    }

    case 'pending':
    case 'transition': {
      if (!command) {
        return { kind: 'terminal', message: directiveLabel(directive.code) };
      }
      return {
        kind: 'next_action',
        action: projectStatusActionFromCommand(command, 'recommended'),
      };
    }

    case 'terminal': {
      const nextCmd = directive.commands[0];
      if (!nextCmd) {
        return { kind: 'terminal', message: directiveLabel(directive.code) };
      }
      return {
        kind: 'next_action',
        action: projectStatusActionFromCommand(nextCmd, 'recommended'),
      };
    }
  }
}

// ─── /finish Builder ───────────────────────────────────────────────────────────

export function buildFinishPresentationProjection(
  state: SessionState,
  finish: FinishCard,
): FinishPresentationProjection {
  return {
    card: finish,
    conclusion: buildFinishConclusion(state),
  };
}

function buildFinishConclusion(state: SessionState): FinishConclusionProjection {
  const directive = resolveWorkflowDirective(state);
  const command = directive.commands[0];

  if (command !== undefined) {
    return {
      kind: 'next_action',
      action: projectStatusActionFromCommand(command, 'recommended'),
    };
  }

  return { kind: 'terminal', message: directiveLabel(directive.code) };
}

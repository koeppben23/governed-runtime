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
import { resolveNextAction } from '../machine/next-action.js';
import { PHASE_LABELS } from '../presentation/phase-labels.js';
import { buildProductNextAction } from '../presentation/next-action-copy.js';
import { evaluateCompleteness } from '../audit/completeness.js';
import {
  projectStatusActionFromCommand,
  type StatusActionProjection,
} from './status-conclusion.js';
import type { BlockedProjection, FinishCard } from './status.js';

// ─── /why Projection Types ─────────────────────────────────────────────────────

export type WhyConclusionProjection =
  | {
      readonly kind: 'next_action';
      readonly action: StatusActionProjection;
    }
  | {
      readonly kind: 'decision_required';
      readonly question: string;
      readonly actions: readonly StatusActionProjection[];
    }
  | {
      readonly kind: 'terminal';
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
  readonly conclusion: WhyConclusionProjection;
}

// ─── /finish Projection Types ──────────────────────────────────────────────────

export type FinishConclusionProjection =
  | {
      readonly kind: 'next_action';
      readonly action: StatusActionProjection;
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
  const next = resolveNextAction(state.phase, state);
  const productNext = buildProductNextAction(
    next,
    state.phase,
    state.error?.code === 'ABORTED',
    state.archiveStatus ?? null,
  );
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
    conclusion: buildWhyConclusion(evalResult, productNext),
  };
}

function buildWhyConclusion(
  evalResult: ReturnType<typeof evaluate>,
  productNext: ReturnType<typeof buildProductNextAction>,
): WhyConclusionProjection {
  const command = productNext.commands[0];

  switch (evalResult.kind) {
    case 'waiting': {
      const actions = productNext.commands.map((c) =>
        projectStatusActionFromCommand(c, 'available'),
      );
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
        throw Object.assign(
          new Error(`WhyProjection: ${evalResult.kind} without product command`),
          { code: 'WHY_ACTION_PROJECTION_EMPTY' },
        );
      }
      return {
        kind: 'next_action',
        action: projectStatusActionFromCommand(command, 'recommended'),
      };
    }

    case 'terminal': {
      if (productNext.commands.length > 0) {
        const nextCmd = productNext.commands[0];
        if (nextCmd) {
          return {
            kind: 'next_action',
            action: projectStatusActionFromCommand(nextCmd, 'recommended'),
          };
        }
      }
      if (productNext.text.trim().length === 0) {
        throw Object.assign(new Error('WhyProjection: terminal requires non-empty text'), {
          code: 'WHY_TERMINAL_PROJECTION_EMPTY',
        });
      }
      return { kind: 'terminal', message: productNext.text };
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
  const next = resolveNextAction(state.phase, state);
  const productNext = buildProductNextAction(
    next,
    state.phase,
    state.error?.code === 'ABORTED',
    state.archiveStatus ?? null,
  );

  const command = productNext.commands[0];

  if (command !== undefined) {
    return {
      kind: 'next_action',
      action: projectStatusActionFromCommand(command, 'recommended'),
    };
  }

  if (productNext.text.trim().length === 0) {
    throw Object.assign(new Error('Finish presentation requires non-empty terminal text'), {
      code: 'FINISH_TERMINAL_PROJECTION_EMPTY',
    });
  }

  return { kind: 'terminal', message: productNext.text };
}

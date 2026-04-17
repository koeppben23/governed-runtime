/**
 * @module architecture
 * @description /architecture rail — create an Architecture Decision Record (ADR).
 *
 * Behavior:
 * 1. Validate command admissibility (READY and ARCHITECTURE for revisions)
 * 2. Transition READY → ARCHITECTURE (flow selection)
 * 3. Validate input (title, adrText with required MADR sections)
 * 4. Create ArchitectureDecision evidence
 * 5. Initialize self-review loop
 * 6. Auto-advance (ARCHITECTURE → ARCH_REVIEW if loop converges)
 *
 * Self-review uses the same convergence pattern as /plan:
 * - digest-stop: verdict=approve AND revisionDelta=none
 * - force-stop: iteration >= maxIterations (from policy)
 *
 * The rail only handles initial ADR submission. Self-review iterations
 * are driven by /continue (which calls runSingleIteration).
 *
 * @version v1
 */

import type { SessionState } from '../state/schema';
import type { ArchitectureDecision, LoopVerdict, RevisionDelta } from '../state/evidence';
import { validateAdrSections } from '../state/evidence';
import { Command, isCommandAllowed } from '../machine/commands';
import { evaluate } from '../machine/evaluate';
import type { RailResult, RailContext, TransitionRecord } from './types';
import { autoAdvance } from './types';
import { blocked } from '../config/reasons';

// ─── Input ────────────────────────────────────────────────────────────────────

export interface ArchitectureInput {
  /** Short title of the architecture decision. */
  readonly title: string;
  /** Full ADR body in Markdown (MADR format). */
  readonly adrText: string;
}

// ─── Rail ─────────────────────────────────────────────────────────────────────

export function executeArchitecture(
  state: SessionState,
  input: ArchitectureInput,
  ctx: RailContext,
): RailResult {
  // 1. Admissibility
  if (!isCommandAllowed(state.phase, Command.ARCHITECTURE)) {
    return blocked('COMMAND_NOT_ALLOWED', {
      command: '/architecture',
      phase: state.phase,
    });
  }

  // 2. Validate input
  if (!input.title.trim()) {
    return blocked('EMPTY_ADR_TITLE');
  }
  if (!input.adrText.trim()) {
    return blocked('EMPTY_ADR_TEXT');
  }

  // 3. Validate MADR sections
  const missingSections = validateAdrSections(input.adrText);
  if (missingSections.length > 0) {
    return blocked('MISSING_ADR_SECTIONS', {
      sections: missingSections.join(', '),
    });
  }

  // 4. Transition READY → ARCHITECTURE (flow selection)
  const preTransitions: TransitionRecord[] = [];
  let basePhase = state.phase;
  let baseTransition = state.transition;

  if (state.phase === 'READY') {
    const at = ctx.now();
    basePhase = 'ARCHITECTURE';
    const tr: TransitionRecord = {
      from: 'READY',
      to: 'ARCHITECTURE',
      event: 'ARCHITECTURE_SELECTED',
      at,
    };
    preTransitions.push(tr);
    baseTransition = { from: tr.from, to: tr.to, event: tr.event, at: tr.at };
  }

  const adrNumber = state.nextAdrNumber;
  const adrId = `ADR-${String(adrNumber).padStart(3, '0')}`;

  // 5. Create ArchitectureDecision evidence
  const adr: ArchitectureDecision = {
    id: adrId,
    title: input.title,
    adrText: input.adrText,
    status: 'proposed',
    createdAt: ctx.now(),
    digest: ctx.digest(input.adrText),
  };

  // 6. Build state with ADR + initial self-review loop
  const maxIterations = ctx.policy?.maxSelfReviewIterations ?? 3;

  const nextState: SessionState = {
    ...state,
    phase: basePhase,
    transition: baseTransition,
    architecture: adr,
    selfReview: {
      iteration: 0,
      maxIterations,
      prevDigest: null,
      currDigest: adr.digest,
      revisionDelta: 'major' as RevisionDelta,
      verdict: 'changes_requested' as LoopVerdict,
    },
    nextAdrNumber: adrNumber + 1,
    error: null,
  };

  // 7. Auto-advance (ARCHITECTURE → ARCH_REVIEW if loop converges)
  const evalFn = (s: SessionState) => evaluate(s, ctx.policy);
  const {
    state: finalState,
    evalResult: result,
    transitions: advanceTransitions,
  } = autoAdvance(nextState, evalFn, ctx);
  const transitions = [...preTransitions, ...advanceTransitions];

  return { kind: 'ok', state: finalState, evalResult: result, transitions };
}

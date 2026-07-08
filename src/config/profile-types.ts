import type { Phase } from '../state/schema.js';

/**
 * Phase-aware profile instructions.
 *
 * Static declarative object — configuration, not behavior.
 */
export interface PhaseInstructions {
  /** Base instructions — always injected regardless of phase. */
  readonly base: string;
  /** Phase-specific additional instructions appended to base for that phase. */
  readonly byPhase?: Partial<Record<Phase, string>>;
}

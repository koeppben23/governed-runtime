/**
 * @module integration/tools/review-validation-mode
 * @description The single canonical "operation mode" validator for FlowGuard's
 * three multi-mode tools (`flowguard_plan`, `flowguard_architecture`,
 * `flowguard_implement`).
 *
 * Each of those tools exposes several semantic operations (submit / revise /
 * approve / record) through one broad argument object that shares
 * `reviewVerdict` and `reviewerUnavailable`, plus an optional
 * text payload (`planText` / `adrText`). Before this module existed, the
 * argument-shape classification was duplicated three times with subtly
 * divergent coverage — the "duplicate authority with drift" hazard tracked in
 * issue #499. This module owns that classification ONCE and emits each tool's
 * existing precondition reason codes, so no registered code is dropped and no
 * fail-closed behaviour regresses.
 *
 * Scope: this validator covers the pure ARGUMENT-SHAPE faults (mixed inputs,
 * approve-with-text, findings-without-verdict, unavailable-with-submission). It
 * deliberately does NOT cover state-dependent sequencing (e.g. "verdict before
 * any plan/evidence exists", "wrong phase") — those remain in each tool because
 * they require `SessionState`.
 *
 * Enforced as the sole authority by
 * `src/architecture/__tests__/mode-validation-ssot.test.ts`.
 *
 * @version v1
 */

export type ToolFamily = 'plan' | 'architecture' | 'implement';

/** Normalized, family-agnostic view of the shared multi-mode arguments. */
export interface ToolCallArgsView {
  /** Optional heavy text payload: planText (plan) / adrText (architecture). */
  readonly text?: string;
  /**
   * reviewVerdict, when present. Typed as a string union superset so it accepts
   * each tool's verdict type (plan/implement: accept|changes_requested;
   * architecture: LoopVerdict, which also includes unable_to_review). The
   * classifier only distinguishes `changes_requested` from everything else.
   */
  readonly reviewVerdict?: 'accept' | 'changes_requested' | 'unable_to_review';
  /** reviewerUnavailable flag. */
  readonly reviewerUnavailable?: boolean;
}

/** Pure boolean flags derived from the arguments (the once-canonical idiom). */
export interface ToolCallFlags {
  readonly hasText: boolean;
  readonly hasVerdict: boolean;
  readonly hasReviewerUnavailable: boolean;
}

/** Discriminated operation mode for a multi-mode tool call. */
export type ToolCallMode =
  | { readonly kind: 'initial_submission' }
  | { readonly kind: 'revision' }
  | { readonly kind: 'approval' }
  | { readonly kind: 'transport_failure_retry' }
  | { readonly kind: 'invalid'; readonly code: string; readonly params?: Record<string, string> };

/**
 * Per-family invalid reason codes. Existing codes are preserved verbatim so the
 * registered precondition-code set is unchanged; the two ADR codes are newly
 * wired here (architecture previously had gaps and an orphaned
 * `INVALID_ARCHITECTURE_TOOL_SEQUENCE`).
 */
interface FamilyCodes {
  /** text + verdict=accept. `undefined` for families with no text payload (implement). */
  readonly approveWithText?: string;
  /** reviewerUnavailable mixed into a submission (no verdict). */
  readonly unavailableWithSubmission: string;
  /**
   * Whether `reviewerUnavailable + no verdict` is only rejected when text is
   * also present (plan's historical rule) or always (architecture/implement,
   * which have no legitimate preemptive-unavailable submission shape here).
   */
  readonly unavailableRequiresText: boolean;
}

const FAMILY_CODES: Record<ToolFamily, FamilyCodes> = {
  plan: {
    approveWithText: 'PLAN_APPROVE_WITH_TEXT',
    unavailableWithSubmission: 'INVALID_PLAN_TOOL_SEQUENCE',
    unavailableRequiresText: true,
  },
  architecture: {
    approveWithText: 'ADR_APPROVE_WITH_TEXT',
    unavailableWithSubmission: 'INVALID_ARCHITECTURE_TOOL_SEQUENCE',
    unavailableRequiresText: false,
  },
  implement: {
    // implement has no text payload, so approve-with-text is structurally N/A.
    approveWithText: undefined,
    unavailableWithSubmission: 'INVALID_IMPLEMENT_TOOL_SEQUENCE',
    unavailableRequiresText: false,
  },
};

/**
 * Derive the canonical boolean flags. This is the ONE place the
 * `typeof === 'string' && length > 0` verdict idiom may live (previously copied
 * into plan-types, architecture, and implement-shared). `null`-tolerant by
 * design: LLM hosts may send `null` for absent optional fields.
 */
export function toolCallFlags(args: ToolCallArgsView): ToolCallFlags {
  return {
    hasText: typeof args.text === 'string' && args.text.trim().length > 0,
    hasVerdict: typeof args.reviewVerdict === 'string' && args.reviewVerdict.length > 0,
    hasReviewerUnavailable: args.reviewerUnavailable === true,
  };
}

/**
 * Detect an invalid argument SHAPE for a family, or `null` if the shape is
 * valid. Implemented as an ordered rule table (data-driven) to keep complexity
 * low and the fault precedence explicit. Split out of
 * {@link classifyToolCallMode} so each function has one responsibility.
 */
function detectInvalidShape(
  codes: FamilyCodes,
  flags: ToolCallFlags,
  receivedVerdict: ToolCallArgsView['reviewVerdict'],
): Extract<ToolCallMode, { kind: 'invalid' }> | null {
  const noVerdict = !flags.hasVerdict;
  const verdictParams = receivedVerdict ? { receivedVerdict } : undefined;
  const unavailableInSubmission =
    flags.hasReviewerUnavailable && noVerdict && (!codes.unavailableRequiresText || flags.hasText);

  // Ordered: first matching rule wins. `code` undefined disables the rule for a
  // family (e.g. implement has no approve-with-text; plan defers bare findings).
  const rules: ReadonlyArray<{
    readonly when: boolean;
    readonly code: string | undefined;
    readonly params?: Record<string, string>;
  }> = [
    // text + verdict=accept: heavy payload submitted with an approval.
    {
      when: flags.hasText && flags.hasVerdict && receivedVerdict !== 'changes_requested',
      code: codes.approveWithText,
      params: verdictParams,
    },
    // reviewerUnavailable mixed into a submission (gated on text for plan).
    { when: unavailableInSubmission, code: codes.unavailableWithSubmission },
  ];

  const matched = rules.find((rule) => rule.when && rule.code);
  return matched ? { kind: 'invalid', code: matched.code!, params: matched.params } : null;
}

/**
 * Classify a multi-mode tool call into a discriminated operation mode, rejecting
 * invalid argument shapes with the family's canonical reason code.
 *
 * Validity rules (applied to ALL three families symmetrically, with per-family
 * code names so no registered reason code is dropped):
 * - text + verdict=accept            -> invalid (approveWithText) — text is for
 *   submission/revision only. (Skipped for implement: no text payload.)
 * - reviewerUnavailable + submission -> invalid (unavailableWithSubmission),
 *   gated on text presence for the plan family.
 * - otherwise: initial_submission (no verdict) | revision (changes_requested) |
 *   approval (accept).
 *
 * The valid `text + verdict=changes_requested` (revision) shape is never
 * rejected — that is the revised-plan / revised-ADR path.
 */
export function classifyToolCallMode(family: ToolFamily, args: ToolCallArgsView): ToolCallMode {
  const flags = toolCallFlags(args);
  const receivedVerdict = args.reviewVerdict;

  // The implementation verdict tool is the only admissible entrypoint once the
  // workflow reaches IMPL_REVIEW. A bare reviewerUnavailable signal requests a
  // transport retry; it is never a verdict submission.
  if (family === 'implement' && flags.hasReviewerUnavailable) {
    if (!flags.hasVerdict && !flags.hasText) {
      return { kind: 'transport_failure_retry' };
    }
  }

  const invalid = detectInvalidShape(FAMILY_CODES[family], flags, receivedVerdict);
  if (invalid) return invalid;

  if (!flags.hasVerdict) return { kind: 'initial_submission' };
  if (receivedVerdict === 'changes_requested') return { kind: 'revision' };
  return { kind: 'approval' };
}

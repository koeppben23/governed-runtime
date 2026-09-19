/**
 * @module integration/proofgraph/claim-contract
 * @description Fail-closed claim-declaration contract for every write boundary (#762).
 *
 * A critical claim requires adversarial evidence to reach PROVEN
 * (materialize-contract.ts sets `adversarial: ['counterexample']` for it, and
 * audit/proofgraph/evaluate.ts returns NOT_VERIFIED when that is unmet). A
 * critical declaration WITHOUT a counterexample check is therefore structurally
 * unprovable: once the gate is unconditional it would block the final approval
 * forever, with no recovery available to the author.
 *
 * The same holds for a check id that is not active, an unknown structural
 * surface, or an unregistered mutation profile: each yields evidence that can
 * never resolve.
 *
 * This validator rejects those declarations at the moment they are authored,
 * where the error is actionable — never at the approval gate hours later. It is
 * deliberately NOT a persisted schema refinement: `SessionState.safeParse` runs
 * on read, so a refinement would make an already-persisted session unreadable
 * instead of rejecting a write.
 *
 * Both write boundaries share this module so the rules cannot drift apart, while
 * diagnostics keep each tool's PUBLIC field names. The declaration contracts and
 * individual rules live in claim-contract-rules.ts.
 */

import type { TaskClass } from '../../state/schema.js';
import type {
  ClaimContractBatchResult,
  ClaimContractInput,
  ClaimContractRejectedDeclaration,
  ClaimContractResult,
  NormalizedClaimDeclaration,
} from './claim-contract-rules.js';
import { checkUniqueIdentity, claimViolations } from './claim-contract-rules.js';

/**
 * Validate the full claim set atomically.
 *
 * Returns on the FIRST violation so the author fixes one concrete problem at a
 * time. The caller must not persist, and must not compute any digest, unless
 * the result is `ok` — otherwise a certificate could bind a semantically
 * invalid claim set.
 */
export function validateProofClaimContract(input: ClaimContractInput): ClaimContractResult {
  const duplicate = checkUniqueIdentity(input);
  if (duplicate) return duplicate;

  for (const claim of input.claims) {
    const violation = claimViolations(input, claim)[0];
    if (violation) return violation;
  }
  return { kind: 'ok' };
}

/**
 * Classify a declaration batch without choosing a write-boundary policy.
 *
 * Only non-critical claims that are structurally unsatisfiable may be omitted
 * by a caller that explicitly opts into partial acceptance. Incomplete
 * contracts and all set-level violations remain blocking.
 */
export function classifyProofClaimContract(input: ClaimContractInput): ClaimContractBatchResult {
  const duplicate = checkUniqueIdentity(input);
  if (duplicate?.kind === 'invalid') {
    return {
      accepted: [],
      rejectedNonBlocking: [],
      rejectedBlocking: [],
      setViolations: [duplicate],
    };
  }

  const accepted: { claim: NormalizedClaimDeclaration; index: number }[] = [];
  const rejectedNonBlocking: ClaimContractRejectedDeclaration[] = [];
  const rejectedBlocking: ClaimContractRejectedDeclaration[] = [];
  for (const [index, claim] of input.claims.entries()) {
    const violations = claimViolations(input, claim);
    const firstViolation = violations[0];
    if (firstViolation === undefined) {
      accepted.push({ claim, index });
      continue;
    }
    const result =
      violations.find((violation) => violation.failureKind !== 'unsatisfiable') ?? firstViolation;
    const rejected = { claim, index, result };
    if (result.failureKind === 'unsatisfiable' && !claim.critical) {
      rejectedNonBlocking.push(rejected);
    } else {
      rejectedBlocking.push(rejected);
    }
  }
  return { accepted, rejectedNonBlocking, rejectedBlocking, setViolations: [] };
}

/**
 * Format a claim contract violation into a blocked result.
 *
 * Maps `failureKind` to the appropriate reason code. Both /plan and
 * /declare-contract must use this function so reason-code selection
 * cannot drift between write boundaries.
 */
export function formatClaimContractViolation(
  result: ClaimContractResult & { kind: 'invalid' },
  formatBlocked: (code: string, params: Record<string, string>) => string,
): string {
  return result.failureKind === 'unsatisfiable'
    ? formatBlocked('PROOFGRAPH_CLAIM_UNSATISFIABLE', {
        claimRef: result.claimRef,
        field: result.field,
        detail: result.detail,
      })
    : formatBlocked('PROOFGRAPH_CLAIM_CONTRACT_INCOMPLETE', {
        claimRef: result.claimRef,
        field: result.field,
        detail: result.detail,
      });
}

/**
 * Whether an implementation risk assessment still describes the current
 * revision. A superseded assessment must never justify a gate decision.
 */
/** Advisory-only projection of a heuristic pre-implementation risk signal. */
export interface HeuristicRiskWarning {
  readonly computedMinimumTaskClass: TaskClass;
  readonly assessedFrom: 'plan_target_paths';
  readonly assessedFileCount: number;
  readonly message: string;
}

/**
 * Heuristic pre-implementation warning for a plan that looks HIGH-RISK but
 * declares no critical claim.
 *
 * Deliberately advisory: `targetPaths` are a forecast, whereas the binding
 * classification comes from the implementation's actual `changedFiles`. Using a
 * forecast to gate would both block on incomplete path lists and be avoidable by
 * omitting them. This only spares the author a late, expensive recovery cycle.
 *
 * Returns null when there is nothing to warn about — absent target paths never
 * produce a warning.
 */
export function buildHeuristicRiskWarning(input: {
  readonly targetPaths: readonly string[] | undefined;
  readonly assessedTaskClass: TaskClass;
  readonly criticalClaimCount: number;
}): HeuristicRiskWarning | null {
  const paths = input.targetPaths ?? [];
  if (paths.length === 0) return null;
  if (input.assessedTaskClass !== 'HIGH-RISK') return null;
  if (input.criticalClaimCount > 0) return null;
  return {
    computedMinimumTaskClass: input.assessedTaskClass,
    assessedFrom: 'plan_target_paths',
    assessedFileCount: paths.length,
    message:
      'The declared target paths suggest a HIGH-RISK change, but this plan declares no critical claim. ' +
      'This is a heuristic forecast, not a classification: the binding assessment is derived from the ' +
      "implementation's actual changed files. If those confirm HIGH-RISK, the final evidence approval " +
      'will require at least one critical, adversarially checkable plan claim.',
  };
}

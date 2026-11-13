/** Execute approved source variants before review material is frozen. */
import { randomUUID } from 'node:crypto';
import type { SessionState } from '../../../state/schema.js';
import type { VerificationCandidate } from '../../../state/discovery-schemas.js';
import type {
  FalsificationExecution,
  ValidationResult,
} from '../../../state/evidence-validation.js';
import { counterexampleRequirementDigest } from '../../../state/proofgraph.js';
import { canonicalRepoRelativePath } from '../../../shared/repo-path.js';
import {
  hasCurrentPlanApprovalCertificate,
  type PlanClaimDeclaration,
} from '../../../state/proofgraph-approval.js';
import { planApprovalContextOf } from '../../../state/proofgraph-approval-context.js';
import { withFalsificationWorkspace } from '../../../verification/falsification-workspace.js';
import { FalsificationUnavailableError } from '../../../verification/errors.js';
import { prepareVerificationExecution } from '../../../verification/verification-execution.js';
import { completeAssertionExtraction } from '../../../verification/assertion-extractor.js';
import { executeCheck } from '../../../verification/executor.js';
import { deriveRepairGuidance } from '../../../verification/repair-guidance.js';
import { buildValidationResult, classifyValidationOutcome } from './run-check-result.js';

async function runCandidate(
  candidate: VerificationCandidate,
  cwd: string,
  attemptId: string,
): Promise<ValidationResult> {
  const prepared = await prepareVerificationExecution(candidate, cwd, attemptId);
  const evidence = await executeCheck({ kind: candidate.kind, command: prepared.command, cwd });
  const extraction = await completeAssertionExtraction(prepared, evidence, cwd);
  const outcome = classifyValidationOutcome(evidence, extraction, candidate.assertionCapability);
  return buildValidationResult({
    checkId: candidate.kind,
    candidateId: candidate.candidateId,
    evidence,
    extraction,
    outcome,
    fullCheckScopeAttestation:
      candidate.assertionCapability === 'structured'
        ? candidate.fullCheckScopeAttestation
        : undefined,
    derivedRepairGuidance: deriveRepairGuidance(evidence, outcome),
  });
}

/**
 * A variant is authority only under the CURRENT approved plan. A missing or
 * stale certificate leaves the claim's adversarial obligation unresolved; it
 * must not block the ordinary check or invent negated authority.
 */
function isVariantPlanCurrent(state: SessionState): boolean {
  const plan = state.plan;
  return (
    plan?.claimDeclarations !== undefined &&
    plan.approvalCertificate !== undefined &&
    hasCurrentPlanApprovalCertificate(
      {
        current: plan.current,
        claimDeclarations: plan.claimDeclarations,
        approvalCertificate: plan.approvalCertificate,
      },
      planApprovalContextOf(state),
    )
  );
}

function assertExecutableVariant(
  state: SessionState,
  variant: NonNullable<PlanClaimDeclaration['counterexampleRequirement']>['variant'],
): void {
  if (!variant) throw new FalsificationUnavailableError('Variant declaration is missing');
  if (!state.implementation?.changedFiles.includes(variant.path))
    throw new FalsificationUnavailableError(
      'Variant target is outside the governed implementation',
    );
  const inputs = Object.values(state.executionSubjectInputsByCandidateId ?? {}).flat();
  if (
    inputs.some(
      (input) => input.kind === 'file' && canonicalRepoRelativePath(input.path) === variant.path,
    )
  )
    throw new FalsificationUnavailableError('Variant cannot modify a verification execution input');
}

async function executeDeclaredFalsification(
  state: SessionState,
  claim: PlanClaimDeclaration,
  candidate: VerificationCandidate,
  worktree: string,
): Promise<FalsificationExecution[]> {
  const requirement = claim.counterexampleRequirement;
  const variant = requirement?.variant;
  if (!requirement || !variant) return [];
  assertExecutableVariant(state, variant);
  if (
    requirement.kind === 'aggregate_check' &&
    requirement.candidateId !== undefined &&
    requirement.candidateId !== candidate.candidateId
  )
    return [];
  return [
    await withFalsificationWorkspace(worktree, variant, async (workspace) => {
      const controlAttemptId = randomUUID();
      const variantAttemptId = randomUUID();
      const control = await runCandidate(candidate, workspace.control, controlAttemptId);
      if (
        control.assertionExtraction?.status === 'extracted' &&
        control.assertionExtraction.assertions.some(
          (assertion) =>
            assertion.sourceFile !== undefined &&
            canonicalRepoRelativePath(assertion.sourceFile) === variant.path,
        )
      )
        throw new FalsificationUnavailableError('Variant cannot modify an observed test source');
      await workspace.attest();
      const mutated = await runCandidate(candidate, workspace.variant, variantAttemptId);
      await workspace.attest();
      return {
        claimId: claim.claimId,
        declarationDigest: counterexampleRequirementDigest(requirement),
        controlAttemptId,
        variantAttemptId,
        controlSourceDigest: workspace.controlSourceDigest,
        variantSourceDigest: workspace.variantSourceDigest,
        control,
        variant: mutated,
      };
    }),
  ];
}

export async function runDeclaredFalsifications(
  state: SessionState,
  candidate: VerificationCandidate,
  worktree: string,
): Promise<FalsificationExecution[]> {
  if (state.phase !== 'IMPL_VALIDATION') return [];
  if (candidate.assertionCapability !== 'structured') return [];
  const claims = state.plan?.claimDeclarations?.claims ?? [];
  const applicable = claims.filter(
    (c) =>
      c.counterexampleRequirement?.variant &&
      c.counterexampleRequirement.checkId === candidate.kind,
  );
  if (applicable.length === 0) return [];
  if (!isVariantPlanCurrent(state)) return [];
  const records: FalsificationExecution[] = [];
  for (const claim of applicable) {
    try {
      records.push(...(await executeDeclaredFalsification(state, claim, candidate, worktree)));
    } catch (error) {
      // An unavailable perturbation leaves the claim NOT_VERIFIED. The ordinary
      // validation attempt is still recorded so the phase is not wedged.
      if (!(error instanceof FalsificationUnavailableError)) throw error;
    }
  }
  return records;
}

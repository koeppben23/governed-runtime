import { REVIEWER_SUBAGENT_TYPE } from '../../../shared/flowguard-identifiers.js';
import type { FrozenReviewSubject, ReviewRepositoryIdentity } from '../../../state/evidence.js';
import { REVIEW_CRITERIA_VERSION, REVIEW_MANDATE_DIGEST } from '../../review/assurance.js';

/**
 * Structural equality for a frozen repository identity.
 *
 * Replaces a `JSON.stringify` comparison, which silently depended on key order
 * surviving every persist/parse round trip.
 */
function sameRepositoryIdentity(a: ReviewRepositoryIdentity, b: ReviewRepositoryIdentity): boolean {
  if ('kind' in a) return 'kind' in b && a.rootCommitDigest === b.rootCommitDigest;
  return !('kind' in b) && a.host === b.host && a.owner === b.owner && a.name === b.name;
}

/**
 * The repository identity frozen with a branch review subject.
 *
 * Returns BOTH identity shapes. A repository without a parseable `origin`
 * remote freezes a `{ kind: 'local', rootCommitDigest }` identity, which is a
 * fully valid `ReviewRepositoryIdentity`. Recognising only the remote shape
 * dropped that identity on every continuation, so the reviewed subject was
 * rebuilt without a `baseRepository` and failed schema validation.
 */
export function repositoryFromBranchSubject(
  subject: FrozenReviewSubject | undefined,
): ReviewRepositoryIdentity | undefined {
  if (subject?.kind !== 'repository_change' || !subject.headRepository) {
    return undefined;
  }
  const base = subject.baseRepository;
  return sameRepositoryIdentity(base, subject.headRepository) ? base : undefined;
}

export function buildRequiredReviewAttestationPayload(obligationId: string): {
  requiredReviewAttestation: {
    reviewedBy: string;
    mandateDigest: string;
    criteriaVersion: string;
    toolObligationId: string;
  };
  reviewerSubagentType: string;
  recovery: string[];
} {
  return {
    requiredReviewAttestation: {
      reviewedBy: REVIEWER_SUBAGENT_TYPE,
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      toolObligationId: obligationId,
    },
    reviewerSubagentType: REVIEWER_SUBAGENT_TYPE,
    recovery: [
      'Load the referenced content (PR diff via gh CLI, URL via webfetch, or use manual text).',
      `Call Task tool with subagent_type: "${REVIEWER_SUBAGENT_TYPE}" and provide the content in the prompt.`,
      'Pass the requiredReviewAttestation values to the subagent so it populates attestation.reviewedBy, attestation.mandateDigest, attestation.criteriaVersion, and attestation.toolObligationId exactly as provided.',
      'Instruct the subagent to return a complete ReviewFindings object (reviewMode, reviewedBy, reviewedAt, attestation, blockingIssues, majorRisks, missingVerification, scopeCreep, unknowns).',
      'Parse the subagent response as a ReviewFindings object - do NOT convert it to an array and do NOT drop attestation fields.',
      'Re-run flowguard_review with reviewFindings set to the complete ReviewFindings object. In strict mode, copied attestation fields alone are diagnostic context only; FlowGuard must persist matching ReviewInvocationEvidence before the findings satisfy governance.',
    ],
  };
}

export function formatBlockedWithAttestation(
  code: string,
  message: string,
  obligationId: string,
): string {
  if (code === 'HOST_SUBAGENT_TASK_REQUIRED') {
    return JSON.stringify({
      error: true,
      code,
      message,
      reviewObligationId: obligationId,
      requiredReviewAttestation: {
        reviewedBy: REVIEWER_SUBAGENT_TYPE,
        mandateDigest: REVIEW_MANDATE_DIGEST,
        criteriaVersion: REVIEW_CRITERIA_VERSION,
        toolObligationId: obligationId,
      },
      reviewerSubagentType: REVIEWER_SUBAGENT_TYPE,
      recovery: [
        `Call Task tool with subagent_type: "${REVIEWER_SUBAGENT_TYPE}" and provide the content plus requiredReviewAttestation.`,
        'After FlowGuard captures the Task evidence, re-run flowguard_review with reviewObligationId set to requiredReviewAttestation.toolObligationId and reviewVerdict matching the reviewer overallVerdict.',
        'Do not submit, copy, or alter reviewFindings in host-task mode.',
      ],
    });
  }
  return JSON.stringify({
    error: true,
    code,
    message,
    reviewObligationId: obligationId,
    ...buildRequiredReviewAttestationPayload(obligationId),
  });
}

export function formatMissingContentAnalysis(
  obligationId: string,
  hostTaskRequired = false,
): string {
  // The host-task branch previously lived inside a plain double-quoted string
  // nested in this template literal, so `${obligationId}` reached the agent
  // verbatim instead of the real UUID.
  const continuation = hostTaskRequired
    ? `, then re-run flowguard_review with the original content fields, reviewObligationId '${obligationId}', and reviewVerdict matching the captured reviewer verdict. Do not submit or copy reviewFindings in host-task mode.`
    : ' to analyze the provided content, then re-run flowguard_review with the complete ReviewFindings object. Manual JSON/attestation copy alone is not sufficient in strict mode; FlowGuard must persist matching ReviewInvocationEvidence.';
  return formatBlockedWithAttestation(
    'CONTENT_ANALYSIS_REQUIRED',
    `Content-aware /review requires subagent analysis. Call the ${REVIEWER_SUBAGENT_TYPE} subagent via Task tool${continuation}`,
    obligationId,
  );
}

export function formatSubagentReviewNotInvoked(detail: string, obligationId: string): string {
  return formatBlockedWithAttestation(
    'SUBAGENT_REVIEW_NOT_INVOKED',
    `Supplied reviewFindings did not pass subagent attestation: ${detail}. Re-run the ${REVIEWER_SUBAGENT_TYPE} subagent with the requiredReviewAttestation values and submit the complete ReviewFindings object. Copied attestation fields are diagnostic context only until FlowGuard persists matching ReviewInvocationEvidence.`,
    obligationId,
  );
}

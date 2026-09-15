import { REVIEWER_SUBAGENT_TYPE } from '../../../shared/flowguard-identifiers.js';
import type {
  FrozenRepositoryAuthority,
  FrozenRepositoryRevisionTarget,
  FrozenReviewSubject,
  ReviewRepositoryIdentity,
} from '../../../state/evidence.js';
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
 * Explicit frozen repository authority for a frozen repository-change subject.
 *
 * Same-repository reviews mint a `candidate_pair`; distinct remote
 * repositories (a fork PR) mint a `fork_pair`, which keeps the two repository
 * identities explicit instead of silently re-pointing one side at the other.
 * Non-repository subjects carry no repository authority.
 */
export function repositoryAuthorityFromSubject(
  subject: FrozenReviewSubject | undefined,
): FrozenRepositoryAuthority | undefined {
  if (subject?.kind !== 'repository_change') return undefined;
  const baseIdentity = subject.baseRepository;
  const headIdentity = subject.headRepository ?? subject.baseRepository;
  const base: FrozenRepositoryRevisionTarget = {
    kind: 'commit',
    repositoryIdentity: baseIdentity,
    objectSha: subject.baseSha,
  };
  const head: FrozenRepositoryRevisionTarget = {
    kind: 'commit',
    repositoryIdentity: headIdentity,
    objectSha: subject.headSha,
  };
  return sameRepositoryIdentity(baseIdentity, headIdentity)
    ? { kind: 'candidate_pair', base, head }
    : { kind: 'fork_pair', base, head };
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
      `Run the ${REVIEWER_SUBAGENT_TYPE} through the configured SDK structured session.`,
      'Bind the requiredReviewAttestation values to the structured reviewer invocation.',
      'Wait for FlowGuard to capture a complete structured ReviewFindings object and re-run flowguard_review with reviewObligationId.',
    ],
  };
}

export function formatBlockedWithAttestation(
  code: string,
  message: string,
  obligationId: string,
): string {
  return JSON.stringify({
    error: true,
    code,
    message,
    reviewObligationId: obligationId,
    ...buildRequiredReviewAttestationPayload(obligationId),
  });
}

export function formatMissingContentAnalysis(obligationId: string): string {
  return formatBlockedWithAttestation(
    'CONTENT_ANALYSIS_REQUIRED',
    `Content-aware /review requires SDK structured analysis by ${REVIEWER_SUBAGENT_TYPE}. Re-run flowguard_review with reviewObligationId after FlowGuard captures the reviewer findings.`,
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

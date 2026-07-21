/**
 * @module integration/review/transport-evidence
 * @description Bind external reviewer transport files into canonical review evidence.
 *
 * Files under review-evidence/ are transport only. This module validates their
 * ReviewFindings content against the active ReviewObligation and converts valid
 * findings into ReviewInvocationEvidence. Approval still flows through the
 * existing tool-layer review verdict submission.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ReviewFindings as ReviewFindingsSchema } from '../../state/evidence.js';
import type { DecisionIdentity, ReviewFindings, ReviewObligation } from '../../state/evidence.js';
import type { SessionState } from '../../state/schema.js';
import { compareActorIdentity } from '../../identity/actor-info.js';
import {
  appendInvocationEvidence,
  buildInvocationEvidence,
  ensureReviewAssurance,
  fulfillObligation,
  hashFindings,
  hashText,
  validateStrictAttestation,
} from './assurance.js';
import { getRequiredBranchReviewProvenance } from '../tools/review-tool/obligation.js';

function getBranchProvenanceFields(obligation: ReviewObligation): {
  resolvedBranchSha: string | null;
  resolvedBaseSha: string | null;
  reviewedContentDigest: string | null;
} {
  const isBranch =
    typeof obligation.metadata?.branch === 'string' && obligation.metadata.branch.length > 0;
  if (!isBranch)
    return { resolvedBranchSha: null, resolvedBaseSha: null, reviewedContentDigest: null };
  const p = getRequiredBranchReviewProvenance(obligation);
  return {
    resolvedBranchSha: p.resolvedBranchSha,
    resolvedBaseSha: p.resolvedBaseSha,
    reviewedContentDigest: p.reviewedContentDigest,
  };
}

export type TransportEvidenceBindResult =
  | { readonly status: 'none' }
  | {
      readonly status: 'bound';
      readonly state: SessionState;
      readonly obligation: ReviewObligation;
    }
  | {
      readonly status: 'already_bound';
      readonly state: SessionState;
      readonly obligation: ReviewObligation;
    }
  | {
      readonly status: 'invalid';
      readonly code: string;
      readonly reason: string;
      readonly obligationId?: string;
      readonly vars?: Record<string, string>;
      readonly rejectionReason?: 'reviewer_is_author' | 'reviewer_identity_uncomparable';
    };

interface TransportEvidenceValidationError {
  readonly code: string;
  readonly reason: string;
  readonly obligationId?: string;
  readonly vars?: Record<string, string>;
  readonly rejectionReason?: 'reviewer_is_author' | 'reviewer_identity_uncomparable';
}

function latestUnconsumedObligation(state: SessionState): ReviewObligation | null {
  const obligations = ensureReviewAssurance(state.reviewAssurance).obligations;
  return (
    [...obligations]
      .reverse()
      .find((item) => item.status !== 'consumed' && item.consumedAt === null) ?? null
  );
}

async function readTransportFiles(
  sessDir: string,
): Promise<Array<{ path: string; content: string }>> {
  const dir = join(sessDir, 'review-evidence');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }

  const jsonNames = names.filter((name) => name.endsWith('.json')).sort();
  const files: Array<{ path: string; content: string }> = [];
  for (const name of jsonNames) {
    const path = join(dir, name);
    files.push({ path, content: await readFile(path, 'utf-8') });
  }
  return files;
}

function extractFindings(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'reviewFindings' in raw) {
    return (raw as { reviewFindings?: unknown }).reviewFindings;
  }
  return raw;
}

function validateAgainstObligation(
  findings: ReviewFindings,
  obligation: ReviewObligation,
  initiatedByIdentity: DecisionIdentity | undefined,
): TransportEvidenceValidationError | null {
  if (findings.iteration !== obligation.iteration) {
    return {
      code: 'REVIEW_ITERATION_MISMATCH',
      reason: 'obligation_binding_mismatch',
      vars: { provided: String(findings.iteration), expected: String(obligation.iteration) },
    };
  }
  if (findings.planVersion !== obligation.planVersion) {
    return {
      code: 'REVIEW_PLAN_VERSION_MISMATCH',
      reason: 'obligation_binding_mismatch',
      vars: { provided: String(findings.planVersion), expected: String(obligation.planVersion) },
    };
  }
  if (findings.reviewMode !== 'subagent') {
    return { code: 'REVIEW_MODE_SELF_NOT_ALLOWED', reason: 'review_mode_not_allowed' };
  }
  if (findings.overallVerdict === 'unable_to_review') {
    return { code: 'SUBAGENT_UNABLE_TO_REVIEW', reason: 'reviewer_unable_to_review' };
  }

  const actorComparison = compareActorIdentity(initiatedByIdentity, findings.reviewedBy);
  if (actorComparison === 'uncomparable') {
    return {
      code: 'DECISION_IDENTITY_REQUIRED',
      reason: 'reviewer_identity_uncomparable',
      obligationId: obligation.obligationId,
      rejectionReason: 'reviewer_identity_uncomparable',
    };
  }
  if (actorComparison === 'same') {
    return {
      code: 'FOUR_EYES_ACTOR_MATCH',
      reason: 'reviewer_is_author',
      obligationId: obligation.obligationId,
      vars: { initiator: initiatedByIdentity?.actorId ?? 'unknown' },
      rejectionReason: 'reviewer_is_author',
    };
  }

  const attestationError = validateStrictAttestation(findings, {
    obligationId: obligation.obligationId,
    iteration: obligation.iteration,
    planVersion: obligation.planVersion,
  });
  return attestationError ? { code: attestationError, reason: 'strict_attestation_invalid' } : null;
}

async function processTransportFile(
  file: { path: string; content: string },
  state: SessionState,
  obligation: ReturnType<typeof latestUnconsumedObligation> & {},
  assurance: ReturnType<typeof ensureReviewAssurance>,
  opts: { parentSessionId: string; now: string },
): Promise<TransportEvidenceBindResult> {
  const { parentSessionId, now } = opts;
  const parsed = parseAndValidateTransportFindings(file, state, obligation);
  if (parsed.status === 'invalid') return parsed;

  if (state.policySnapshot?.reviewInvocationPolicy === 'host_task_required')
    return {
      status: 'invalid',
      code: 'HOST_SUBAGENT_TASK_REQUIRED',
      reason:
        'host_task_required policy requires host-visible reviewer evidence; manual_attested transport evidence is not sufficient',
    };

  const findings = parsed.findings;
  const findingsHash = hashFindings(findings);
  const existing = assurance.invocations.find(
    (item) => item.obligationId === obligation.obligationId && item.findingsHash === findingsHash,
  );
  if (existing) return { status: 'already_bound', state, obligation };

  const invocation = buildManualTransportInvocation(obligation, findings, findingsHash, {
    parentSessionId,
    now,
  });
  const fulfilled = fulfillObligation(
    assurance,
    obligation.obligationId,
    invocation.invocationId,
    now,
  );
  return {
    status: 'bound',
    obligation,
    state: { ...state, reviewAssurance: appendInvocationEvidence(fulfilled, invocation) },
  };
}

function parseAndValidateTransportFindings(
  file: { path: string; content: string },
  state: SessionState,
  obligation: ReturnType<typeof latestUnconsumedObligation> & {},
):
  | { status: 'valid'; findings: ReturnType<typeof ReviewFindingsSchema.parse> }
  | Extract<TransportEvidenceBindResult, { status: 'invalid' }> {
  const parsedJson = parseTransportJson(file);
  if (parsedJson.status === 'invalid') return parsedJson;
  const parsedFindings = ReviewFindingsSchema.safeParse(extractFindings(parsedJson.value));
  if (!parsedFindings.success) {
    return {
      status: 'invalid',
      code: 'REVIEW_TRANSPORT_EVIDENCE_INVALID',
      reason: `review evidence transport file does not contain valid ReviewFindings: ${file.path}`,
    };
  }
  const validationError = validateAgainstObligation(
    parsedFindings.data,
    obligation,
    state.initiatedByIdentity,
  );
  return validationError
    ? transportValidationError(validationError)
    : { status: 'valid', findings: parsedFindings.data };
}

function parseTransportJson(file: {
  path: string;
  content: string;
}):
  | { status: 'valid'; value: unknown }
  | Extract<TransportEvidenceBindResult, { status: 'invalid' }> {
  try {
    return { status: 'valid', value: JSON.parse(file.content) };
  } catch {
    return {
      status: 'invalid',
      code: 'REVIEW_TRANSPORT_EVIDENCE_INVALID',
      reason: `review evidence transport file is not valid JSON: ${file.path}`,
    };
  }
}

function transportValidationError(
  validationError: NonNullable<ReturnType<typeof validateAgainstObligation>>,
): Extract<TransportEvidenceBindResult, { status: 'invalid' }> {
  return {
    status: 'invalid',
    code: validationError.code,
    reason: validationError.reason,
    ...(validationError.obligationId ? { obligationId: validationError.obligationId } : {}),
    ...(validationError.vars ? { vars: validationError.vars } : {}),
    ...(validationError.rejectionReason
      ? { rejectionReason: validationError.rejectionReason }
      : {}),
  };
}

function buildManualTransportInvocation(
  obligation: ReturnType<typeof latestUnconsumedObligation> & {},
  findings: ReturnType<typeof ReviewFindingsSchema.parse>,
  findingsHash: string,
  opts: { parentSessionId: string; now: string },
): ReturnType<typeof buildInvocationEvidence> {
  return buildInvocationEvidence({
    obligationId: obligation.obligationId,
    obligationType: obligation.obligationType,
    parentSessionId: opts.parentSessionId,
    childSessionId: findings.reviewedBy.sessionId,
    invocationMode: 'manual_attested',
    hostVisible: false,
    promptHash: hashText(
      `${obligation.obligationType}:${obligation.iteration}:${obligation.planVersion}`,
    ),
    findingsHash,
    invokedAt: findings.reviewedAt,
    fulfilledAt: opts.now,
    source: 'agent-submitted-attested',
    capturedVerdict: findings.overallVerdict,
    capturedRawFindings: findings,
    ...getBranchProvenanceFields(obligation),
  });
}

export async function bindExternalReviewEvidence(
  sessDir: string,
  state: SessionState,
  parentSessionId: string,
  now: string,
): Promise<TransportEvidenceBindResult> {
  const obligation = latestUnconsumedObligation(state);
  if (!obligation) return { status: 'none' };
  const files = await readTransportFiles(sessDir);
  if (files.length === 0) return { status: 'none' };
  const assurance = ensureReviewAssurance(state.reviewAssurance);
  for (const file of files.reverse()) {
    const result = await processTransportFile(file, state, obligation, assurance, {
      parentSessionId,
      now,
    });
    if (result.status !== 'none') return result;
  }
  return { status: 'none' };
}

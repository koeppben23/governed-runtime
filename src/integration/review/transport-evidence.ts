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
import type { ReviewFindings, ReviewObligation } from '../../state/evidence.js';
import type { SessionState } from '../../state/schema.js';
import {
  appendInvocationEvidence,
  buildInvocationEvidence,
  ensureReviewAssurance,
  fulfillObligation,
  hashFindings,
  hashText,
  validateStrictAttestation,
} from './assurance.js';

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
  | { readonly status: 'invalid'; readonly code: string; readonly reason: string };

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
): string | null {
  if (findings.iteration !== obligation.iteration) return 'REVIEW_ITERATION_MISMATCH';
  if (findings.planVersion !== obligation.planVersion) return 'REVIEW_PLAN_VERSION_MISMATCH';
  if (findings.reviewMode !== 'subagent') return 'REVIEW_MODE_SELF_NOT_ALLOWED';
  if (findings.overallVerdict === 'unable_to_review') return 'SUBAGENT_UNABLE_TO_REVIEW';
  return validateStrictAttestation(findings, {
    obligationId: obligation.obligationId,
    iteration: obligation.iteration,
    planVersion: obligation.planVersion,
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
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(file.content);
    } catch {
      return {
        status: 'invalid',
        code: 'REVIEW_TRANSPORT_EVIDENCE_INVALID',
        reason: `review evidence transport file is not valid JSON: ${file.path}`,
      };
    }

    const parsedFindings = ReviewFindingsSchema.safeParse(extractFindings(parsedJson));
    if (!parsedFindings.success) {
      return {
        status: 'invalid',
        code: 'REVIEW_TRANSPORT_EVIDENCE_INVALID',
        reason: `review evidence transport file does not contain valid ReviewFindings: ${file.path}`,
      };
    }

    const findings = parsedFindings.data;
    const validationCode = validateAgainstObligation(findings, obligation);
    if (validationCode) {
      return {
        status: 'invalid',
        code: validationCode,
        reason: `transport ReviewFindings do not bind to active obligation ${obligation.obligationId}`,
      };
    }

    if (state.policySnapshot?.reviewInvocationPolicy === 'host_task_required') {
      return {
        status: 'invalid',
        code: 'HOST_SUBAGENT_TASK_REQUIRED',
        reason:
          'host_task_required policy requires host-visible reviewer evidence; manual_attested transport evidence is not sufficient',
      };
    }

    const findingsHash = hashFindings(findings);
    const existing = assurance.invocations.find(
      (item) => item.obligationId === obligation.obligationId && item.findingsHash === findingsHash,
    );
    if (existing) return { status: 'already_bound', state, obligation };

    const invocation = buildInvocationEvidence({
      obligationId: obligation.obligationId,
      obligationType: obligation.obligationType,
      parentSessionId,
      childSessionId: findings.reviewedBy.sessionId,
      invocationMode: 'manual_attested',
      hostVisible: false,
      promptHash: hashText(
        `${obligation.obligationType}:${obligation.iteration}:${obligation.planVersion}`,
      ),
      findingsHash,
      invokedAt: findings.reviewedAt,
      fulfilledAt: now,
      source: 'agent-submitted-attested',
      capturedVerdict: findings.overallVerdict,
      capturedRawFindings: findings,
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
      state: {
        ...state,
        reviewAssurance: appendInvocationEvidence(fulfilled, invocation),
      },
    };
  }

  return { status: 'none' };
}

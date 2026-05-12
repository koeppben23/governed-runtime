/**
 * @module integration/review-findings-schema
 * @description JSON Schema definition for the ReviewFindings structured output.
 *
 * Extracted from review-orchestrator.ts (FG-REL-038) for single-responsibility.
 * This schema is passed to the OpenCode SDK `session.prompt()` format field
 * to enforce structured JSON output from the reviewer subagent.
 *
 * Contract: The schema MUST stay in sync with the Zod ReviewFindingsSchema
 * in src/state/evidence.ts. Drift is detected by
 * review-findings-schema-drift.test.ts.
 *
 * @version v1
 */

import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';

export const REVIEW_FINDINGS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    iteration: { type: 'integer', minimum: 0 },
    planVersion: { type: 'integer', minimum: 1 },
    reviewMode: { type: 'string', const: 'subagent' },
    overallVerdict: { type: 'string', enum: ['approve', 'changes_requested', 'unable_to_review'] },
    blockingIssues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          category: {
            type: 'string',
            enum: ['completeness', 'correctness', 'feasibility', 'risk', 'quality'],
          },
          message: { type: 'string' },
          location: { type: 'string' },
        },
        required: ['severity', 'category', 'message'],
      },
    },
    majorRisks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          category: {
            type: 'string',
            enum: ['completeness', 'correctness', 'feasibility', 'risk', 'quality'],
          },
          message: { type: 'string' },
          location: { type: 'string' },
        },
        required: ['severity', 'category', 'message'],
      },
    },
    missingVerification: { type: 'array', items: { type: 'string' } },
    scopeCreep: { type: 'array', items: { type: 'string' } },
    unknowns: { type: 'array', items: { type: 'string' } },
    reviewedBy: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        actorId: { type: 'string' },
        actorSource: { type: 'string', enum: ['env', 'git', 'claim', 'unknown'] },
        actorAssurance: {
          type: 'string',
          enum: ['verified', 'best_effort', 'claim_validated', 'idp_verified'],
        },
      },
      required: ['sessionId'],
    },
    reviewedAt: { type: 'string' },
    attestation: {
      type: 'object',
      properties: {
        mandateDigest: { type: 'string' },
        criteriaVersion: { type: 'string' },
        toolObligationId: {
          type: 'string',
          // RFC 4122 UUID pattern. Must stay in sync with z.string().uuid() in
          // src/state/evidence.ts ReviewAttestation.toolObligationId.
          // Drift guard: src/integration/review-findings-schema-drift.test.ts.
          pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
        },
        iteration: { type: 'integer', minimum: 0 },
        planVersion: { type: 'integer', minimum: 1 },
        reviewedBy: { type: 'string', const: REVIEWER_SUBAGENT_TYPE },
      },
      required: [
        'mandateDigest',
        'criteriaVersion',
        'toolObligationId',
        'iteration',
        'planVersion',
        'reviewedBy',
      ],
    },
  },
  required: [
    'iteration',
    'planVersion',
    'reviewMode',
    'overallVerdict',
    'blockingIssues',
    'majorRisks',
    'missingVerification',
    'scopeCreep',
    'unknowns',
    'reviewedBy',
    'reviewedAt',
    'attestation',
  ],
  additionalProperties: false,
} as const;

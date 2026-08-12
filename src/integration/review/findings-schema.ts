/**
 * @module integration/review-findings-schema
 * @description JSON Schema definition for the ReviewFindings structured output.
 *
 * This schema is passed to the OpenCode SDK `session.prompt()` format field
 * to enforce structured JSON output from the reviewer subagent.
 *
 * Enum values and discriminator variants are sourced from reviewer-contract.ts,
 * the canonical SSOT. Drift from canonical Zod types is detected by both
 * reviewer-contract.test.ts and findings-schema-drift.test.ts.
 *
 * @version v3 — canonical SSOT via reviewer-contract
 */

import { REVIEWER_SUBAGENT_TYPE } from '../../shared/flowguard-identifiers.js';
import {
  SEVERITY_VALUES,
  CATEGORY_VALUES,
  REVISION_VALUES,
  OVERALL_VERDICT_VALUES,
  ANCHOR_KINDS,
  CHALLENGE_KINDS,
} from './reviewer-contract.js';

const REPOSITORY_LOCATION_JSON_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1 },
        revision: { type: 'string', enum: [...REVISION_VALUES] },
        line: { type: 'integer', minimum: 1 },
        endLine: { type: 'integer', minimum: 1 },
      },
      required: ['path', 'revision'],
    },
  ],
} as const;

function buildAnchorVariant(kind: (typeof ANCHOR_KINDS)[number]): Record<string, unknown> {
  if (kind === 'repository_location') {
    return {
      type: 'object',
      properties: {
        kind: { type: 'string', const: kind },
        location: REPOSITORY_LOCATION_JSON_SCHEMA,
      },
      required: ['kind', 'location'],
    };
  }
  if (kind === 'artifact_section') {
    return {
      type: 'object',
      properties: {
        kind: { type: 'string', const: kind },
        artifactKind: { type: 'string', enum: ['plan', 'adr'] },
        artifactDigest: { type: 'string', minLength: 1 },
        sectionPath: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              headingDepth: { type: 'integer', minimum: 1, maximum: 6 },
              siblingIndex: { type: 'integer', minimum: 1 },
              headingText: { type: 'string' },
            },
            required: ['headingDepth', 'siblingIndex', 'headingText'],
          },
        },
      },
      required: ['kind', 'artifactKind', 'artifactDigest', 'sectionPath'],
    };
  }
  if (kind === 'content') {
    return {
      type: 'object',
      properties: {
        kind: { type: 'string', const: kind },
        subjectDigest: { type: 'string', minLength: 1 },
        range: {
          type: 'object',
          properties: {
            startLine: { type: 'integer', minimum: 1 },
            endLine: { type: 'integer', minimum: 1 },
          },
          required: ['startLine'],
        },
      },
      required: ['kind', 'subjectDigest'],
    };
  }
  throw new Error(`Unknown anchor kind: ${kind} — update findings-schema.ts`);
}

function buildChallengeVariant(kind: (typeof CHALLENGE_KINDS)[number]): Record<string, unknown> {
  const base = challengeBase(kind);
  if (kind === 'design_challenge') return buildDesignChallenge(base);
  if (kind === 'implementation_challenge') return buildImplementationChallenge(base);
  if (kind === 'content_challenge') return buildContentChallenge(base);
  throw new Error(`Unknown challenge kind: ${kind} — update findings-schema.ts`);
}

function challengeBase(kind: string) {
  return {
    challengeId: {
      type: 'string',
      pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
    },
    obligationId: {
      type: 'string',
      pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
    },
    scenario: { type: 'string', minLength: 1 },
    claim: { type: 'string', minLength: 1 },
    locations: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
    kind: { type: 'string', const: kind },
  } as const;
}

const CHALLENGE_REQUIRED = [
  'challengeId',
  'obligationId',
  'scenario',
  'claim',
  'locations',
  'kind',
  'evidenceRefs',
  'outcome',
];

function buildDesignChallenge(base: Record<string, unknown>) {
  return {
    type: 'object',
    properties: {
      ...base,
      evidenceRefs: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', const: 'plan_adr_section' },
            artifactKind: { type: 'string', enum: ['plan', 'adr'] },
            artifactDigest: { type: 'string', minLength: 1 },
            sectionPath: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                properties: {
                  headingDepth: { type: 'integer', minimum: 1, maximum: 6 },
                  siblingIndex: { type: 'integer', minimum: 1 },
                  headingText: { type: 'string' },
                },
                required: ['headingDepth', 'siblingIndex', 'headingText'],
              },
            },
            excerptDigest: { type: 'string', minLength: 1 },
          },
          required: ['kind', 'artifactKind', 'artifactDigest', 'sectionPath', 'excerptDigest'],
        },
      },
      outcome: { type: 'string', enum: ['supported', 'contradicted', 'not_verified'] },
    },
    required: CHALLENGE_REQUIRED,
  };
}

function buildImplementationChallenge(base: Record<string, unknown>) {
  return {
    type: 'object',
    properties: {
      ...base,
      evidenceRefs: {
        type: 'array',
        minItems: 1,
        items: {
          oneOf: [
            {
              type: 'object',
              properties: {
                kind: { type: 'string', const: 'implementation' },
                implementationDigest: { type: 'string', minLength: 1 },
                diffDigest: { type: 'string', minLength: 1 },
              },
              required: ['kind', 'implementationDigest'],
            },
            {
              type: 'object',
              properties: {
                kind: { type: 'string', const: 'validation_attempt' },
                attemptId: {
                  type: 'string',
                  pattern:
                    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
                },
              },
              required: ['kind', 'attemptId'],
            },
          ],
        },
      },
      outcome: { type: 'string', enum: ['pass', 'fail', 'not_verified'] },
    },
    required: CHALLENGE_REQUIRED,
  };
}

function buildContentChallenge(base: Record<string, unknown>) {
  return {
    type: 'object',
    properties: {
      ...base,
      evidenceRefs: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', const: 'content' },
            digest: { type: 'string', minLength: 1 },
          },
          required: ['kind', 'digest'],
        },
      },
      outcome: { type: 'string', enum: ['supported', 'contradicted', 'not_verified'] },
    },
    required: CHALLENGE_REQUIRED,
  };
}

const REVIEW_SUBJECT_ANCHOR_JSON_SCHEMA = {
  oneOf: ANCHOR_KINDS.map(buildAnchorVariant),
} as const;

const FINDING_RELATION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    subjectAnchors: { type: 'array', minItems: 1, items: REVIEW_SUBJECT_ANCHOR_JSON_SCHEMA },
    evidenceLocations: { type: 'array', items: REPOSITORY_LOCATION_JSON_SCHEMA },
  },
  required: ['subjectAnchors', 'evidenceLocations'],
} as const;

export const REVIEW_FINDINGS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    iteration: { type: 'integer', minimum: 0 },
    planVersion: { type: 'integer', minimum: 1 },
    reviewMode: { type: 'string', const: 'subagent' },
    overallVerdict: { type: 'string', enum: [...OVERALL_VERDICT_VALUES] },
    blockingIssues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: [...SEVERITY_VALUES] },
          category: {
            type: 'string',
            enum: [...CATEGORY_VALUES],
          },
          message: { type: 'string' },
          relation: FINDING_RELATION_JSON_SCHEMA,
        },
        required: ['severity', 'category', 'message', 'relation'],
      },
    },
    majorRisks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: [...SEVERITY_VALUES] },
          category: {
            type: 'string',
            enum: [...CATEGORY_VALUES],
          },
          message: { type: 'string' },
          relation: FINDING_RELATION_JSON_SCHEMA,
        },
        required: ['severity', 'category', 'message', 'relation'],
      },
    },
    missingVerification: { type: 'array', items: { type: 'string' } },
    scopeCreep: { type: 'array', items: { type: 'string' } },
    unknowns: { type: 'array', items: { type: 'string' } },
    challenges: {
      type: 'array',
      items: {
        oneOf: CHALLENGE_KINDS.map(buildChallengeVariant),
      },
    },
    challengeResolutionVerdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          challengeId: {
            type: 'string',
            pattern:
              '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
          },
          verdict: { type: 'string', enum: ['resolved', 'still_failing', 'not_verified'] },
        },
        required: ['challengeId', 'verdict'],
      },
    },
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

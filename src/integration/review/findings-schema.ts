/**
 * @module integration/review-findings-schema
 * @description JSON Schema definition for the ReviewFindings structured output.
 *
 * This schema is passed to the OpenCode SDK `session.prompt()` format field
 * to enforce structured JSON output from the reviewer subagent.
 *
 * Enum values and discriminator variants are rendered from reviewer-contract.ts,
 * the reviewer-facing projection of the canonical model-output authority
 * `ReviewerFindingsInput` (src/state/evidence-review-input.ts). Drift from the
 * canonical Zod contract is detected by reviewer-contract.test.ts and
 * findings-schema-drift.test.ts.
 *
 * @version v4 — reviewer-facing projection of ReviewerFindingsInput
 */

import {
  ANCHOR_KINDS,
  ARTIFACT_KIND_VALUES,
  CATEGORY_VALUES,
  CHALLENGE_KINDS,
  CHALLENGE_OUTCOMES,
  CHALLENGE_RESOLUTION_VERDICT_VALUES,
  OVERALL_VERDICT_VALUES,
  REVISION_VALUES,
  SEVERITY_VALUES,
} from './context/reviewer-contract.js';

/**
 * RFC 4122 UUID pattern. Single declaration for every UUID-typed field in this
 * schema; drift against `z.string().uuid()` is guarded by
 * findings-schema-drift.test.ts.
 */
const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

/** Typed failure for a canonical kind the JSON schema builder cannot render. */
class ReviewFindingsSchemaConstructionError extends Error {
  readonly code = 'REVIEW_FINDINGS_SCHEMA_EXHAUSTIVENESS';

  constructor(message: string) {
    super(message);
    this.name = 'ReviewFindingsSchemaConstructionError';
  }
}

/**
 * Exhaustiveness contract: reaching this with a concrete value means a
 * canonical kind tuple gained a variant whose builder handling is missing —
 * which is a compile error (`value` is no longer `never`), not just a runtime
 * fallback.
 */
function assertNever(value: never, surface: string): never {
  throw new ReviewFindingsSchemaConstructionError(
    `Unexpected ${surface} variant: ${String(value)} — update findings-schema.ts`,
  );
}

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
      additionalProperties: false,
    },
  ],
} as const;

function buildAnchorVariant(kind: (typeof ANCHOR_KINDS)[number]): Record<string, unknown> {
  switch (kind) {
    case 'repository_location':
      return {
        type: 'object',
        properties: {
          kind: { type: 'string', const: kind },
          location: REPOSITORY_LOCATION_JSON_SCHEMA,
        },
        required: ['kind', 'location'],
        additionalProperties: false,
      };
    case 'artifact_section':
      return {
        type: 'object',
        properties: {
          kind: { type: 'string', const: kind },
          artifactKind: { type: 'string', enum: [...ARTIFACT_KIND_VALUES] },
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
              additionalProperties: false,
            },
          },
        },
        required: ['kind', 'artifactKind', 'artifactDigest', 'sectionPath'],
        additionalProperties: false,
      };
    case 'content':
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
            additionalProperties: false,
          },
        },
        required: ['kind', 'subjectDigest'],
        additionalProperties: false,
      };
    case 'implementation':
      return {
        type: 'object',
        properties: {
          kind: { type: 'string', const: kind },
          implementationDigest: { type: 'string', minLength: 1 },
        },
        required: ['kind', 'implementationDigest'],
        additionalProperties: false,
      };
    default:
      return assertNever(kind, 'anchor');
  }
}

function buildChallengeVariant(kind: (typeof CHALLENGE_KINDS)[number]): Record<string, unknown> {
  const base = challengeBase(kind);
  switch (kind) {
    case 'design_challenge':
      return buildDesignChallenge(base);
    case 'implementation_challenge':
      return buildImplementationChallenge(base);
    case 'content_challenge':
      return buildContentChallenge(base);
    default:
      return assertNever(kind, 'challenge');
  }
}

function challengeBase(kind: string) {
  return {
    obligationId: {
      type: 'string',
      pattern: UUID_PATTERN,
    },
    clientReference: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      pattern: '^[a-zA-Z0-9_-]+$',
    },
    scenario: { type: 'string', minLength: 1 },
    claim: { type: 'string', minLength: 1 },
    locations: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
    kind: { type: 'string', const: kind },
  } as const;
}

const CHALLENGE_REQUIRED = [
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
            artifactKind: { type: 'string', enum: [...ARTIFACT_KIND_VALUES] },
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
                additionalProperties: false,
              },
            },
            excerptDigest: { type: 'string', minLength: 1 },
          },
          required: ['kind', 'artifactKind', 'artifactDigest', 'sectionPath', 'excerptDigest'],
          additionalProperties: false,
        },
      },
      outcome: { type: 'string', enum: [...CHALLENGE_OUTCOMES.design_challenge] },
    },
    required: CHALLENGE_REQUIRED,
    additionalProperties: false,
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
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: {
                kind: { type: 'string', const: 'validation_attempt' },
                attemptId: {
                  type: 'string',
                  pattern: UUID_PATTERN,
                },
              },
              required: ['kind', 'attemptId'],
              additionalProperties: false,
            },
          ],
        },
      },
      outcome: { type: 'string', enum: [...CHALLENGE_OUTCOMES.implementation_challenge] },
    },
    required: CHALLENGE_REQUIRED,
    additionalProperties: false,
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
          additionalProperties: false,
        },
      },
      outcome: { type: 'string', enum: [...CHALLENGE_OUTCOMES.design_challenge] },
    },
    required: CHALLENGE_REQUIRED,
    additionalProperties: false,
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
  additionalProperties: false,
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
        additionalProperties: false,
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
        additionalProperties: false,
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
            pattern: UUID_PATTERN,
          },
          verdict: { type: 'string', enum: [...CHALLENGE_RESOLUTION_VERDICT_VALUES] },
        },
        required: ['challengeId', 'verdict'],
        additionalProperties: false,
      },
    },
    attestation: {
      type: 'object',
      properties: {
        toolObligationId: {
          type: 'string',
          pattern: UUID_PATTERN,
        },
      },
      required: ['toolObligationId'],
      additionalProperties: false,
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
    'attestation',
    'challenges',
  ],
  additionalProperties: false,
} as const;

/**
 * @file finding-relation-grammar.test.ts
 * @description Integration test: the FindingRelation grammar renders correctly
 * in the reviewer prompt and valid findings with repository_location anchors,
 * correct revision aliases, and repo-wide evidence pass validation.
 */
import { describe, it, expect } from 'vitest';
import { renderFindingRelationGrammar } from './finding-relation-grammar.js';
import { renderReviewerTaskPrompt } from './prompt-builders.js';
import { ReviewFindings } from '../../state/evidence.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../shared/flowguard-identifiers.js';

const OBLIGATION_ID = '9b2e5cd6-dc49-4d5b-a6d7-06eb6c5255ea';
const MANDATE_DIGEST = 'eaba0884d2ab1653e77f58b1d33eb9fa678ebb38ef555c2ebcfbcef747dcd558';
const CRITERIA_VERSION = 'p40-v1';

const BASE_INPUT = {
  iteration: 1,
  planVersion: 1 as const,
  obligationId: OBLIGATION_ID,
  mandateDigest: MANDATE_DIGEST,
  criteriaVersion: CRITERIA_VERSION,
  subjectLabel: 'the branch diff',
};

describe('renderFindingRelationGrammar', () => {
  it('renders the Finding Output Contract heading', () => {
    const grammar = renderFindingRelationGrammar();
    expect(grammar).toContain('## Finding Output Contract');
  });

  it('documents severity enum: critical, major, minor', () => {
    const grammar = renderFindingRelationGrammar();
    expect(grammar).toContain('"critical" | "major" | "minor"');
  });

  it('documents category enum: completeness, correctness, feasibility, risk, quality', () => {
    const grammar = renderFindingRelationGrammar();
    expect(grammar).toContain(
      '"completeness" | "correctness" | "feasibility" | "risk" | "quality"',
    );
  });

  it('documents all three subjectAnchor kinds', () => {
    const grammar = renderFindingRelationGrammar();
    expect(grammar).toContain('repository_location');
    expect(grammar).toContain('artifact_section');
    expect(grammar).toContain('content');
  });

  it('documents revision as base|head, never SHA', () => {
    const grammar = renderFindingRelationGrammar();
    expect(grammar).toContain('"base" | "head"');
    expect(grammar).toContain('never a SHA');
  });

  it('documents evidenceLocations as optional (may be empty)', () => {
    const grammar = renderFindingRelationGrammar();
    expect(grammar).toContain('evidenceLocations MAY be empty');
  });

  it('rejects "info" severity (must not appear)', () => {
    const grammar = renderFindingRelationGrammar();
    // "info" should not appear as a severity option anywhere
    expect(grammar).not.toMatch(/"info"/);
  });
});

describe('renderReviewerTaskPrompt includes grammar', () => {
  it('contains the Finding Output Contract heading', () => {
    const prompt = renderReviewerTaskPrompt(BASE_INPUT);
    expect(prompt).toContain('## Finding Output Contract');
  });

  it('contains the subject anchors section', () => {
    const prompt = renderReviewerTaskPrompt(BASE_INPUT);
    expect(prompt).toContain('### subjectAnchors');
  });

  it('contains revision rules', () => {
    const prompt = renderReviewerTaskPrompt(BASE_INPUT);
    expect(prompt).toContain('### Revision Rules');
  });

  it('grammar appears before the append marker', () => {
    const prompt = renderReviewerTaskPrompt(BASE_INPUT);
    const grammarIndex = prompt.indexOf('## Finding Output Contract');
    const appendIndex = prompt.indexOf('Append the');
    expect(grammarIndex).toBeGreaterThan(-1);
    expect(appendIndex).toBeGreaterThan(grammarIndex);
  });
});

describe('valid findings pass ReviewFindings validation', () => {
  const validFinding = {
    severity: 'major' as const,
    category: 'completeness' as const,
    message: 'dueDate field in CreateTaskRequest lacks validation annotations',
    relation: {
      subjectAnchors: [
        {
          kind: 'repository_location' as const,
          location: {
            path: 'src/main/java/com/example/taskmanager/dto/CreateTaskRequest.java',
            revision: 'head' as const,
            line: 18,
          },
        },
      ],
      evidenceLocations: [
        {
          path: 'src/main/java/com/example/taskmanager/service/TaskService.java',
          revision: 'head' as const,
          line: 42,
        },
      ],
    },
  };

  const basePayload = {
    iteration: 1,
    planVersion: 1,
    reviewMode: 'subagent' as const,
    overallVerdict: 'changes_requested' as const,
    blockingIssues: [validFinding],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId: 'ses_reviewer123' },
    reviewedAt: '2026-08-12T00:00:00.000Z',
    attestation: {
      mandateDigest: MANDATE_DIGEST,
      criteriaVersion: CRITERIA_VERSION,
      toolObligationId: OBLIGATION_ID,
      iteration: 1,
      planVersion: 1,
      reviewedBy: REVIEWER_SUBAGENT_TYPE,
    },
  };

  it('accepts findings with repository_location anchor and repo-wide evidence', () => {
    const result = ReviewFindings.safeParse(basePayload);
    expect(result.success).toBe(true);
  });

  it('accepts findings with content anchor', () => {
    const contentPayload = {
      ...basePayload,
      blockingIssues: [
        {
          severity: 'major' as const,
          category: 'completeness' as const,
          message: 'External content has an issue',
          relation: {
            subjectAnchors: [
              {
                kind: 'content' as const,
                subjectDigest: 'abc123def456',
              },
            ],
            evidenceLocations: [],
          },
        },
      ],
    };
    const result = ReviewFindings.safeParse(contentPayload);
    expect(result.success).toBe(true);
  });

  it('rejects findings with invalid revision value', () => {
    const invalidPayload = {
      ...basePayload,
      blockingIssues: [
        {
          ...validFinding,
          relation: {
            ...validFinding.relation,
            subjectAnchors: [
              {
                kind: 'repository_location' as const,
                location: {
                  path: 'src/main/java/com/example/taskmanager/dto/CreateTaskRequest.java',
                  revision: 'current' as const, // invalid
                },
              },
            ],
          },
        },
      ],
    };
    const result = ReviewFindings.safeParse(invalidPayload);
    expect(result.success).toBe(false);
  });

  it('rejects findings with invalid anchor kind', () => {
    const invalidPayload = {
      ...basePayload,
      blockingIssues: [
        {
          ...validFinding,
          relation: {
            ...validFinding.relation,
            subjectAnchors: [
              {
                kind: 'file_path' as const, // invalid discriminator
              },
            ],
          },
        },
      ],
    };
    const result = ReviewFindings.safeParse(invalidPayload);
    expect(result.success).toBe(false);
  });

  it('accepts findings with empty evidenceLocations', () => {
    const emptyEvidence = {
      ...basePayload,
      blockingIssues: [
        {
          ...validFinding,
          relation: {
            ...validFinding.relation,
            evidenceLocations: [],
          },
        },
      ],
    };
    const result = ReviewFindings.safeParse(emptyEvidence);
    expect(result.success).toBe(true);
  });

  it('rejects findings without subjectAnchors', () => {
    const noAnchors = {
      ...basePayload,
      blockingIssues: [
        {
          ...validFinding,
          relation: {
            subjectAnchors: [],
            evidenceLocations: [],
          },
        },
      ],
    };
    const result = ReviewFindings.safeParse(noAnchors);
    expect(result.success).toBe(false);
  });

  it('accepts findings with artifact_section anchor', () => {
    const artifactPayload = {
      ...basePayload,
      blockingIssues: [
        {
          severity: 'major' as const,
          category: 'correctness' as const,
          message: 'Plan section has an inconsistency',
          relation: {
            subjectAnchors: [
              {
                kind: 'artifact_section' as const,
                artifactKind: 'plan' as const,
                artifactDigest: 'abc123',
                sectionPath: [{ headingDepth: 2, siblingIndex: 1, headingText: 'Architecture' }],
              },
            ],
            evidenceLocations: [],
          },
        },
      ],
    };
    const result = ReviewFindings.safeParse(artifactPayload);
    expect(result.success).toBe(true);
  });
});

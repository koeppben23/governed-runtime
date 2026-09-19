/**
 * @module presentation/review-report-card.test
 * @description Unit tests for buildReviewReportCard.
 */
import { describe, it, expect } from 'vitest';
import {
  buildReviewReportCard as buildCard,
  type ReviewReportCardInput,
} from './review-report-card.js';
import type { CompactProofPresentation } from './proof-model.js';
import type { PeerReviewCoverage, ReviewReportFinding } from '../state/evidence.js';
import type { WorkflowDirective } from '../machine/workflow-directive.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

async function readGolden(name: string): Promise<string> {
  const p = resolve(__dirname, '..', '..', 'testdata', 'presentation', name);
  return (await readFile(p, 'utf-8')).trimEnd();
}

const exportDirective: WorkflowDirective = {
  kind: 'user_action',
  code: 'EXPORT_REQUIRED',
  allowedIntents: ['EXPORT'],
  commands: ['/export'],
};

const baseCoverage = {
  targetResolved: true,
  targetFrozen: true,
  repositoryIdentityVerified: true,
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  changedPathCount: 1,
  objectivesCovered: 3,
  objectivesTotal: 3,
  reviewAssurance: 'structured_high',
  missingVerification: [],
} satisfies PeerReviewCoverage;

const baseInput = {
  phase: 'PEER_REVIEW_COMPLETE' as const,
  phaseLabel: 'Peer review complete',
  overallStatus: 'clean' as const,
  findings: [] as ReviewReportFinding[],
  coverage: baseCoverage,
  proofSummary: {
    kind: 'evaluation',
    overallStatus: 'NOT_DECLARED',
    claimCount: 0,
    criticalCount: 0,
    criticalProvenCount: 0,
    provenCount: 0,
    contradictedCount: 0,
    blockedCount: 0,
    staleCount: 0,
    unprovenCount: 0,
    notVerifiedCount: 0,
    coverage: 'NOT_DECLARED',
    unmetCriticalClaims: [],
    otherHighlightedClaims: [],
    approval: { attestations: [] },
    decisionContext: 'completion',
  } satisfies CompactProofPresentation,
  directive: exportDirective,
  conclusionAction: {
    invocation: '/export',
    description: 'Export the review evidence.',
    visibility: 'recommended' as const,
  },
};
const relation = {
  evidenceLocations: [{ path: 'test/evidence.test.ts', revision: 'head' as const, line: 4 }],
  subjectAnchors: [
    {
      kind: 'repository_location' as const,
      location: { path: 'src/subject.ts', revision: 'base' as const, line: 8 },
    },
  ],
} satisfies import('./model.js').FindingRelationPresentation;

function materialFinding(
  reportSeverity: 'info' | 'warning' | 'error',
  severity: 'critical' | 'major' | 'minor',
  category: 'completeness' | 'correctness' | 'feasibility' | 'risk' | 'quality',
  message: string,
): ReviewReportFinding {
  return {
    source: 'material_finding',
    reportSeverity,
    finding: { severity, category, message, relation },
  };
}
function buildReviewReportCard(
  input: Omit<ReviewReportCardInput, 'proofSummary' | 'directive' | 'conclusionAction'> &
    Partial<Pick<ReviewReportCardInput, 'proofSummary' | 'directive' | 'conclusionAction'>>,
  options?: Parameters<typeof buildCard>[1],
) {
  return buildCard({ ...baseInput, ...input }, options);
}

describe('buildReviewReportCard', () => {
  it('preserves default bytes when rendering a transient ASCII profile', () => {
    const canonical = buildReviewReportCard(baseInput);

    expect(buildReviewReportCard(baseInput)).toBe(canonical);
    expect(buildReviewReportCard(baseInput, { glyphProfile: 'ascii' })).toContain('[NEXT]');
  });

  it('renders header with status and the frozen reviewed subject', () => {
    const card = buildReviewReportCard({
      ...baseInput,
      reviewSubject: {
        kind: 'repository_change',
        source: { kind: 'pull_request', pullRequestNumber: 42 },
        baseRepository: { host: 'github.com', owner: 'owner', name: 'repo' },
        headRepository: { host: 'github.com', owner: 'owner', name: 'repo' },
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        changedPaths: ['src/review.ts'],
        materialDigest: 'c'.repeat(64),
        subjectDigest: 'd'.repeat(64),
      },
    });
    expect(card).toContain('# FlowGuard Review Report');
    expect(card).toContain('**Status:** Peer review complete');
    expect(card).toContain('**Reviewed subject:** Pull request #42 (1 changed paths)');
  });

  it('renders content subject sources without exposing raw reference input', () => {
    const card = buildReviewReportCard({
      ...baseInput,
      reviewSubject: {
        kind: 'content',
        source: {
          kind: 'url',
          url: {
            requested: { origin: 'https://input.example', pathname: '/raw' },
            resolved: { origin: 'https://review.example', pathname: '/safe_path' },
          },
        },
        materialDigest: 'a'.repeat(64),
        subjectDigest: 'b'.repeat(64),
        lineCount: 12,
      },
    });
    expect(card).toContain(
      '**Reviewed subject:** URL https://review\\.example/safe\\_path (12 lines)',
    );
    expect(card).not.toContain('input.example');
  });

  it('escapes branch source text before rendering it in Markdown', () => {
    const card = buildReviewReportCard({
      ...baseInput,
      reviewSubject: {
        kind: 'repository_change',
        source: { kind: 'branch', branch: 'feature/[unsafe](branch)' },
        baseRepository: { host: 'github.com', owner: 'owner', name: 'repo' },
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        changedPaths: ['src/review.ts'],
        materialDigest: 'c'.repeat(64),
        subjectDigest: 'd'.repeat(64),
      },
    });
    expect(card).toContain('Branch feature/\\[unsafe\\]\\(branch\\)');
  });

  it('renders all finding groups sorted by severity', () => {
    const card = buildReviewReportCard({
      ...baseInput,
      overallStatus: 'issues',
      findings: [
        materialFinding('error', 'critical', 'risk', 'SQL injection vulnerability'),
        materialFinding('error', 'major', 'correctness', 'Logic error in token refresh'),
        materialFinding('warning', 'minor', 'quality', 'Unused import'),
        {
          source: 'unknown',
          reportSeverity: 'info',
          category: 'unknown',
          message: 'Load test results unavailable',
        },
      ],
    });
    expect(card).toContain('### Issues (2)');
    expect(card).toContain('SQL injection vulnerability');
    expect(card).toContain('Logic error in token refresh');
    expect(card).toContain('### Warnings (1)');
    expect(card).toContain('### Notes (1)');
  });

  it('omits evidence section when no evidence fields present', () => {
    const card = buildReviewReportCard(baseInput);
    expect(card).not.toContain('## Evidence');
  });

  it('renders evidence section when obligationId present', () => {
    const card = buildReviewReportCard({
      ...baseInput,
      obligationId: '00000000-0000-0000-0000-000000000001',
      invocationSource: 'host-orchestrated',
      reviewerSessionId: 'child-session-1',
    });
    expect(card).toContain('## Evidence');
    expect(card).toContain('00000000-0000-0000-0000-000000000001');
    expect(card).toContain('host-orchestrated');
    expect(card).toContain('child-session-1');
  });

  it('renders the Target coverage section from canonical coverage fields', () => {
    const card = buildReviewReportCard(baseInput);
    expect(card).toContain('## Target coverage');
    expect(card).toContain('**Target resolved:** yes');
    expect(card).toContain('**Target frozen:** yes');
    expect(card).toContain('**Repository identity:** verified');
    expect(card).toContain(`**Base SHA:** ${'a'.repeat(40)}`);
    expect(card).toContain(`**Head SHA:** ${'b'.repeat(40)}`);
    expect(card).toContain('**Changed paths:** 1');
    expect(card).toContain('**Objectives covered:** 3/3');
    expect(card).toContain('**Review assurance:** structured_high');
    expect(card).toContain('**Missing verification:** none');
  });

  it('renders nullable target coverage and missing-verification messages', () => {
    const card = buildReviewReportCard({
      ...baseInput,
      coverage: {
        targetResolved: false,
        targetFrozen: false,
        repositoryIdentityVerified: null,
        baseSha: null,
        headSha: null,
        changedPathCount: 0,
        objectivesCovered: 0,
        objectivesTotal: 0,
        reviewAssurance: null,
        missingVerification: ['Run the integration suite', 'Record the branch coverage'],
      },
    });
    expect(card).toContain('**Target resolved:** no');
    expect(card).toContain('**Target frozen:** no');
    expect(card).toContain('**Repository identity:** not applicable');
    expect(card).toContain('**Base SHA:** not recorded');
    expect(card).toContain('**Head SHA:** not recorded');
    expect(card).toContain('**Changed paths:** 0');
    expect(card).toContain('**Objectives covered:** 0/0');
    expect(card).toContain('**Review assurance:** not recorded');
    expect(card).toContain(
      '**Missing verification:** Run the integration suite; Record the branch coverage',
    );
  });

  it('never renders the local-session completeness matrix or four-eyes line', () => {
    const card = buildReviewReportCard(baseInput);
    expect(card).not.toContain('## Completeness');
    expect(card).not.toContain('Four-eyes');
    expect(card).not.toContain('Not assessed');
    expect(card).not.toContain('Overall complete');
    expect(card).not.toContain('Incomplete');
  });

  it('has no command footer (/approve, /request-changes, /reject)', () => {
    const card = buildReviewReportCard(baseInput);
    expect(card).not.toContain('/approve');
    expect(card).not.toContain('/request-changes');
    expect(card).not.toContain('/reject');
    // The canonical export conclusion action is preserved verbatim.
    expect(card).toContain('→ `/export` — Export the review evidence.');
  });

  it('renders a terminal conclusion when the directive carries no command', () => {
    // PEER_REVIEW_COMPLETE resolves the terminal PEER_REVIEW_COMPLETE directive with
    // no commands; the card must render a valid terminal document rather than
    // failing the success-form presentation contract.
    const { conclusionAction: _conclusionAction, ...baseWithoutConclusion } = baseInput;
    const card = buildCard({
      ...baseWithoutConclusion,
      directive: {
        kind: 'terminal',
        code: 'PEER_REVIEW_COMPLETE',
        commands: [],
      },
    });
    expect(card).toContain('Peer review complete.');
    expect(card).not.toContain('/export');
  });

  it('shows "no follow-up required" when findings are empty', () => {
    const card = buildReviewReportCard(baseInput);
    expect(card).toContain('No follow-up required from this review');
  });

  it('shows action follow-up when critical/major findings present', () => {
    const card = buildReviewReportCard({
      ...baseInput,
      findings: [materialFinding('error', 'critical', 'risk', 'SQL injection')],
    });
    expect(card).toContain('Address critical and major findings');
    expect(card).not.toContain('No follow-up required');
  });
});

// ─── Golden Baseline Tests ──────────────────────────────────────────────────────

describe('implementation review golden fixtures', () => {
  it('review-impl-accepted matches golden output', async () => {
    const card = buildReviewReportCard({
      phase: 'IMPL_REVIEW',
      phaseLabel: 'Implementation review in progress',
      overallStatus: 'clean',
      findings: [],
      coverage: baseCoverage,
    });
    expect(card).toBe(await readGolden('review-impl-accepted.md'));
  });

  it('review-impl-changes-requested matches golden output', async () => {
    const card = buildReviewReportCard({
      phase: 'IMPL_REVIEW',
      phaseLabel: 'Implementation review in progress',
      overallStatus: 'issues',
      findings: [
        materialFinding('error', 'critical', 'correctness', 'Missing null check'),
        materialFinding('error', 'major', 'quality', 'Missing test coverage'),
      ],
      coverage: {
        ...baseCoverage,
        objectivesCovered: 2,
        missingVerification: ['Add regression coverage'],
      },
    });
    expect(card).toBe(await readGolden('review-impl-changes-requested.md'));
  });
});

describe('peer review golden fixtures', () => {
  it('review-compliance-clean matches golden output', async () => {
    const card = buildReviewReportCard({
      phase: 'PEER_REVIEW_COMPLETE',
      phaseLabel: 'Peer review complete',
      overallStatus: 'clean',
      findings: [],
      coverage: baseCoverage,
      obligationId: 'oblig-001',
      invocationSource: 'host-orchestrated',
    });
    expect(card).toBe(await readGolden('review-compliance-clean.md'));
  });

  it('review-compliance-issues-found matches golden output', async () => {
    const card = buildReviewReportCard({
      phase: 'PEER_REVIEW_COMPLETE',
      phaseLabel: 'Peer review complete',
      overallStatus: 'issues',
      findings: [
        materialFinding('error', 'critical', 'completeness', 'Missing evidence'),
        materialFinding('error', 'major', 'risk', 'Untracked dependency'),
        materialFinding('warning', 'minor', 'quality', 'Missing changelog entry'),
      ],
      coverage: {
        ...baseCoverage,
        objectivesCovered: 2,
        missingVerification: ['Run the missing regression test'],
      },
      invocationSource: 'host-orchestrated',
      obligationId: 'oblig-002',
    });
    expect(card).toBe(await readGolden('review-compliance-issues-found.md'));
  });
});

/**
 * @module integration/tools/review-tool/obligation-format.test
 * @description Contract: blocked-review messages address a concrete obligation.
 *
 * The agent is instructed to re-run `flowguard_review` with the obligation id
 * quoted in this message. An unresolved placeholder makes that instruction
 * unfollowable and, in host-task mode, strands the review flow.
 */

import { describe, it, expect } from 'vitest';
import { formatMissingContentAnalysis, repositoryFromBranchSubject } from './obligation-format.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../../shared/flowguard-identifiers.js';

const OBLIGATION_ID = 'f8163adf-6604-435a-b3ae-bae1b6b3ea08';

describe('formatMissingContentAnalysis', () => {
  it('interpolates the obligation id into the host-task continuation instruction', () => {
    const parsed = JSON.parse(formatMissingContentAnalysis(OBLIGATION_ID, true)) as {
      code: string;
      message: string;
      reviewObligationId: string;
    };

    expect(parsed.code).toBe('CONTENT_ANALYSIS_REQUIRED');
    expect(parsed.reviewObligationId).toBe(OBLIGATION_ID);
    expect(parsed.message).toContain(`reviewObligationId '${OBLIGATION_ID}'`);
    // Regression: the host-task branch was a plain double-quoted string nested
    // in a template literal, so the placeholder reached the agent verbatim.
    expect(parsed.message).not.toContain('${obligationId}');
  });

  it('keeps the findings-submission instruction for non-host-task policies', () => {
    const parsed = JSON.parse(formatMissingContentAnalysis(OBLIGATION_ID, false)) as {
      message: string;
    };

    expect(parsed.message).toContain(REVIEWER_SUBAGENT_TYPE);
    expect(parsed.message).toContain('complete ReviewFindings object');
    expect(parsed.message).not.toContain('${obligationId}');
    expect(parsed.message).not.toContain('reviewObligationId');
  });
});

describe('repositoryFromBranchSubject', () => {
  function subject(
    baseRepository: unknown,
    headRepository: unknown,
  ): Parameters<typeof repositoryFromBranchSubject>[0] {
    return {
      kind: 'repository_change',
      source: { kind: 'branch', branch: 'feature/x' },
      baseRepository,
      headRepository,
      baseSha: 'b'.repeat(40),
      headSha: 'a'.repeat(40),
      changedPaths: ['src/app.ts'],
      materialDigest: 'd'.repeat(64),
      subjectDigest: 'e'.repeat(64),
    } as Parameters<typeof repositoryFromBranchSubject>[0];
  }

  const REMOTE = { host: 'github.com', owner: 'flowguard', name: 'governed-runtime' };
  const LOCAL = { kind: 'local' as const, rootCommitDigest: 'c'.repeat(64) };

  it('returns a remote identity frozen on both sides', () => {
    expect(repositoryFromBranchSubject(subject(REMOTE, { ...REMOTE }))).toEqual(REMOTE);
  });

  it('returns a local identity frozen on both sides', () => {
    // A repository without a parseable origin freezes this shape. Recognising
    // only the remote shape dropped it, so continuations rebuilt a subject
    // without baseRepository and failed schema validation.
    expect(repositoryFromBranchSubject(subject(LOCAL, { ...LOCAL }))).toEqual(LOCAL);
  });

  it('returns undefined when base and head identities differ', () => {
    expect(repositoryFromBranchSubject(subject(LOCAL, REMOTE))).toBeUndefined();
    expect(
      repositoryFromBranchSubject(
        subject(LOCAL, { kind: 'local', rootCommitDigest: 'f'.repeat(64) }),
      ),
    ).toBeUndefined();
    expect(
      repositoryFromBranchSubject(subject(REMOTE, { ...REMOTE, name: 'other' })),
    ).toBeUndefined();
  });

  it('compares identities structurally, not by serialized key order', () => {
    const reordered = { name: REMOTE.name, host: REMOTE.host, owner: REMOTE.owner };
    expect(repositoryFromBranchSubject(subject(REMOTE, reordered))).toEqual(REMOTE);
  });

  it('returns undefined without a head identity or for a content subject', () => {
    expect(repositoryFromBranchSubject(subject(LOCAL, undefined))).toBeUndefined();
    expect(repositoryFromBranchSubject(undefined)).toBeUndefined();
  });
});

/**
 * @module documentation/review-counter-cases.test
 * @description Recorded plan-review false positives (`demos/review-counter-cases`)
 * must stay well-formed and must not drift from the repository facts that refute
 * them: script bodies, test methods, the revisions each obligation authority can
 * observe, and the scoped fixture wording. Run observations cannot be re-derived
 * here and every case keeps `behaviorStatus: NOT_VERIFIED`: a recorded case is a
 * counter-example, never evidence that a reviewer now behaves correctly.
 *
 * @test-policy HAPPY, BAD
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  resolveObservationRevisions,
  type FrozenRepositoryRevisionTargetValue,
} from '../../state/evidence-review-authority.js';

const ROOT = path.join(__dirname, '../../..');
const CASE_FILE = 'demos/review-counter-cases/plan-review-false-positives.json';

const Revision = z.enum(['base', 'head']);

const Evidence = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('run_observation'), description: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal('repository_script'),
      file: z.string().min(1),
      script: z.string().min(1),
      body: z.string().min(1),
      description: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('repository_test_method'),
      file: z.string().min(1),
      method: z.string().min(1),
      description: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('observation_authority'),
      obligationType: z.enum(['plan', 'architecture', 'implement']),
      authorityKind: z.enum(['context', 'candidate_pair']),
      revisions: z.array(Revision).min(1),
      description: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('fixture_text'),
      file: z.string().min(1),
      text: z.string().min(1),
      description: z.string().min(1),
    })
    .strict(),
]);

const CounterCase = z
  .object({
    caseId: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    source: z
      .object({
        commit: z.string().regex(/^[0-9a-f]{7,40}$/),
        scenario: z.string().min(1),
        fixture: z.string().startsWith('demos/'),
        runDirectory: z.string().min(1).nullable(),
        childSessionId: z.string().min(1).nullable(),
        unresolved: z.string().min(1).optional(),
      })
      .strict(),
    obligationType: z.literal('plan'),
    classification: z.enum([
      'check_capability_misread',
      'phase_observation_scope',
      'self_declared_minor_blocking',
    ]),
    reviewerAssertion: z
      .object({ kind: z.enum(['verbatim', 'paraphrase']), text: z.string().min(1) })
      .strict(),
    refutingEvidence: z.array(Evidence).min(1),
    legitimateObjections: z.array(z.string().min(1)).optional(),
    expectedReviewerBehavior: z.string().min(1),
    reportCorrection: z
      .object({
        report: z.string().min(1),
        supersedes: z.string().min(1),
        correctedClassification: z.literal('false_positive'),
      })
      .strict(),
    behaviorStatus: z.literal('NOT_VERIFIED'),
  })
  .strict()
  .refine(
    (entry) =>
      (entry.source.runDirectory !== null && entry.source.childSessionId !== null) ||
      entry.source.unresolved !== undefined,
    { message: 'a missing run directory or child session must state why it is unresolved' },
  );

const CounterCaseFile = z
  .object({
    schemaVersion: z.literal('review-counter-cases.v1'),
    description: z.string().min(1),
    cases: z.array(CounterCase).min(1),
  })
  .strict();

const raw: unknown = JSON.parse(fs.readFileSync(path.join(ROOT, CASE_FILE), 'utf8'));
const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const prose = (text: string): string => text.replace(/\s+/g, ' ');

const TARGET: FrozenRepositoryRevisionTargetValue = {
  kind: 'commit',
  repositoryIdentity: { kind: 'local', rootCommitDigest: `sha256:${'a'.repeat(64)}` },
  objectSha: 'b'.repeat(40),
};

function revisionsFor(authorityKind: 'context' | 'candidate_pair') {
  return resolveObservationRevisions({
    repositoryAuthority:
      authorityKind === 'context'
        ? { kind: 'context', context: TARGET }
        : { kind: 'candidate_pair', base: TARGET, head: TARGET },
  });
}

describe('plan-review counter cases', () => {
  const parsed = CounterCaseFile.parse(raw);
  const evidence = parsed.cases.flatMap((entry) => entry.refutingEvidence);

  it('HAPPY: cases are schema-valid, uniquely identified, and never claim verified behavior', () => {
    const ids = parsed.cases.map((entry) => entry.caseId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of parsed.cases) {
      expect(entry.behaviorStatus).toBe('NOT_VERIFIED');
      expect(fs.existsSync(path.join(ROOT, entry.source.fixture)), entry.caseId).toBe(true);
    }
  });

  it('HAPPY: covers both recorded false-positive classes of the 1ed7c479 run', () => {
    const classes = new Set(parsed.cases.map((entry) => entry.classification));
    expect(classes).toContain('check_capability_misread');
    expect(classes).toContain('phase_observation_scope');
  });

  it('HAPPY: repository script references match the fixture package scripts', () => {
    const scripts = evidence.filter((item) => item.kind === 'repository_script');
    expect(scripts.length).toBeGreaterThan(0);
    for (const item of scripts) {
      const pkg = JSON.parse(read(item.file)) as { scripts: Record<string, string> };
      expect(pkg.scripts[item.script], item.file).toBe(item.body);
      if (item.body.includes('mvnw verify')) {
        // verify only observes test assertions when the test phase is not skipped.
        const pom = read(path.join(path.dirname(item.file), 'pom.xml'));
        expect(pom).not.toMatch(/skipTests|maven\.test\.skip/);
      }
    }
  });

  it('HAPPY: referenced test methods exist in the fixture sources', () => {
    const methods = evidence.filter((item) => item.kind === 'repository_test_method');
    expect(methods.length).toBeGreaterThan(0);
    for (const item of methods) {
      expect(read(item.file), `${item.file}#${item.method}`).toMatch(
        new RegExp(`void ${item.method}\\(`),
      );
    }
  });

  it('HAPPY: observation-authority references match the real revision authority', () => {
    const authorities = evidence.filter((item) => item.kind === 'observation_authority');
    expect(authorities.length).toBeGreaterThan(0);
    for (const item of authorities) {
      expect(revisionsFor(item.authorityKind), item.description).toEqual(item.revisions);
    }
  });

  it('HAPPY: fixture-text references are present in the scoped fixture wording', () => {
    const texts = evidence.filter((item) => item.kind === 'fixture_text');
    expect(texts.length).toBeGreaterThan(0);
    for (const item of texts) {
      expect(prose(read(item.file)), item.file).toContain(item.text);
    }
  });

  it('BAD: a case claiming verified behavior or lacking refuting evidence is rejected', () => {
    const [first] = parsed.cases;
    const withCases = (cases: unknown[]) => ({ ...parsed, cases });
    expect(
      CounterCaseFile.safeParse(withCases([{ ...first, behaviorStatus: 'VERIFIED' }])).success,
    ).toBe(false);
    expect(CounterCaseFile.safeParse(withCases([{ ...first, refutingEvidence: [] }])).success).toBe(
      false,
    );
    expect(
      CounterCaseFile.safeParse(
        withCases([{ ...first, source: { ...first!.source, unresolved: undefined } }]),
      ).success,
    ).toBe(false);
  });
});

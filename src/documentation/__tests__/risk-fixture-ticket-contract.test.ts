/**
 * @module documentation/risk-fixture-ticket-contract.test
 * @description The risk-trigger fixture ticket must state check authority at the
 * same layers the product uses, so the governed agent and the independent
 * reviewer are never told something the runtime contradicts:
 * - check selection: the planner's verification candidates (`build`, `test`);
 * - executed command: the candidate command the planner actually produces
 *   (`npm run <script> --`), derived here from the real planner, never pinned;
 * - script definition: the fixture `package.json` script bodies;
 * - evidence roles: the retained claim's positive and counterexample checks;
 * - observation scope: the revisions each review obligation can observe,
 *   derived here from the real revision authority, never pinned.
 *
 * @test-policy HAPPY, BAD
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { planVerificationCandidates } from '../../discovery/verification-planner.js';
import {
  resolveObservationRevisions,
  type FrozenRepositoryRevisionTargetValue,
} from '../../state/evidence-review-authority.js';
import { claimDeclaration } from '../../../demos/risk-trigger-fixture/run-live-risk-trigger-controls.mjs';

const FIXTURE = path.join(__dirname, '../../../demos/risk-trigger-fixture');
const TICKET = fs.readFileSync(path.join(FIXTURE, 'TICKET.md'), 'utf8');
const README = fs.readFileSync(path.join(FIXTURE, 'README.md'), 'utf8');
const SCRIPTS = (
  JSON.parse(fs.readFileSync(path.join(FIXTURE, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  }
).scripts;

/** Plan candidates exactly as hydrate does for the installed fixture workspace. */
async function fixtureCandidates() {
  const rootFiles = fs.readdirSync(FIXTURE).filter((entry) => !entry.startsWith('.'));
  const planned = await planVerificationCandidates({
    detectedStack: undefined,
    // The live workspace adds the Maven wrapper from the demo seed.
    allFiles: [...rootFiles, 'mvnw', 'mvnw.cmd'],
    readFile: async (relative: string) => {
      const file = path.join(FIXTURE, relative);
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
    },
  });
  return new Map(planned.map((entry) => [entry.candidate.kind, entry.candidate]));
}

/** Collapse markdown line wrapping so prose assertions are layout-independent. */
const ticketProse = TICKET.replace(/\s+/g, ' ');
const readmeProse = README.replace(/\s+/g, ' ');

const TARGET: FrozenRepositoryRevisionTargetValue = {
  kind: 'commit',
  repositoryIdentity: { kind: 'local', rootCommitDigest: `sha256:${'a'.repeat(64)}` },
  objectSha: 'b'.repeat(40),
};

/** Render revisions the way the fixture prose names them: `head` or `base`/`head`. */
function revisionProse(revisions: readonly string[]): string {
  return revisions.map((revision) => `\`${revision}\``).join('/');
}

describe('risk fixture ticket - check authority layers', () => {
  it('HAPPY: names exactly the executed commands the planner produces for build and test', async () => {
    const candidates = await fixtureCandidates();
    for (const kind of ['build', 'test'] as const) {
      const candidate = candidates.get(kind);
      expect(candidate, `planner candidate for ${kind}`).toBeDefined();
      expect(candidate?.source).toBe(`package.json:scripts.${kind}`);
      expect(ticketProse).toContain(`\`${candidate?.command}\``);
    }
  });

  it('HAPPY: names the package.json script bodies as implementation, not authority', () => {
    for (const [name, body] of Object.entries(SCRIPTS)) {
      expect(ticketProse).toContain(`\`${name}\` to \`${body}\``);
    }
    expect(ticketProse).toContain('they are not a separate check authority');
  });

  it('HAPPY: states the evidence roles of the retained claim', () => {
    const claim = claimDeclaration(true);
    expect(ticketProse).toContain(`positive evidence check is \`${claim.expectedCheckId}\``);
    expect(ticketProse).toContain(
      `counterexample (adversarial) check is \`${claim.counterexampleRequirement.checkId}\``,
    );
  });

  it('HAPPY: separates plan review from later validation', () => {
    expect(ticketProse).toContain('Plan review precedes baseline and implementation validation.');
  });

  it('BAD: never forbids the argument-forwarding separator of the executed command', () => {
    expect(ticketProse).not.toMatch(/append arguments such as `--`/);
    expect(ticketProse).not.toMatch(/`build` \(`\.\/mvnw verify`\)/);
  });
});

describe('risk fixture ticket - repository observation scope per obligation', () => {
  // plan/architecture obligations may only carry a context authority;
  // implement obligations only a candidate pair (evidence-review-refinements).
  const planRevisions = resolveObservationRevisions({
    repositoryAuthority: { kind: 'context', context: TARGET },
  });
  const implementationRevisions = resolveObservationRevisions({
    repositoryAuthority: { kind: 'candidate_pair', base: TARGET, head: TARGET },
  });

  it('HAPPY: the authority offers head to plan review and base/head to implementation review', () => {
    expect(planRevisions).toEqual(['head']);
    expect(implementationRevisions).toEqual(['base', 'head']);
  });

  it('HAPPY: ticket and README scope the head-only offer to the plan review obligation', () => {
    for (const prose of [ticketProse, readmeProse]) {
      expect(prose).toContain('Repository observation is scoped to each review obligation.');
      expect(prose).toContain(
        `The plan review obligation offers only the ${revisionProse(planRevisions)} revision`,
      );
      expect(prose).toContain(
        `implementation review carries its own frozen ${revisionProse(implementationRevisions)} candidate pair`,
      );
    }
  });

  it('HAPPY: the plan may name the later implementation diff without presenting it as observed', () => {
    expect(ticketProse).toContain('the plan may name the implementation diff as later evidence');
    expect(ticketProse).toContain('without presenting it as already observed');
  });

  it('BAD: no unscoped statement that base observation is unavailable to the run', () => {
    for (const prose of [ticketProse, readmeProse]) {
      expect(prose).not.toMatch(/base-revision observation is not available/i);
      expect(prose).not.toContain('not available to these obligations');
      expect(prose).not.toContain('not available to this obligation');
    }
  });
});

/**
 * @module documentation/risk-fixture-ticket-contract.test
 * @description The risk-trigger fixture ticket must state check authority at the
 * same layers the product uses, so the governed agent and the independent
 * reviewer are never told something the runtime contradicts:
 * - check selection: the planner's verification candidates (`build`, `test`);
 * - executed command: the candidate command the planner actually produces
 *   (`npm run <script> --`), derived here from the real planner, never pinned;
 * - script definition: the fixture `package.json` script bodies;
 * - evidence roles: the retained claim's positive and counterexample checks.
 *
 * @test-policy HAPPY, BAD
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { planVerificationCandidates } from '../../discovery/verification-planner.js';
import { claimDeclaration } from '../../../demos/risk-trigger-fixture/run-live-risk-trigger-controls.mjs';

const FIXTURE = path.join(__dirname, '../../../demos/risk-trigger-fixture');
const TICKET = fs.readFileSync(path.join(FIXTURE, 'TICKET.md'), 'utf8');
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

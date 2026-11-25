/**
 * A fixed, repository-grounded plan candidate for the Java reference controls.
 * The product still submits it through `/plan`, runs the independent review and
 * owns every acceptance decision; this module only removes free-form plan drift.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Git-ignored harness inputs; never part of the delivered repository change. */
export const PLAN_CANDIDATE_FILE = '.flowguard/plan-candidate.md';
export const PLAN_CLAIMS_FILE = '.flowguard/plan-candidate-claims.json';

export function buildPlanCandidate({
  ticketFile,
  claim,
  positiveAssertion,
  buildCandidateId,
  testCandidateId,
}) {
  const assertion = claim.counterexampleRequirement?.assertion?.localId;
  if (
    typeof ticketFile !== 'string' ||
    !ticketFile ||
    typeof claim?.statement !== 'string' ||
    !claim.statement ||
    typeof positiveAssertion !== 'string' ||
    !positiveAssertion ||
    typeof assertion !== 'string' ||
    !assertion ||
    typeof buildCandidateId !== 'string' ||
    !buildCandidateId ||
    typeof testCandidateId !== 'string' ||
    !testCandidateId
  ) {
    throw new Error(
      'plan candidate requires the exact claim and verification-candidate identities',
    );
  }
  return `# Implementation Plan

> **Objective:** Extend \`docs/usage-notes.md\` with a short \`## Getting started\` section that describes how to start the task-manager application. | **Scope:** Documentation only; \`docs/usage-notes.md\` is the sole permitted file. | **Risk:** Low | **Version:** 1

## Approach

- Keep the existing \`## Running the tests\` section and its command line byte-identical.
- Add only a short, factual start instruction grounded in the repository's Spring Boot Maven plugin.
- Do not add API-path or port claims that are not needed by the ticket.
- Use the existing active checks and assertion fixtures unchanged; the new section is checked by a read-only harness inspection, not as a new FlowGuard check or claim.
- Treat the \`-DskipTests\` counterexample as design reasoning only; never add it to the delivered file.
- Judge each declared evidence role by its own assertion, not by the exit status of the shared lifecycle: both candidates execute the same Surefire fixture set, so role separation is described per assertion below.

## Implementation

### 1. Extend the usage notes

**Files:** \`docs/usage-notes.md\`

**Changes:** Insert a \`## Getting started\` section after \`# Usage Notes\` and before \`## Running the tests\`. It states that the application is started from the project root with \`./mvnw spring-boot:run\`, which is backed by the \`spring-boot-maven-plugin\` in \`pom.xml\`. Do not change the existing \`## Running the tests\` section. Do not add any unrequested API-path or port claim.

**Edge cases:** Keep exactly one \`## Getting started\` heading; keep the required command line present and unchanged; do not introduce \`-DskipTests\` or a second test command.

**Validation:** The delivered file contains the heading above \`## Running the tests\`, retains the exact required line, and contains no \`-DskipTests\`. The heading-count/order and start-command-in-section checks are manual inspections of the frozen file bytes with no candidate assertion backing them; only the presence-of-required-line and no-\`-DskipTests\` substrings are covered by executable assertions.

## Change Inventory

| Area | Files | Change |
|---|---|---|
| Documentation | \`docs/usage-notes.md\` | MODIFY: add the \`## Getting started\` section and retain the test command |

## Contracts

- Only \`docs/usage-notes.md\` may change during implementation.
- The documented test command and the existing JUnit fixtures remain unchanged.
- The active checks are \`build\` and \`test\`; they are not substituted, re-bound, added, or omitted.
- The retained critical claim is exactly one \`specific_behavior\` fact at \`Verification\`, with \`test\` as its positive check and the existing \`build\` assertion as its counterexample requirement.

## Authority Decisions

- The repository's \`pom.xml\`, \`package.json\`, documentation, and existing JUnit fixtures are the factual authority.
- No new FlowGuard check, claim, policy, or reviewer authority is introduced.
- The \`## Getting started\` presence/order check is a read-only harness inspection; it is not claim evidence and does not create a new active check.

## Acceptance Criteria

- [ ] \`docs/usage-notes.md\` contains exactly one \`## Getting started\` section above \`## Running the tests\`.
- [ ] The exact line \`Run ./mvnw test to run the task-manager tests.\` is present and unchanged.
- [ ] The delivered file contains no \`-DskipTests\`.
- [ ] No file other than \`docs/usage-notes.md\` changes.
- [ ] The heading-count/order and \`spring-boot:run\`-in-section criteria are verified against the frozen file bytes (manual inspection), not by an executable check; the presence and no-\`-DskipTests\` criteria are also covered by the fixture assertions.

## Verification

1. Baseline and post-implementation validation execute every active check in full: \`build\` (Source: \`package.json#scripts.build\`, command \`./mvnw verify\`, candidate \`${buildCandidateId}\`) and \`test\` (Source: \`package.json#scripts.test\`, command \`./mvnw test\`, candidate \`${testCandidateId}\`). No check is substituted, re-bound, added, or omitted.
2. Positive evidence: the retained claim is judged on the \`test\` candidate's captured \`${positiveAssertion}\` assertion result (presence of the exact required line). That assertion is the observable for the claim. The \`./mvnw test\` lifecycle also runs \`UsageNotesFalsificationProbeTest\`; the probe is not part of the positive observable and is not counted as positive evidence.
3. Counterexample (negative case): the \`build\` candidate (\`./mvnw verify\`) carries the adversarial probe assertion \`${assertion}\`. That probe keeps the complete required line intact and additionally asserts the absence of \`-DskipTests\`. Its concrete faulty variant is a delivered \`docs/usage-notes.md\` that retains \`Run ./mvnw test to run the task-manager tests.\` and adds a separate conflicting command line containing \`-DskipTests\`; in that variant \`${positiveAssertion}\` and the probe's own required-line check still pass, while the probe's \`assertFalse(text.contains("-DskipTests"))\` fails. The counterexample is therefore carried by a distinct assertion with a distinct detection mechanism (absence-of-skip detection) from the presence detection used as positive evidence, even though both candidates execute the same fixture set.
4. The counterexample faulty variant is design reasoning only. It is not added to the delivered \`docs/usage-notes.md\`; no environment variable is used to simulate the counterexample failure, no assertion is disabled or skipped in the counterexample execution, and no failure is simulated. The counterexample is the genuine probe assertion evaluating a content variant containing \`-DskipTests\`.
5. Read-only ticket-deliverable inspection (not a FlowGuard active check or claim, and with no candidate assertion): after implementation the harness verifies against the frozen file bytes exactly one \`## Getting started\` heading above \`## Running the tests\`; the \`./mvnw spring-boot:run\` command inside that actual section (before any next \`##\` heading); the required test line as a complete line; and no \`-DskipTests\` in \`docs/usage-notes.md\`.

### Claim declaration

The plan uses exactly one retained critical claim:

- statement: \`${claim.statement}\`
- critical: \`true\`; authority section: \`Verification\`; scope: \`specific_behavior\`; expected check: \`${claim.expectedCheckId}\`
- counterexample: \`${claim.counterexampleRequirement.checkId}\` / \`${assertion}\`

\`\`\`flowguard-evidence-design
{
  "version": 1,
  "claims": [
    {
      "authoritySectionId": "Verification",
      "statement": ${JSON.stringify(claim.statement)},
      "positiveObservable": "the ${testCandidateId} test attempt captures ${positiveAssertion} as passing for the delivered docs/usage-notes.md",
      "faultyVariant": "keep the complete required line and add a separate conflicting command containing -DskipTests",
      "expectedFailure": "the ${assertion} assertion fails on the separate -DskipTests command",
      "executionRoute": "${buildCandidateId}"
    }
  ]
}
\`\`\`
`;
}

/**
 * Write the exact plan and claims to git-ignored files. The prompt must not
 * embed them: the headless host transport JSON-encodes the prompt, and literal
 * backslashes in the fenced evidence-design JSON then reach the model as part
 * of the plan text. Files are read back as raw bytes instead.
 */
export function writePlanCandidateFiles(workspace, planText, claims) {
  if (
    typeof workspace !== 'string' ||
    !workspace ||
    typeof planText !== 'string' ||
    !planText ||
    !Array.isArray(claims) ||
    claims.length === 0
  ) {
    throw new Error('plan candidate files require a workspace, plan text and claims');
  }
  const directory = path.join(workspace, path.dirname(PLAN_CANDIDATE_FILE));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(workspace, PLAN_CANDIDATE_FILE), planText, {
    flag: 'wx',
    mode: 0o600,
  });
  fs.writeFileSync(path.join(workspace, PLAN_CLAIMS_FILE), `${JSON.stringify(claims, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  return { planFile: PLAN_CANDIDATE_FILE, claimsFile: PLAN_CLAIMS_FILE };
}

export function removePlanCandidateFiles(workspace) {
  for (const file of [PLAN_CANDIDATE_FILE, PLAN_CLAIMS_FILE]) {
    fs.rmSync(path.join(workspace, file), { force: true });
  }
}

/**
 * The prompt intentionally contains neither the plan nor the claims. It points
 * at the raw files so the host's JSON encoding cannot corrupt the fenced
 * evidence-design JSON. Revisions must resolve only the bound blocking set.
 */
export function planCandidatePrompt() {
  return (
    'Submit the controlled initial plan candidate through flowguard_plan({ planText, claims }). ' +
    `Read \`${PLAN_CANDIDATE_FILE}\` and \`${PLAN_CLAIMS_FILE}\` with the read tool. ` +
    'The plan file contains the exact authoritative Markdown bytes; the claims file contains the ' +
    'exact authoritative JSON array. If the read tool displays line-number prefixes, strip them: ' +
    'planText must contain the raw Markdown only and claims must contain the parsed JSON array. ' +
    'The plan contains a fenced flowguard-evidence-design JSON block: preserve its literal double ' +
    'quotes exactly; do not backslash-escape them. Do not call flowguard_plan before reading both ' +
    'files. Do not reconstruct, rewrite, shorten, add to, or replace either from this prompt, ' +
    'which deliberately omits both. Submit both in one flowguard_plan call in this turn. Complete ' +
    'the normal independent review. If the reviewer ' +
    'returns ' +
    'changes_requested, address every bound finding in `blockingIssues` only; include a ' +
    'flowguard-finding-resolutions block bound only to the current review obligation, iteration, ' +
    'plan version and those blocking finding IDs. Each resolutions entry must contain exactly ' +
    '`findingId`, `planSection` and `response`; `planSection` must be an exact existing heading ' +
    'in the revised plan, such as `Verification`, not a prose location. Never include `majorRisks`, ' +
    'minor findings, `missingVerification` or any finding outside `blockingIssues` in that block. ' +
    'Preserve all ' +
    'fixed constraints, the exact claim, the evidence design and the Getting started verification. ' +
    'Never use FLOWGUARD_LIVE_SKIP_ASSERTION to simulate a failing assertion. Do not modify the ' +
    'candidate files.'
  );
}

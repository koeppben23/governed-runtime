/**
 * A fixed, repository-grounded plan candidate for the Java reference controls.
 * The product still submits it through `/plan`, runs the independent review and
 * owns every acceptance decision; this module only removes free-form plan drift.
 */

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

## Implementation

### 1. Extend the usage notes

**Files:** \`docs/usage-notes.md\`

**Changes:** Insert a \`## Getting started\` section after \`# Usage Notes\` and before \`## Running the tests\`. It states that the application is started from the project root with \`./mvnw spring-boot:run\`, which is backed by the \`spring-boot-maven-plugin\` in \`pom.xml\`. Do not change the existing \`## Running the tests\` section. Do not add any unrequested API-path or port claim.

**Edge cases:** Keep exactly one \`## Getting started\` heading; keep the required command line present and unchanged; do not introduce \`-DskipTests\` or a second test command.

**Validation:** The delivered file contains the heading above \`## Running the tests\`, retains the exact required line, and contains no \`-DskipTests\`.

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

## Verification

1. Baseline and post-implementation validation execute every active check in full: \`build\` (Source: \`package.json#scripts.build\`) and \`test\` (Source: \`package.json#scripts.test\`). No check is substituted, re-bound, added, or omitted.
2. Read-only ticket-deliverable inspection (not a FlowGuard active check or claim): after implementation the harness must verify exactly one \`## Getting started\` heading above \`## Running the tests\`, the unchanged required line, and no \`-DskipTests\` in \`docs/usage-notes.md\`. The equivalent review command is \`awk 'BEGIN{g=0;r=0} /^## Getting started$/{g=NR} /^## Running the tests$/{r=NR} END{exit !(g>0 && r>0 && g<r)}' docs/usage-notes.md\`.
3. Confirm the exact required line is present and that no \`-DskipTests\` appears in the delivered documentation.
4. The hypothetical counterexample keeps the complete required line intact and adds a separate conflicting command containing \`-DskipTests\`: the presence assertion passes and the conflicting-command assertion fails. This is plan reasoning only; it is not executed or added to the delivered file. The assertion-skip environment variable is not used to simulate a failing assertion.
5. The assertion-skip environment variable is only an execution control for the negative case; it is not used to simulate a failing assertion or to replace the hypothetical counterexample. The negative case obtains its denial from the genuine skipped adversarial assertion at the evidence gate.

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

export function planCandidatePrompt(planText, claims) {
  return (
    'Submit this exact initial plan candidate through flowguard_plan({ planText, claims }). ' +
    'Do not rewrite, shorten, add to, or replace the plan text on the initial submission. ' +
    'Use EXACTLY the claims JSON below. Complete the normal independent review. ' +
    'If the reviewer returns changes_requested, address every bound blocking finding, preserve ' +
    'all fixed constraints, the exact claim, the evidence design and the Getting started ' +
    'verification, and include a flowguard-finding-resolutions block bound only to the current ' +
    'review obligation, iteration, plan version and finding IDs. Never use ' +
    'FLOWGUARD_LIVE_SKIP_ASSERTION to simulate a failing assertion.\n\n' +
    '--- PLAN TEXT START ---\n' +
    `${planText}\n` +
    '--- PLAN TEXT END ---\n' +
    '--- CLAIMS JSON START ---\n' +
    `${JSON.stringify(claims, null, 2)}\n` +
    '--- CLAIMS JSON END ---'
  );
}

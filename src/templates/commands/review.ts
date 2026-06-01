import { GOVERNANCE_RULES } from './shared-rules.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../shared/flowguard-identifiers.js';

export const REVIEW_COMMAND = `
---
description: Start the standalone compliance review flow (READY -> REVIEW -> REVIEW_COMPLETE).
agent: build
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Start the compliance review flow for the current FlowGuard session.

## Steps

1. Call \`flowguard_status\` to verify a session exists in READY phase.
    - If not in READY: report the current phase and stop.
    - Capture the compact Discovery context from the status response: Discovery
      \`health\`, \`drift\`, \`detectedStack\`, repo-native \`verificationCandidates\`,
      and risk surfaces. This is REQUIRED review evidence for repo-dependent claims.
    - Discovery context is advisory falsification evidence, NOT review verdict
      authority: ReviewFindings, obligation binding, mandate digest, and attestation
      remain the review authority.
    - If Discovery is unavailable, degraded, drifted, timed out, or not checked, mark
      every Discovery-dependent claim \`NOT_VERIFIED\`; do not invent repository truth.

2. **External Reference Resolution** (PR URLs, branches, commits, URLs, manual text):
    If the user provides a reference:
    - **PR number**: Load PR diff via \`webfetch\` or \`gh pr view <number> --json diff\`. Add ExternalReference with type \`"pr"\`, set \`inputOrigin: "pr"\`.
    - **Branch name**: Load branch diff via \`gh pr diff <branch>\`. Add ExternalReference with type \`"branch"\`, source \`"local"\`, set \`inputOrigin: "branch"\`.
    - **URL**: Fetch content via \`webfetch\`. Set \`inputOrigin: "external_reference"\`.
    - **Manual text**: Use the supplied text directly. Set \`inputOrigin: "manual_text"\`.
    - **Commit SHA**: Add ExternalReference with type \`"commit"\`, source \`"local"\`, set \`inputOrigin: "external_reference"\`.
    - **Both text AND reference**: Set \`inputOrigin: "mixed"\`.
    - **No reference**: Proceed without \`references\` or \`inputOrigin\`.
    Always preserve the original URL/reference.

3. **Subagent Review** (content-aware only):
    If the blocked response contains \`pluginReviewFindings\`, use those findings
    directly — the FlowGuard orchestration plugin has already invoked the
    \`${REVIEWER_SUBAGENT_TYPE}\` subagent for you and injected the results.
    If the response contains \`CONTENT_ANALYSIS_REQUIRED\` with \`requiredReviewAttestation\`
    and NO \`pluginReviewFindings\`, manually call the \`${REVIEWER_SUBAGENT_TYPE}\` subagent
    via Task tool:
    - Use \`subagent_type: "${REVIEWER_SUBAGENT_TYPE}"\`
    - Pass the loaded content and \`requiredReviewAttestation\` values in the prompt
    - Pass the compact Discovery context captured in step 1 (health, drift,
      detectedStack, verificationCandidates, risk surfaces). This is REQUIRED so the
      external diff is reviewed against repo-native stack/verification/health/drift.
    - Instruct the subagent to: check Discovery health and drift BEFORE making any
      repo-dependent quality claim; correlate the reviewed PR/diff files against the
      local Discovery snapshot; mark any claim \`NOT_VERIFIED\` when the content
      cannot be correlated to local repository Discovery (e.g. the diff references
      files absent from the Discovery snapshot, or local Discovery is drifted relative
      to the reviewed branch).
    - Instruct the subagent to return a complete \`ReviewFindings\` JSON object
    - Parse the response as \`ReviewFindings\` object — preserve all fields
    - Set \`attestation.toolObligationId\` to the value from \`requiredReviewAttestation\`
      (FlowGuard provides this UUID for every content-aware /review)
    Strict governance is not satisfied by copied JSON or attestation fields alone.
    Those fields are diagnostic/context only until FlowGuard persists matching
    \`ReviewInvocationEvidence\` for the obligation.
    Both paths converge at step 4.

    - If the subagent returns \`overallVerdict: "unable_to_review"\` (for example because the
      content was unparseable), do NOT submit \`reviewFindings\`. Report the reason to the user.
      The tool will handle this as \`SUBAGENT_UNABLE_TO_REVIEW\` and exit the flow.
      Only submit \`reviewFindings\` when the subagent returns \`approve\` or \`changes_requested\`.

4. Call \`flowguard_review\` with:
    - The matching content field (\`text\`, \`prNumber\`, \`branch\`, or \`url\`)
    - Optional \`inputOrigin\` and \`references\`
    - \`reviewFindings\`: the complete \`ReviewFindings\` object returned by the subagent
      (REQUIRED when content was provided). Pass the object as-is — no mapping, no array.
    Do not call content-aware \`flowguard_review\` without \`reviewFindings\`; the tool blocks fail-closed.

5. If no external content is supplied, call \`flowguard_review\` with optional \`inputOrigin\` and \`references\` only.

6. The tool transitions READY -> REVIEW -> REVIEW_COMPLETE and generates a compliance report.

7. Present the report per the Presentation section below.

## Presentation

- If the response contains a \`reviewCard\` field, display its markdown verbatim — never summarize, truncate, or omit it.
- The reviewCard contains the formatted review report with findings, completeness, and evidence.
- This is mandatory output: the user relies on it for compliance assessment.

## Verification Review Check

When reviewing evidence, verify:
- Was Discovery health checked, and was drift checked, before repo-dependent quality claims?
- Were verificationCandidates from flowguard_status used when available?
- Were generic commands suggested despite specific repo-native candidates existing?
- Are executed checks distinguished from planned checks?
- Are unexecuted checks marked NOT_VERIFIED?
- Are Discovery-dependent claims marked NOT_VERIFIED when the content could not be
  correlated to local repository Discovery (missing files, drift, unavailable Discovery)?
If generic commands are suggested despite specific candidates existing, flag this as a defect.
If repo-dependent claims are made without checking Discovery health/drift, flag this as a defect.

## ExternalReference Format

- \`ref\` (required): URL, branch name, commit SHA
- \`type\` (optional): ticket | issue | pr | branch | commit | url | doc | other
- \`title\` (optional): Human-readable title
- \`source\` (optional): Platform identifier
- \`extractedAt\` (optional): ISO timestamp — only when content was actually extracted

## Rules

- This command is only available in READY phase (it starts a standalone flow).
- Present the report clearly and concisely.
- If \`flowguard_review\` returns BLOCKED with code \`STRICT_REVIEW_ORCHESTRATION_FAILED\`: The plugin review pipeline encountered a transient failure. Re-run the /review command to retry. This is NOT a permanent failure — the orchestration retries automatically on each fresh invocation.
- If \`flowguard_review\` returns BLOCKED with code \`ORCHESTRATION_PERMANENTLY_FAILED\`: Report this to the user with the recovery steps and stop.
${GOVERNANCE_RULES}
## Done-when

- Compliance report generated and presented.
- If \`reviewCard\` is present in the tool response, it is displayed verbatim in the output.
- External references captured with audit provenance.
- Discovery health and drift checked before repo-dependent quality claims.
- Discovery-dependent claims marked NOT_VERIFIED when content could not be correlated to local Discovery.
- Verification review checked for repo-native candidates vs generic mismatches.
- Phase has reached REVIEW_COMPLETE.
- Response ends with a \`Next action:\` line.
`;

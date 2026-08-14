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
    - Call \`flowguard_status\` with NO focused flags (no whyBlocked/evidence/context/readiness)
      so the FULL projection is returned. Focused projections omit \`discoveryHealth\`,
      \`discoveryDrift\`, and \`detectedStack\`; never conclude Discovery is unavailable from a
      focused call — re-read status WITHOUT focused flags first.
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
    - **PR number**: Pass \`prNumber\` to \`flowguard_review\`. FlowGuard resolves the exact commits and materializes the canonical diff. Add ExternalReference with type \`"pr"\`, set \`inputOrigin: "pr"\`.
    - **Branch name**: Pass \`branch\` (and \`base\` when needed) to \`flowguard_review\`. FlowGuard resolves and freezes the local or remote branch at exact commits; never run \`git diff\` or convert a branch failure into a \`text\` review. Add ExternalReference with type \`"branch"\`, source \`"local"\` when applicable, set \`inputOrigin: "branch"\`.
    - **URL**: Pass \`url\` to \`flowguard_review\`; FlowGuard fetches and freezes the review content. Set \`inputOrigin: "external_reference"\`.
    - **Manual text**: Use the supplied text directly. Set \`inputOrigin: "manual_text"\`.
    - **Commit SHA**: Add ExternalReference with type \`"commit"\`, source \`"local"\`, set \`inputOrigin: "external_reference"\`.
    - **Both text AND reference**: Set \`inputOrigin: "mixed"\`.
    - **No reference**: Proceed without \`references\` or \`inputOrigin\`.
    Always preserve the original URL/reference. If FlowGuard blocks source resolution, report its recovery and stop; do not pre-load or reinterpret the source.

3. **Create the review obligation** (content-aware only):
    If content was provided, the FIRST \`flowguard_review\` call MUST carry ONLY the matching
    content field (\`text\`, \`prNumber\`, \`branch\`, or \`url\`), optional \`inputOrigin\`,
    and optional \`references\`. NEVER include \`reviewVerdict\` or \`reviewFindings\` in this
    first call — a prefilled verdict is a fabrication-of-convergence attempt and is rejected
    (\`CONTENT_ANALYSIS_REQUIRED\`). The verdict is submitted only AFTER the reviewer runs (step 5).
    This call creates the ReviewObligation and returns either plugin-provided findings or
    host-task instructions.

4. **Subagent Review** (content-aware only):
    If the blocked response contains \`pluginReviewFindings\`, use those findings
    directly — the FlowGuard orchestration plugin has already invoked the
    \`${REVIEWER_SUBAGENT_TYPE}\` subagent for you and injected the results.
    If the response contains \`HOST_SUBAGENT_TASK_REQUIRED\`, \`CONTENT_ANALYSIS_REQUIRED\`, or host-task instructions with \`requiredReviewAttestation\`
    and NO \`pluginReviewFindings\`, manually call the \`${REVIEWER_SUBAGENT_TYPE}\` subagent
    via Task tool:
    - Use \`subagent_type: "${REVIEWER_SUBAGENT_TYPE}"\`
    - The response MUST include a \`reviewerTaskPrompt\` field: pass it VERBATIM as the Task
      tool "prompt" argument without appending content, Discovery context, or instructions.
      This canonical prompt already carries the frozen material, the attempt-bound Discovery
      snapshot, the required review context (iteration/planVersion), and the attestation.
      Do NOT free-compose a prompt: a repository review without a canonical
      \`reviewerTaskPrompt\` is blocked with \`REVIEWER_CONTEXT_UNAVAILABLE\` — report that
      code with its recovery steps and stop instead of assembling a substitute prompt.
    - Instruct the subagent to: check the supplied Discovery health and drift status BEFORE
      making any repo-dependent quality claim; correlate the reviewed PR/diff files against
      the supplied Discovery snapshot; mark any claim \`NOT_VERIFIED\` when the content
      cannot be correlated to that snapshot (e.g. the diff references files absent from the
      snapshot, or Discovery is drifted relative to the reviewed branch).
    - The canonical prompt already requires a complete \`ReviewerFindingsInput\` object. Do not
      restate output instructions or construct attestation fields outside that prompt.
    - In host-task mode, FlowGuard captures Task evidence; do not parse or resubmit it.
    Strict governance is not satisfied by copied JSON or attestation fields alone.
    Those fields are diagnostic/context only until FlowGuard persists matching
    \`ReviewInvocationEvidence\` for the obligation.
    Both paths converge at step 5.

    - If the subagent returns \`overallVerdict: "unable_to_review"\` (for example because the
      content was unparseable), do NOT submit \`reviewFindings\`. Report the reason to the user.
      The tool will handle this as \`SUBAGENT_UNABLE_TO_REVIEW\` and exit the flow.
      Only submit \`reviewFindings\` when the subagent returns \`accept\` or \`changes_requested\`.

    - **Retry after schema_invalid**: If the Task call returns \`bindOutcome: "schema_invalid"\` (the reviewer's output failed validation), do NOT re-run the Task with the same prompt. Instead:
      1. Look at the \`schemaErrors\` field (if present) to understand which fields failed.
      2. Call \`flowguard_review\` again with the original content fields and \`reviewObligationId\` from \`requiredReviewAttestation.toolObligationId\`. This produces a fresh \`reviewerTaskPrompt\` with the validation errors embedded.
      3. Pass the NEW \`reviewerTaskPrompt\` to the Task tool — never reuse the old one.
      4. If the Task is blocked with \`REVIEWER_OUTPUT_RETRY_EXHAUSTED\`, the retry budget is exhausted — report to the operator and stop; do NOT fabricate findings, guess a verdict, or call any other authority path.

5. Complete content-aware \`flowguard_review\` according to the review invocation mode:
    - If the response says host-task evidence was verified or policy requires host-visible
      Task evidence: after the \`${REVIEWER_SUBAGENT_TYPE}\` Task returns, call
       \`flowguard_review\` with the same content fields plus \`reviewObligationId\` from
       \`requiredReviewAttestation.toolObligationId\` and \`reviewVerdict\`
      (\`"accept"\` or \`"changes_requested"\`) matching the reviewer's \`overallVerdict\`.
      Do NOT submit, copy, or alter \`reviewFindings\` (not even an empty placeholder object); FlowGuard resolves the captured
      ReviewInvocationEvidence automatically.
      \`HOST_SUBAGENT_TASK_REQUIRED\` is an expected intermediate state in this mode, not
      a terminal failure and not a reason to tell the user to restart the flow.
    - If the response contains \`pluginReviewFindings\` or the active mode accepts SDK/manual
      findings, call \`flowguard_review\` with the same content fields plus
      \`reviewFindings\` set to the complete ReviewFindings object as-is — no mapping, no array.
     - If host-task mode reports \`duplicate_evidence\`, do not rerun the reviewer. Use the
        already-bound reviewer verdict and call \`flowguard_review\` with \`reviewObligationId\`
        from \`requiredReviewAttestation.toolObligationId\` plus \`reviewVerdict\`.
     - If the Task cannot spawn the reviewer, follow the policy-specific recovery in the FlowGuard
       response: required stops blocked; preferred retries the originating \`flowguard_review\`
       invocation with unchanged content input. Never submit copied or fabricated findings.

6. If no external content is supplied, call \`flowguard_review\` with optional \`inputOrigin\` and \`references\` only.

7. The tool transitions READY -> REVIEW -> REVIEW_COMPLETE and generates a compliance report.

8. Present the report per the Presentation section below.

## Presentation

- If \`presentation.markdown\` is present, display its markdown verbatim — never summarize, truncate, or omit it; do not append a second conclusion.
- Only when \`presentation.markdown\` is absent, display the legacy \`reviewCard\` field verbatim.
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
- If \`presentation.markdown\` is present, it is displayed verbatim; otherwise the legacy \`reviewCard\` is displayed verbatim.
- External references captured with audit provenance.
- Discovery health and drift checked before repo-dependent quality claims.
- Discovery-dependent claims marked NOT_VERIFIED when content could not be correlated to local Discovery.
- Verification review checked for repo-native candidates vs generic mismatches.
- Phase has reached REVIEW_COMPLETE.
- The canonical presentation conclusion is the only visible closure.
`;

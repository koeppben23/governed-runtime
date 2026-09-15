import { renderCommandGovernanceRules } from '../../rendering/mandates-renderer.js';

export const REVIEW_COMMAND = `---
description: FlowGuard — Start the standalone compliance review flow (READY -> REVIEW -> REVIEW_COMPLETE).
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
      authority: the host-observed structured reviewer invocation evidence,
      obligation binding, and mandate digest remain the review authority.
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
     (\`CONTENT_ANALYSIS_REQUIRED\`). The verdict is submitted only AFTER FlowGuard completes
     independent review.

4. **Independent Review** (content-aware only): FlowGuard performs and binds the
   independent review. Never invoke a reviewer yourself, construct reviewer context, or submit
   \`reviewFindings\`.

5. Complete content-aware \`flowguard_review\`: when \`next\` reports the bound reviewer verdict,
   call \`flowguard_review\` with the same content fields and matching \`reviewVerdict\`
   (\`"accept"\` or \`"changes_requested"\`). Do not submit, copy, or alter \`reviewFindings\`.
   If FlowGuard reports a capture or orchestration failure, report its recovery and stop; do not
   fabricate findings or guess a verdict.

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
${renderCommandGovernanceRules()}
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

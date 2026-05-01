import { GOVERNANCE_RULES } from './shared-rules.js';

export const REVIEW_COMMAND = `
---
description: Start the standalone compliance review flow (READY -> REVIEW -> REVIEW_COMPLETE).
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Start the compliance review flow for the current FlowGuard session.

## Steps

1. Call \`flowguard_status\` to verify a session exists in READY phase.
   - If not in READY: report the current phase and stop.

2. **External Reference Resolution and Content Review** (PR URLs, branches, commits):
   If the user provides a reference:
   - **PR URL**: Inspect the PR content/diff before calling \`flowguard_review\`. Add ExternalReference with type \`"pr"\`, set \`inputOrigin: "pr"\`.
   - **Branch name**: Inspect the branch diff before calling \`flowguard_review\`. Add ExternalReference with type \`"branch"\`, source \`"local"\`, set \`inputOrigin: "branch"\`.
   - **URL**: Fetch and inspect the URL content before calling \`flowguard_review\`. Set \`inputOrigin: "url"\` or \`"external_reference"\` as appropriate.
   - **Manual text**: Analyze the supplied text before calling \`flowguard_review\`. Set \`inputOrigin: "manual_text"\`.
   - **Commit SHA**: Add ExternalReference with type \`"commit"\`, source \`"local"\`, set \`inputOrigin: "external_reference"\`.
   - **Both text AND reference**: Set \`inputOrigin: "mixed"\`.
   - **No reference**: Proceed without \`references\` or \`inputOrigin\`.
   Always preserve the original URL/reference.

3. If external content or manual text is reviewed, call \`flowguard_review\` with:
   - the matching content field (\`text\`, \`prNumber\`, \`branch\`, or \`url\`),
   - optional \`inputOrigin\` and \`references\`,
   - \`analysisFindings\`: concrete findings from your review of that content.
   Do not call content-aware \`flowguard_review\` without \`analysisFindings\`; the tool blocks fail-closed.

4. If no external content is supplied, call \`flowguard_review\` with optional \`inputOrigin\` and \`references\` only.

5. The tool transitions READY -> REVIEW -> REVIEW_COMPLETE and generates a compliance report.

6. Present the report:
   - Overall status (clean, warnings, issues).
   - Findings with severity, category, message.
   - Validation summary.
   - External references used.
   - Actionable recommendations for warnings/issues.

## Verification Review Check

When reviewing evidence, verify:
- Were verificationCandidates from flowguard_status used when available?
- Were generic commands suggested despite specific repo-native candidates existing?
- Are executed checks distinguished from planned checks?
- Are unexecuted checks marked NOT_VERIFIED?
If generic commands are suggested despite specific candidates existing, flag this as a defect.

## ExternalReference Format

- \`ref\` (required): URL, branch name, commit SHA
- \`type\` (optional): ticket | issue | pr | branch | commit | url | doc | other
- \`title\` (optional): Human-readable title
- \`source\` (optional): Platform identifier
- \`extractedAt\` (optional): ISO timestamp — only when content was actually extracted

## Rules

- This command is only available in READY phase (it starts a standalone flow).
- Present the report clearly and concisely.
${GOVERNANCE_RULES}
## Done-when

- Compliance report generated and presented.
- External references captured with audit provenance.
- Verification review checked for repo-native candidates vs generic mismatches.
- Phase has reached REVIEW_COMPLETE.
- Response ends with a \`Next action:\` line.
`;

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

2. **External Reference Resolution** (PR URLs, branches, commits, URLs, manual text):
    If the user provides a reference:
    - **PR number**: Load PR diff via \`webfetch\` or \`gh pr view <number> --json diff\`. Add ExternalReference with type \`"pr"\`, set \`inputOrigin: "pr"\`.
    - **Branch name**: Load branch diff via \`gh pr diff <branch>\`. Add ExternalReference with type \`"branch"\`, source \`"local"\`, set \`inputOrigin: "branch"\`.
    - **URL**: Fetch content via \`webfetch\`. Set \`inputOrigin: "url"\` or \`"external_reference"\` as appropriate.
    - **Manual text**: Use the supplied text directly. Set \`inputOrigin: "manual_text"\`.
    - **Commit SHA**: Add ExternalReference with type \`"commit"\`, source \`"local"\`, set \`inputOrigin: "external_reference"\`.
    - **Both text AND reference**: Set \`inputOrigin: "mixed"\`.
    - **No reference**: Proceed without \`references\` or \`inputOrigin\`.
    Always preserve the original URL/reference.

3. **Independent Content Review via flowguard-reviewer Subagent** (MANDATORY for content-aware reviews):
    If content was loaded (step 2), you MUST call the \`flowguard-reviewer\` subagent:
    - Use the Task tool with \`subagent_type: "flowguard-reviewer"\`
    - Provide the loaded content (PR diff, branch diff, URL content, or manual text) in the prompt
    - Instruct: "Analyze this content for issues, warnings, and errors. Return findings as JSON with blockingIssues and majorRisks arrays."
    - Parse the subagent's JSON response
    - Map findings to \`analysisFindings\` array:
      * Each \`blockingIssues\` → \`{ severity, category: "blocking-issue", message, location }\`
      * Each \`majorRisks\` → \`{ severity, category: "major-risk", message, location }\`
    - Set \`overallVerdict\` based on findings severity (critical/major → "changes_requested", only minor → "approve")

4. Call \`flowguard_review\` with:
    - The matching content field (\`text\`, \`prNumber\`, \`branch\`, or \`url\`)
    - Optional \`inputOrigin\` and \`references\`
    - \`analysisFindings\`: The mapped findings from step 3 (REQUIRED when content was provided)
    Do not call content-aware \`flowguard_review\` without \`analysisFindings\`; the tool blocks fail-closed.

5. If no external content is supplied, call \`flowguard_review\` with optional \`inputOrigin\` and \`references\` only.

6. The tool transitions READY -> REVIEW -> REVIEW_COMPLETE and generates a compliance report.

7. Present the report:
    - Overall status (clean, warnings, issues).
    - Findings with severity, category, message (including your content analysis findings).
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

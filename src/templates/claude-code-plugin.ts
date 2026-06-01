import { CLAUDE_REVIEWER_AGENT } from './mandates.js';

export const CLAUDE_CODE_PLUGIN_DIR = 'flowguard-plugin';

export const CLAUDE_CODE_PLUGIN_RELATIVE_FILES = [
  '.claude-plugin/plugin.json',
  'skills/start/SKILL.md',
  'skills/plan/SKILL.md',
  'skills/architecture/SKILL.md',
  'skills/implement/SKILL.md',
  'skills/review/SKILL.md',
  'agents/flowguard-reviewer.md',
  'hooks/hooks.json',
  '.mcp.json',
  'settings.json',
  'dist/mcp-server.js',
  'dist/hooks/pre-tool-use.js',
  'dist/hooks/post-tool-use.js',
  'dist/hooks/session-start.js',
  'dist/hooks/stop.js',
  'dist/hooks/subagent-stop.js',
] as const;

const WRAPPER_RUNTIME = '../../node_modules/@flowguard/core/dist/';
const HOOK_WRAPPER_RUNTIME = '../../../node_modules/@flowguard/core/dist/hooks/';

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

function executableWrapper(target: string): string {
  return (
    `#!/usr/bin/env node
import('${target}').catch((err) => {
  const reason = err instanceof Error ? err.message : String(err);
  process.stderr.write(` +
    '`FLOWGUARD_WRAPPER_UNREACHABLE: ${reason}\n`' +
    `);
  process.exitCode = 1;
});
`
  );
}

function failClosedPreToolUseWrapper(target: string): string {
  return (
    `#!/usr/bin/env node
const { access } = require('node:fs/promises');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const wrapperDir = __dirname;
const targetPath = resolve(wrapperDir, '${target}');

async function main() {
  try {
    await access(targetPath);
    await import(pathToFileURL(targetPath).href);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: ` +
    '`FLOWGUARD_HOOK_UNREACHABLE: ${reason}`' +
    `,
      },
    }) + '\\n');
  }
}

void main();
`
  );
}

export function claudeCodePluginManifest(version: string): string {
  return json({
    name: 'flowguard',
    displayName: 'FlowGuard Governance',
    description: 'Deterministic, fail-closed governance runtime for AI-assisted software delivery',
    version,
    author: { name: 'FlowGuard' },
    skills: './skills/',
    mcpServers: './.mcp.json',
    keywords: ['governance', 'audit', 'workflow'],
  });
}

export function claudeCodeHooksJson(): string {
  return json({
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash|Edit|Write|apply_patch',
          hooks: [
            {
              type: 'command',
              command: 'node',
              args: ['${CLAUDE_PLUGIN_ROOT}/dist/hooks/pre-tool-use.js'],
              timeout: 10,
              statusMessage: 'FlowGuard: checking phase gate',
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: 'Bash|Edit|Write|apply_patch|mcp__flowguard__.*',
          hooks: [
            {
              type: 'command',
              command: 'node',
              args: ['${CLAUDE_PLUGIN_ROOT}/dist/hooks/post-tool-use.js'],
              timeout: 30,
              statusMessage: 'FlowGuard: recording audit',
            },
          ],
        },
      ],
      SessionStart: [
        {
          matcher: 'startup',
          hooks: [
            {
              type: 'command',
              command: 'node',
              args: ['${CLAUDE_PLUGIN_ROOT}/dist/hooks/session-start.js'],
              statusMessage: 'FlowGuard: initializing session',
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: 'node',
              args: ['${CLAUDE_PLUGIN_ROOT}/dist/hooks/stop.js'],
              timeout: 15,
              statusMessage: 'FlowGuard: session checkpoint',
            },
          ],
        },
      ],
      SubagentStop: [
        {
          hooks: [
            {
              type: 'command',
              command: 'node',
              args: ['${CLAUDE_PLUGIN_ROOT}/dist/hooks/subagent-stop.js'],
              timeout: 15,
              statusMessage: 'FlowGuard: recording reviewer corroboration',
            },
          ],
        },
      ],
    },
  });
}

export function claudeCodeMcpJson(): string {
  return json({
    mcpServers: {
      flowguard: {
        command: 'node',
        args: ['${CLAUDE_PLUGIN_ROOT}/dist/mcp-server.js'],
        env: {
          FLOWGUARD_PROJECT_DIR: '${CLAUDE_PROJECT_DIR}',
          FLOWGUARD_HOST_PLATFORM: 'claude-code',
        },
      },
    },
  });
}

export const CLAUDE_CODE_PLUGIN_SETTINGS = json({});

// Shared Discovery-capture instruction. Discovery is advisory falsification
// evidence, NEVER review verdict authority (parity with the OpenCode commands).
const CLAUDE_DISCOVERY_CAPTURE = `Capture the compact Discovery context from the status response: \`health\`, \`drift\`, \`detectedStack\`, repo-native \`verificationCandidates\`, and risk surfaces. Discovery is advisory falsification evidence, never review verdict authority. If Discovery is unavailable, degraded, drifted, timed out, or unchecked, mark every Discovery-dependent claim \`NOT_VERIFIED\`; do not invent repository truth.`;

// Shared host-driven, fail-closed review loop for plan / architecture /
// implement skills. FlowGuard's \`next\` field is the single authority; the
// skill never infers verdicts and never self-approves. There is deliberately
// no "reviewer unavailable" self-approval path: on this host, an unobtainable
// reviewer fails closed.
function claudeReviewLoop(tool: string, artifact: string): string {
  return `## Independent review loop (host-driven, fail-closed)

FlowGuard drives this loop. Read the \`next\` field of every tool response and follow it exactly. Never infer review state, verdicts, or policy yourself.

- When \`next\` starts with \`INDEPENDENT_REVIEW_COMPLETED\`: read \`overallVerdict\` from \`pluginReviewFindings\`. For "approve", call \`${tool}({ reviewVerdict: "approve" })\`. For "changes_requested", revise the ${artifact} to resolve every blocking issue, then resubmit the verdict exactly as \`next\` instructs.
- When \`next\` starts with \`INDEPENDENT_REVIEW_REQUIRED\`:
  1. Delegate to the \`flowguard-reviewer\` subagent (for example: "Use the flowguard-reviewer subagent to independently review this ${artifact}."). The subagent runs in its own context and already has the \`mcp__flowguard__flowguard_review\` tool.
  2. Give the reviewer the ${artifact} text, the ticket text, the \`requiredReviewAttestation\` values (\`toolObligationId\`, \`iteration\`, \`planVersion\`, \`mandateDigest\`, \`criteriaVersion\`), and the captured Discovery context. Instruct it to check Discovery health and drift before any repo-dependent claim and to mark uncorrelated claims \`NOT_VERIFIED\`.
  3. The reviewer returns a complete \`ReviewFindings\` object. Submit the verdict exactly as \`next\` instructs — include that object as \`reviewFindings\` unless \`next\` states findings are resolved automatically.
- Fail closed — never bypass independent review:
  - \`HOST_SUBAGENT_TASK_REQUIRED\`: the active policy (team, team-ci, or regulated) requires host-visible reviewer evidence that this host cannot provide inline. Report the blocker verbatim and STOP. Do not self-approve, fabricate findings, or downgrade the policy.
  - \`SUBAGENT_UNABLE_TO_REVIEW\`: the obligation is consumed. Do not retry the same ${artifact}. Report the reviewer's reason and stop.
  - \`STRICT_REVIEW_ORCHESTRATION_FAILED\`: transient — resubmit the ${artifact} to create a fresh obligation (max 3 attempts).
  - \`ORCHESTRATION_PERMANENTLY_FAILED\`, or any other blocked, failed, malformed, or nonconforming result: report the exact blocker and stop.
  - Never submit a verdict the \`flowguard-reviewer\` subagent did not produce.`;
}

// Shared presentation rule: the reviewCard is mandatory verbatim output.
const CLAUDE_REVIEW_CARD_RULE = `If the response contains a \`reviewCard\` field, display its markdown verbatim — never summarize, truncate, or omit it. The user relies on it to make the review decision.`;

export const CLAUDE_CODE_PLUGIN_SKILLS = {
  'skills/start/SKILL.md': `---
description: Start or resume a governed FlowGuard session through the FlowGuard MCP server. Run this FIRST before any other FlowGuard workflow.
---

# FlowGuard Start

Use the existing FlowGuard MCP tools. Do not infer or mutate FlowGuard state yourself.

1. Call \`mcp__flowguard__flowguard_hydrate\` with no arguments.
2. Read the returned JSON (\`phase\`, \`phaseLabel\`, \`nextAction\`, optional \`productNextAction\`).
3. Report the result: for a new session, confirm it is active and present the available workflows (plan, architecture, review); for an existing session, report the phase label, session id when present, and next action.
4. Note briefly that this is a governed session — every step produces verifiable evidence.
5. If the tool returns a blocked or failed result, report the exact blocker and stop.

Call no other FlowGuard tool during start. Do not use Bash, Edit, or Write in this skill.
`,
  'skills/plan/SKILL.md': `---
description: Submit a governed implementation plan and complete mandatory independent review through FlowGuard MCP tools.
---

# FlowGuard Plan

Use the existing FlowGuard MCP tools. Do not interpret FlowGuard phase or policy state yourself.

## Phase 1 — Check state
1. Call \`mcp__flowguard__flowguard_status\`. If no session exists, call \`mcp__flowguard__flowguard_hydrate\` first. If there is no ticket, tell the user to provide one and stop. If the phase does not allow planning, report the phase and stop.
2. ${CLAUDE_DISCOVERY_CAPTURE}

## Phase 2 — Submit the plan
3. Write the plan in markdown with these required sections: \`## Objective\`, \`## Approach\`, \`## Steps\` (each step names a specific file path and a concrete change), \`## Files to Modify\`, \`## Edge Cases\`, \`## Validation Criteria\`, \`## Verification Plan\` (cite the command AND its Source, e.g. \`Source: package.json:scripts.test\`, or state \`NOT_VERIFIED\` with recovery steps).
4. Submit the plan only through \`mcp__flowguard__flowguard_plan({ planText })\` with the full plan markdown. When revising, include the COMPLETE plan text, never a diff.
5. Read the response; the \`next\` field carries the review workflow.

## Phase 3 — Review
${claudeReviewLoop('mcp__flowguard__flowguard_plan', 'plan')}

## Presentation and rules
- ${CLAUDE_REVIEW_CARD_RULE}
- Treat any blocked, failed, malformed, or nonconforming tool result as terminal: report it and stop.
- Do not call implementation tools (Bash, Edit, Write) during planning. Do not auto-chain into implementation after approval — stop and let the user decide.
`,
  'skills/architecture/SKILL.md': `---
description: Create or revise an Architecture Decision Record (ADR) with mandatory independent review through FlowGuard MCP tools.
---

# FlowGuard Architecture

Use the existing FlowGuard MCP tools. Do not interpret FlowGuard phase or policy state yourself.

## Phase 1 — Check state
1. Call \`mcp__flowguard__flowguard_status\`. If no session exists, call \`mcp__flowguard__flowguard_hydrate\` first. If the phase does not allow \`/architecture\`, report the phase and stop.
2. ${CLAUDE_DISCOVERY_CAPTURE}

## Phase 2 — Submit the ADR
3. For a new ADR (READY phase): write it in MADR format with the mandatory sections \`## Context\`, \`## Decision\`, and \`## Consequences\`, then call \`mcp__flowguard__flowguard_architecture({ title, adrText })\` (the ADR id is auto-generated).
4. For a revision (ARCHITECTURE phase, after changes_requested): revise the ADR to address the findings and submit the verdict in the review loop below — do NOT call \`mcp__flowguard__flowguard_architecture({ title, adrText })\` again; that path is for a brand-new ADR. When revising, include the COMPLETE ADR text.
5. Read the response; the \`next\` field carries the review workflow.

## Phase 3 — Review
${claudeReviewLoop('mcp__flowguard__flowguard_architecture', 'ADR')}

## Presentation and rules
- ${CLAUDE_REVIEW_CARD_RULE}
- Treat any blocked, failed, malformed, or nonconforming tool result as terminal: report it and stop.
- Do not call implementation tools (Bash, Edit, Write) during architecture. Do not auto-chain into plan or implement after approval.
`,
  'skills/implement/SKILL.md': `---
description: Implement the approved plan and complete mandatory independent implementation review through FlowGuard MCP tools.
---

# FlowGuard Implement

Use the existing FlowGuard MCP tools. Do not interpret FlowGuard phase or policy state yourself.

## Phase 1 — Check state
1. Call \`mcp__flowguard__flowguard_status\` and confirm the session is in IMPLEMENTATION phase with a ticket, an approved plan, and passed validation. If any precondition is missing, report it and stop.
2. ${CLAUDE_DISCOVERY_CAPTURE}

## Phase 2 — Implement
3. Read the plan from the status response. Execute each numbered step in order, using the host's Read/Edit/Write/Bash tools, only after FlowGuard's status confirms IMPLEMENTATION. Follow the plan exactly — add nothing beyond what it specifies.
4. After completing ALL plan steps, call \`mcp__flowguard__flowguard_implement({})\` with no arguments (the tool auto-detects changed files via git and records evidence).
5. Record a \`## Verification Evidence\` section distinguishing planned checks from checks actually executed; mark every unexecuted check \`NOT_VERIFIED\`.

## Phase 3 — Review
${claudeReviewLoop('mcp__flowguard__flowguard_implement', 'implementation')}

When the review returns changes_requested, make the actual code changes based on the blocking issues, then call \`mcp__flowguard__flowguard_implement({})\` again to re-record before resubmitting the verdict.

## Presentation and rules
- ${CLAUDE_REVIEW_CARD_RULE}
- Always record evidence (no \`reviewVerdict\`) before submitting a review verdict. Use mutating host tools only after FlowGuard confirms IMPLEMENTATION.
- Treat any blocked, failed, malformed, or nonconforming tool result as terminal: report it and stop. Do not auto-chain into the review decision.
`,
  'skills/review/SKILL.md': `---
description: Run the standalone FlowGuard compliance review flow (READY to REVIEW to REVIEW_COMPLETE) through FlowGuard MCP tools.
---

# FlowGuard Review

Use the existing FlowGuard MCP tools. Do not interpret FlowGuard phase or policy state yourself.

## Steps
1. Call \`mcp__flowguard__flowguard_status\` and confirm the session is in READY phase. If not, report the phase and stop. ${CLAUDE_DISCOVERY_CAPTURE}
2. Resolve any external reference the user supplies, preserving the original reference:
   - PR number: load the diff (\`gh pr view <n> --json ...\` / \`gh pr diff <n>\`), set \`inputOrigin: "pr"\`.
   - Branch: load the branch diff, set \`inputOrigin: "branch"\`.
   - URL: fetch the content, set \`inputOrigin: "external_reference"\`.
   - Manual text: use it directly, set \`inputOrigin: "manual_text"\`.
   - Both text and a reference: set \`inputOrigin: "mixed"\`. No reference: omit \`inputOrigin\`.
3. Call \`mcp__flowguard__flowguard_review\` with the matching content field (\`text\`, \`prNumber\`, \`branch\`, or \`url\`) and optional \`inputOrigin\` / \`references\`.
   - If the response is \`CONTENT_ANALYSIS_REQUIRED\` with \`requiredReviewAttestation\` and no \`pluginReviewFindings\`: delegate to the \`flowguard-reviewer\` subagent, passing the loaded content, the attestation values, and the captured Discovery context. Instruct it to check Discovery health/drift before repo-dependent claims and to mark uncorrelated claims \`NOT_VERIFIED\`. The reviewer returns a complete \`ReviewFindings\` object.
   - Re-call \`mcp__flowguard__flowguard_review\` with the same content field plus \`reviewFindings\` set to that object (as-is — no mapping, no array).
   - If the reviewer returns \`overallVerdict: "unable_to_review"\`, do NOT submit \`reviewFindings\`; report the reason and stop.
4. Fail closed — never bypass review:
   - \`HOST_SUBAGENT_TASK_REQUIRED\`: the active policy (team, team-ci, or regulated) requires host-visible reviewer evidence this host cannot provide inline. Report the blocker verbatim and STOP. Do not self-approve or fabricate findings.
   - \`STRICT_REVIEW_ORCHESTRATION_FAILED\`: transient — re-run this review to retry. \`ORCHESTRATION_PERMANENTLY_FAILED\` or any other blocked/failed result: report the exact blocker and stop.
5. ${CLAUDE_REVIEW_CARD_RULE}

Do not use Bash, Edit, or Write to mutate the repository in this skill.
`,
} as const;

export function claudeCodePluginFiles(version: string): Record<string, string> {
  return {
    '.claude-plugin/plugin.json': claudeCodePluginManifest(version),
    ...CLAUDE_CODE_PLUGIN_SKILLS,
    'agents/flowguard-reviewer.md': CLAUDE_REVIEWER_AGENT,
    'hooks/hooks.json': claudeCodeHooksJson(),
    '.mcp.json': claudeCodeMcpJson(),
    'settings.json': CLAUDE_CODE_PLUGIN_SETTINGS,
    'dist/mcp-server.js': executableWrapper(`${WRAPPER_RUNTIME}mcp-server/index.js`),
    'dist/hooks/pre-tool-use.js': failClosedPreToolUseWrapper(
      `${HOOK_WRAPPER_RUNTIME}pre-tool-use.js`,
    ),
    'dist/hooks/post-tool-use.js': executableWrapper(`${HOOK_WRAPPER_RUNTIME}post-tool-use.js`),
    'dist/hooks/session-start.js': executableWrapper(`${HOOK_WRAPPER_RUNTIME}session-start.js`),
    'dist/hooks/stop.js': executableWrapper(`${HOOK_WRAPPER_RUNTIME}stop.js`),
    'dist/hooks/subagent-stop.js': executableWrapper(`${HOOK_WRAPPER_RUNTIME}subagent-stop.js`),
  };
}

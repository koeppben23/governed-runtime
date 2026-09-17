import { renderCommandGovernanceRules } from '../../rendering/mandates-renderer.js';

export const EXPORT_COMMAND = `---
description: FlowGuard — Materialize the required verifiable export and complete development.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Materialize the required verifiable audit package for the approved development session.

## Steps

1. Call \`flowguard_status\` to verify a session exists.
2. Call \`flowguard_export\` with no arguments. It materializes a raw, verifiable package and transitions only after completion evidence is persisted.
3. Report the completion result and package digest. If the tool is blocked or fails, stop: the session remains \`EXPORT_READY\` and must not be described as complete.
${renderCommandGovernanceRules()}
## Done-when

- Audit package created via flowguard_export and the workflow reaches COMPLETE.
- If \`presentation.markdown\` is present, render it verbatim and do not append a separate \`Next action:\` line.
- Otherwise, render the canonical \`directive\` as the single fallback conclusion.
`;

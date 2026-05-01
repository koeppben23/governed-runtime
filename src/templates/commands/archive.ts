import { GOVERNANCE_RULES } from './shared-rules.js';

export const ARCHIVE_COMMAND = `
---
description: Archive a completed FlowGuard session as a compressed tar.gz file.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Archive the current completed FlowGuard session.

## Steps

1. Call \`flowguard_status\` to verify a session exists.
   - If no session: report "No session to archive" and stop.

2. Call \`flowguard_archive\` with no arguments.
   - Only terminal sessions (COMPLETE, ARCH_COMPLETE, REVIEW_COMPLETE) can be archived.
   - If not terminal: report the current phase and tell the user to complete or abort first.

3. Report the archive file path and confirmation.

## Rules

- Only terminal sessions can be archived.
${GOVERNANCE_RULES}
## Done-when

- Session archive created as tar.gz.
- Archive file path reported.
- Response ends with \`Next action: run /hydrate to start a new session.\`
`;

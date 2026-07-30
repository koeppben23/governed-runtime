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

2. Ask the user for archive parameters, then call \`flowguard_archive\`:
   - \`redactionMode\`: Ask the user.
     \`none\` = raw evidence only (for auditors, requires allowRawExport=true in config).
     \`basic\` = secrets masked as [REDACTED] (safe for sharing).
     \`pseudonymous\` = stable correlation tokens (traceable across events).
   - \`includeRaw\`: Ask the user.
     \`true\` = include raw unredacted files alongside redacted copies (requires allowRawExport).
     \`false\` = redacted files only (safe to share).
   - Only terminal sessions (COMPLETE, ARCH_COMPLETE, REVIEW_COMPLETE) can be archived.
   - If not terminal: report the current phase and tell the user to complete or abort first.

3. Report the archive result:
   - Archive file path and verification status
   - Redaction mode used (\`none\`, \`basic\`, or \`pseudonymous\`)
   - Whether raw evidence is included (\`includeRaw\`)
   - The \`guidance\` text from the tool response verbatim
   - If raw evidence is included: warn that the archive contains unredacted secrets.
     Handle as confidential material.

## Rules

- Only terminal sessions can be archived.
${GOVERNANCE_RULES}
## Done-when

- Session archive created as tar.gz.
- Redaction parameters and guidance reported to the user.
- Response ends with \`Next action: run /hydrate to start a new session.\`
`;

import { GOVERNANCE_RULES } from './shared-rules.js';

export const EXPORT_COMMAND = `
---
description: Export a verifiable audit package for the completed session.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Create a verifiable audit package for the current session.

## Steps

1. Call \`flowguard_status\` to verify a session exists.
2. Call \`flowguard_archive\` with no arguments (creates the audit package with integrity verification).
3. Report the archive status, location, and integrity verification result.
${GOVERNANCE_RULES}
## Done-when

- Audit package created via flowguard_archive.
- Verification result and location reported.
- Response ends with \`Next action: run /start to begin a new governed session.\`
`;

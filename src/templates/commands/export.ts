import { GOVERNANCE_RULES } from './shared-rules.js';

export const EXPORT_COMMAND = `
---
description: Export a redacted audit-sharing package for the completed session.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Create an audit-sharing package for the current session.

## Steps

1. Call \`flowguard_status\` to verify a session exists.
2. Call \`flowguard_archive\` with no arguments (creates the default redacted sharing package).
3. Report the archive status, location, redaction mode, and verification result. A \`not_verifiable\` result is expected for a redacted archive and is not an integrity failure.
4. Canonical verification requires raw evidence (\`redactionMode="none"\`, \`includeRaw=true\`) and repository authorization. If raw export is disabled, report that canonical verification cannot be produced; do not recommend retrying the same export.
${GOVERNANCE_RULES}
## Done-when

- Audit package created via flowguard_archive.
- Verification result and location reported.
- Response ends with \`Next action: run /start to begin a new governed session.\`
`;

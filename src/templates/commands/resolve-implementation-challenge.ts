import { GOVERNANCE_RULES } from './shared-rules.js';

export const RESOLVE_IMPLEMENTATION_CHALLENGE_COMMAND = `
---
description: Record evidence addressing an implementation review challenge.
agent: build
---

## Goal

Record advisory evidence addressing an implementation challenge during IMPL_REVIEW.

## Steps

1. Call \`flowguard_status\` and confirm the current phase is \`IMPL_REVIEW\`.
2. Call \`flowguard_resolve_implementation_challenge({ challengeId, validationAttemptIds })\`.
   - Use the challenge ID from the prior implementation review findings.
   - Use one or more passing post-implementation validation attempt IDs bound to the current digest.
3. Treat the recorded resolution as advisory \`NOT_VERIFIED\` evidence. It does not accept the review or bypass the user gate.
4. Follow the returned next action exactly.

## Rules

- Use only the challenge ID from the active implementation review.
- Use only passing post-implementation validation attempt IDs bound to the current digest.
- Do not treat this advisory record as reviewer acceptance or user approval.

${GOVERNANCE_RULES}
## Done-when

- The tool confirms the resolution evidence was recorded for the specified challenge.
- The response's next action has been surfaced without claiming the challenge is resolved.
`;

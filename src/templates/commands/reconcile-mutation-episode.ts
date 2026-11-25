import { renderCommandGovernanceRules } from '../mandates.js';

export const RECONCILE_MUTATION_EPISODE_COMMAND = `---
description: FlowGuard — Resolve a host mutation episode whose outcome can never be observed.
agent: build
---

## Goal

Resolve an interrupted host mutation dispatch so the session can recover fail-closed.

For a regular failed OpenCode \`edit\`, retry \`/implement\` first: its runtime
boundary can observe the stored error without unknown-outcome resolution.

## Preconditions

1. \`flowguard_status\` shows one or more host mutation episodes in state
   \`dispatch_authorized\`.
2. The host call outcome is truly unobservable (the host process died between the
   Before- and After-hook). Never use this command to bypass a known outcome.
3. A new runtime holds a later lease generation after the original holder died.
   A plugin reload, different runtime ID, or stale heartbeat does not fence a live holder.
4. Outstanding shell/background writers have been stopped separately; lease
   fencing does not prove process-tree quiescence.

## Steps

1. Call \`flowguard_status\` and note the exact \`hostCallId\` of the unresolved episode.
2. Call \`flowguard_reconcile_mutation_episode({ hostCallId })\`.
   - The resolution is append-only: \`reconciled_after_unknown_outcome\` with basis
     \`worktree_recapture\`.
3. Treat ALL prior implementation, validation, and review evidence as unreliable.
4. Re-apply the implementation work, record it with \`/implement\`, re-run the checks,
   and submit a fresh implementation review.

## Rules

- Never resolve an episode with a known outcome.
- Never reuse the resolved \`hostCallId\` for a new host mutation dispatch.
- Do not claim prior evidence remains valid after a resolution.

${renderCommandGovernanceRules()}
## Done-when

- The tool confirms the resolution was recorded for the specified hostCallId.
- The response's next action has been surfaced without claiming the prior
  implementation evidence is still valid.
`;

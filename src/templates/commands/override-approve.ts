import { renderCommandGovernanceRules } from '../../rendering/mandates-renderer.js';

export const OVERRIDE_APPROVE_COMMAND = `---
description: FlowGuard — Accept an exhausted review gate with an explicit governance override.
---

You are managing a FlowGuard-controlled development workflow.

## Goal

Accept the reviewed subject at a governance override gate, where the independent
review exhausted its authorized budget without reviewer acceptance.

Decision context: $ARGUMENTS

## Steps

1. Call \`flowguard_decision({ verdict: "approve_with_governance_override", rationale })\` with rationale from \`$ARGUMENTS\` (or empty string).

2. If FlowGuard blocks the decision (normal gate without exhaustion, insufficient assurance, no bindable review evidence, etc.): report the reason and stop.

3. On success, report what was accepted with the recorded governance override, the new phase, and next action.

## Rules

- Only run this command when the user explicitly invoked /override-approve. Do not infer an override from chat context or review findings.
- A governance override is legal only at a gate whose review loop exhausted its budget without reviewer acceptance. A reviewer-accepted revision is approved with /approve instead.
- The override binds only the exact reviewed subject digest; a different revision can never be accepted through a prior review's override.
- If blocked: report the reason and stop (never work around a blocked decision).
${renderCommandGovernanceRules()}
## Done-when

- Override approval recorded via flowguard_decision.
- Phase transition and next action reported.
- If \`presentation.markdown\` was present, it was printed verbatim and its
  rendered conclusion (the trailing \`→\`/\`•\` command line or the
  \`## Decision required\` block) is the next-action guidance — do NOT append a
  separate \`Next action:\` line.
- Only on the fallback projection (no \`presentation.markdown\`): response ends
  with a \`Next action:\` line.
`;

# Native V2 activation and scope

Implementation contract for PR #1190, 2026-11-01. This is not an operator-source
attestation or a passing ACTIVE V2 release decision. Draft / **ACTIVE V2 NO-GO**
remains in force. Findings 5–7 and the separate #1191/#1192 work are not closed here.

The [pinned operator-handoff investigation](./operator-handoff.md) demonstrates
that the local keyboard distinction is lost through ordinary plugin RPC:
SDK payload replays have the same handler-visible context. It does not authorize
root decisions or replace the outstanding product positives.

## Canonical ownership

- `src/state/governance-activation.ts`: strict revision, enrollment, head and
  native delegation-dispatch schemas. No host SDK shape enters these schemas.
- `src/machine/governance-activation.ts`: explicit activating → active → ending
  → inactive lifecycle, reactivation generations and delegated continuations.
  Workflow finish/abort is not EndGovernance.
- `src/adapters/governance-activation.ts`: append-only revisions, canonical
  digests, atomic committed head and independent permanent enrollment marker.
  Root mutations require an injected, non-serialized authorization function;
  no origin field or command string implements that function.
- `src/integration/opencode-governance.ts`: exact native location/parent/call/
  message/agent correlation, host progress receipt handling and scoped waits.
  `plugin.ts` composes this boundary before workflow/Git/logger/enforcement work.

## Inactive, active and blocked

Verified nonenrollment requires a successful absent-head read, absent independent
enrollment marker and empty revision-prefix scan. Existing workflow bytes do not
activate a session. Storage errors, missing parts of an enrolled journal, corrupt
digests, orphan prepared revisions, incomplete transitions and foreign/stale
generations block instead of becoming INACTIVE. Losing the whole revision
namespace leaves the independent enrollment marker as a fail-closed witness.
The private store is trusted host infrastructure, not tamper-proof external
storage: erasing **all** private enrollment and journal data is not independently
detectable. No claim of protection against complete trusted-store erasure is made.

ACTIVE callbacks also require the canonical workflow binding, enrolled worktree
and frozen policy digest. Rejected runtime initialization is evicted, not cached
as a permanent failed promise. Event-stream loss fences ACTIVE operations only;
a handler failure fences its resolved root scope, not unrelated INACTIVE work.
Session-error audit, failed-tool mutation reconciliation and system-work resume
failures propagate from the canonical event handler to that fence; only
in-memory cleanup of a deleted session remains non-blocking. Delegated-session
errors are audited in the governed root trail with their native session ID, and
a delegated child's idleness does not trigger root system work.

## Native call identity

OpenCode 2.2.4 passes the provider's tool-call ID verbatim as the native call ID
(`packages/core/src/tool.ts`); it is unique only within one host-generated
assistant message. Mutation episodes, completion binding, failed-tool
reconciliation and delegation dispatch keys therefore use the canonical
`{ sessionId, messageId, callId }` identity. A provider-reused ID in another
session or message is a distinct call; replay of the same native call remains
blocked. A host notification lacking any of the three values fails closed.

Bounded mutation for this change (unchanged 80% gate; event handler, failed-tool
reconciliation, projection/identity, controller and lifecycle machine): a first
snapshot taken **before** the final three boundary tests scored 92.44% and is not
evidence for those tests. The final code/test run scored **92.87%** (401 killed,
29 timed out, 32 survived, 1 no coverage), with both new identity mutants
(`messageId` comparison in the lifecycle and the stored-dispatch binding) killed.
Remaining notable survivors: the generation clause in enrollment is shadowed by
the preceding activation-ID check (a valid journal cannot change generation
without a new activation ID), and `own.record !== null` for an ended session
with a native parent is unreachable until a root End path exists (Finding 5).
Waiter/linking bookkeeping and event-identity helpers account for the rest.

Setup publishes canonical inert help. Existing active roots restore productive
definitions, and prompt preflight prepares them before request snapshots. Context,
compaction and generate hooks hide productive definitions from INACTIVE and
delegated views. The native executor independently checks fresh authority;
neither skipped hooks nor direct hydrate can establish activation. Native model,
provider, variant, permissions and generation options are not rewritten.

## Ordinary native delegation

`subagent` is the current host delegation identity; obsolete `task` is not an
alias in the phase classifier. Delegation is not a completed host mutation.
The separate Claude Code hook adapter translates that host's supported `Task`
payload at its own boundary; removing OpenCode V1 does not remove another
supported host's current API or its existing subagent checks.
Before authorization, the existing state/error, integrity, command and audit
gates remain in force. Actual child mutations additionally pass the root's
phase, Git, risk, discovery and mutation-episode gates.

Parent metadata alone does not enroll a child. Enrollment requires a dispatch
authorized after the real before-gates and an observed `session.tool.progress`
with the exact parent session, assistant message and call identity. Host child
metadata must match parent, directory and selected agent. Continuations consume
their new dispatch/receipt and preserve the root activation generation, including
legitimate native non-reviewer agent switches. Children cannot submit parent
workflow decisions. Durable dispatch intent alone cannot reconstruct a missing
ephemeral receipt after restart. A committed enrollment can be revalidated after
restart against its parent and root authority.
Stale or foreign requested children are refused before native continuation
dispatch. Resolution under a held root lock reads committed enrollment only;
it never waits for a progress receipt whose enrollment needs the same lock.
An already settled dispatch receipt is ignored, including after a newer
same-agent continuation; replay cannot move enrollment back to an older call.

Reviewer dispatch remains separately blocked pending its real release/completion/
capture proof. None of these ordinary-delegation receipts mint reviewer evidence,
operator decisions or regular edit-error terminality. Transport-v5 and
`review-assurance.v7` remain unchanged.

## Verification boundaries

Canonical lifecycle/journal, native scope correlation and real-gate component
suites cover isolation, corruption/loss, replay, incomplete transitions and child
effects. Native-host smoke suites compare INACTIVE shell/edit/subagent effects,
provider-wire catalogues and compaction. The active-scope native smoke uses an
explicit **component-only** private-store authorization fixture around the actual
product hooks; its RPC is never installed by the product and is not operator UI
acceptance. It must not replace a required reviewer or operator positive.

Actual trusted root Start/End, attributable approval/capacity recovery, full
Desktop/CLI acceptance, reviewer provenance and regular edit-error completion
remain **NOT_VERIFIED / BLOCKED** at their existing owners. Historical host probe
bytes are unchanged. Verification outcomes belong to the exact candidate run,
not this contract description or an earlier green checkpoint.

### Local candidate verification (2026-11-01)

- `npm test`: **12,741 passed**, the same two existing skips, 700 passing files.
- Full pinned-host smoke with `OPENCODE_LIVE=1 RUN_OPENCODE_ACP_TESTS=1`:
  **114 passed / 6 failed / no skips**. INACTIVE effects/catalogues/compaction,
  actual native delegation and agent-switch continuation, root-generation
  restoration after SIGKILL, ACTIVE budgeting negatives and packed lifecycle
  checks pass. The active-scope and budget tests use the explicitly labeled
  component admission fixture, never a fabricated operator decision.
- The six retained failures are the four real reviewer capture/recovery
  acceptance tests and two regular edit-error recovery positives. Their titles,
  assertions and required positive outcomes are unchanged. They remain Findings
  6/7 blockers; the suite is **not green** and does not authorize ACTIVE V2 release.

The native fixtures and private-store admission RPC are test-only source excluded
from the production graph and tarball. They do not supply an installed Start/End
interface or close Finding 5. No full-profile mutation admission or exact-head CI
success is inferred from these test counts.

The first seven-file bounded mutation run failed the unchanged 80% break gate
at **69.64%**. A separate controller/late-composition snapshot failed at
**58.37%**. Neither is passing evidence or full-profile admission. Subsequent
hardening adds independent journal/scope-field negatives, deterministic mutation
test names, bounded waiter success/failure/shutdown tests, ACTIVE request-view
positives and settled-receipt replay rejection.

After hardening, the same seven-file bounded run passed the unchanged gate at
**85.68%** (925 killed, 32 timed out, 143 survived, 17 no coverage). Because the
settled-receipt fix landed during that run, `opencode-governance.ts` was rerun on
the final bytes: **89.70%** (181 killed, 28 timed out, 23 survived, 1 no coverage).
Timeouts are counted by Stryker but are not presented as assertion kills.
`plugin-beforehooks.ts` remains individually below 80% (**68.99%**); these are
bounded diagnostic runs, not full-profile admission of the new targets.

# Finding 6 step 2: native dispatch authority

This is the dispatch-only port following the accepted
[`f0de6a41` mechanism checkpoint](./reviewer-transport-mechanism.md).
**Finding 6 remains BLOCKED; Draft / ACTIVE V2 NO-GO is unchanged.**
Native dispatch does not authorize capture, evidence, audit binding or recovery.
The four required native reviewer-product contracts retain their original titles
and positive security outcomes; these dispatch tests do not replace them.

## Canonical authority and ordering

`plugin.ts` still registers every native hook exactly once. Its native reviewer
composition consumes the existing frozen prompt renderer,
`persistAuthorizedReviewDispatch()`, current obligation/attempt validators,
`updateAttemptStatus()` and the canonical state/outbox writer. It introduces no
reviewer process, alternative evidence writer, approval source or review workflow.

1. The ordinary capture fence, phase/integrity gates and audit reconciliation run
   first. A delegated child cannot authorize a parent's review operation.
2. Under the existing root activation lock, the exact native
   `{ sessionId, messageId, callId }` delegation is checked for replay and current
   activation generation. Only a fresh foreground `flowguard-reviewer` child is
   admitted. Background release, continuation, caller model override and unknown
   arguments fail before release. The host's omitted-background foreground default
   is accepted and made explicit as `background: false`; configured agent or
   inherited model/provider/variant selection is not restricted or substituted.
3. Exactly one pending FlowGuard operation must match the persisted current
   obligation and created, unbound attempt. The canonical frozen prompt is
   rendered and revalidated inside the ledger write lock against fresh state.
   Parent/worktree/policy, capacity locks and prior releases are checked there.
4. `persistAuthorizedReviewDispatch()` completes before the delegation projection
   is persisted and before the native before-hook returns. The model-authored
   prompt is replaced, not trusted. No host child can start through this release
   when either persistence step fails. A failure after the first write leaves
   that attempt spent/quarantined, not safely retryable. Missing assurance state
   now throws instead of allowing the shared writer to silently return success.
5. Only an exact real `session.tool.progress` receipt can enroll the actual child.
   Parent, directory, agent and activation generation must agree. The canonical
   attempt is durably bound to the child before committing its activation
   enrollment. Child prompt/context resolution waits for that enrollment, so a
   binding or enrollment-write failure cannot release the reviewer model.
6. Every reviewer scope resolution rechecks the exact dispatch/attempt/obligation
   and bound child. Prompt admission accepts only the original exact native host
   prefix plus digest-bound FlowGuard bytes, without attachments, skills or agent
   mentions, into empty child history. Context and primary model-request hooks
   require exactly the original user request and only its assistant steps.
   Foreign/second prompts, synthetic/control history, completed idle history and
   compaction fail closed. Reviewer tools remain read-only and cannot authorize
   mutations, nested delegation or workflow decisions. Auxiliary model requests,
   transient generation and compaction are not authorized by this dispatch.

Direct reviewer-root prompt admission remains only admission, not dispatch or
execution authority. Its existing budget-first context rejection is preserved;
the subsequent lineage check also refuses it. This keeps numeric-cap/config
negatives observable without admitting any reviewer provider request.

There is deliberately no cross-store transaction claim: ordering and repeated
validation make partial writes fail closed. Enrollment uses the existing native
dispatch projection, not a second review registry. Child binding keeps the original
canonical native call identity on the ledger; it does not re-key it to a raw child
ID or manufacture V1 message fields.
An ordinary-agent continuation cannot reassign or reuse the independently bound
reviewer child either; the original committed delegation identity remains the
authority even when the caller requests a different agent.

## Completion, unknown outcomes and reload

The native after-hook still refuses reviewer completion/capture. It does not parse
the free-form result, serialize JSON, fulfill an obligation or record invocation
evidence. A normally finished child is therefore **not** a completed FlowGuard
review at this checkpoint.
The exact parent return also revokes the live native reviewer admission projection.
Even if the original admission failed or a delayed enrollment later commits,
another prompt cannot restart that child under the old release. The durable
ledger remains unresolved; revocation is not proof that existing work has stopped.

Any unresolved or outcome-unknown review release prevents another native reviewer
release in the same parent, including a newly minted attempt or another
obligation. The dispatch adapter does not run the former deadline/rearm route.
Reload cannot reconstruct permission to resume a reviewer from persisted lineage
alone: the existing native delegation projection must also belong to this live
adapter instance. Pending receipts and already enrolled reviewers are fenced after
reload; this is quarantine, not recovery or a quiescence assertion. No timeout,
idle notification or caller recovery claim unlocks a new native release here.

The exclusive capture lease, exact serialization request/terminal provenance,
effective model/variant attestation, atomic evidence/audit binding and safe
unknown-outcome recovery remain steps 3/4. No claim is made that the initial
review context checks already establish those later capture guarantees.

Transport generation 5 and `review-assurance.v7` are unchanged and distinct.
The pending native invocation instruction now says `call_subagent`,
`native_subagent`, `subagent.agent` and `background: false`; it explicitly declares
findings blocked pending native capture. It is not a new evidence generation.
Command templates use that native contract without V1 `task` argument aliases.

## Verification surfaces

- `plugin-native-review-dispatch.test.ts`: real journal/ledger persistence with
  component native inputs; ordering, exact mapping, replay/concurrency, foreign
  identity, frozen-state changes, write failures, prompt restrictions and reload
  quarantine. These callbacks are not actual-host execution evidence.
- `opencode-reviewer-dispatch-live.smoke.test.ts`: actual product hooks with explicit
  component-only activation on the unchanged pinned OpenCode **2.2.4** binary.
  The first real reviewer provider request observes the durable exact parent call,
  obligation/attempt and already-bound actual child while the native parent tool
  is still running. It verifies the exact prefixed prompt digest and denies a
  foreign same-child prompt. Separate native background/model-override cases
  observe no reviewer provider request and no dispatch. No capture/evidence is
  accepted. This is not installed StartGovernance/UI or autonomous-start evidence.
- The native four-contract suite and unchanged independent-review verifier remain
  the final Finding-6 acceptance boundary, not this narrower dispatch suite.

Reproduce the native dispatch check:

```sh
npm run build
OPENCODE_LIVE=1 npx vitest run --project smoke src/cli/opencode-reviewer-dispatch-live.smoke.test.ts
```

The source/host versions and precise host prefix semantics remain those recorded
in the accepted prerequisite. No custom host build, synthetic parentID, provider
substitution, weaker verifier, test exclusion or longer coverage-test timeout is
introduced by this port. Policy-dependent autonomy/approval rules are unchanged.

## Local verification

- Component dispatch suite: **35 passed / 0 skipped**, including exact
  ledger-before-journal ordering, current-attempt freshness, revalidation under
  the ledger write lock, replay/concurrency, foreign native child identity,
  direct-child reassignment, missing state/write failure, prompt/context/history
  restrictions and reload/return quarantine.
- Full ordinary suite: **702 files / 12,842 passed / 2 existing skips**.
- Full pinned native smoke (`OPENCODE_LIVE=1 RUN_OPENCODE_ACP_TESTS=1`):
  **125 passed / 4 failed / 0 skipped**. All four failures are exactly the
  unchanged required reviewer capture/evidence/recovery contracts; none is a
  dispatch failure. The step-2 native dispatch smoke passes all three cases.
- The unchanged independent-review verifier fails on exactly those four required
  titles. The dispatch additions do not replace them.
- Bounded mutation on the frozen source/test snapshot: **89.00% total / 90.00%
  covered**, **558 killed / 62 survived / 7 no coverage / 0 timeout**, plus 296
  compile-invalid mutants rejected by the TypeScript checker. The unchanged
  `break: 80` threshold passes. Source and covering-test snapshots were identical
  before and after the run.
- Typecheck, strict lint, formatting, architecture, build, doc drift, unused
  dependencies/exports and the unchanged CI coverage gate pass locally. The CI
  coverage run completed **702 files / 12,833 passed / 11 skipped**, including
  the unchanged 15-second `production-build-boundary` test without a timeout.
  Test selection, timeout and coverage thresholds were not modified; this local
  result does not certify hosted CI.

**NOT_VERIFIED:** native completion/capture/evidence/audit binding, safe
unknown-outcome recovery, installed Desktop/CLI activation and full ACTIVE V2
acceptance. Hosted CI for the new commit and cross-provider/variant capture
coverage remain open. The dispatch port proves authorization/binding and
quarantine behavior only.

# Finding 6 step 3: same-child capture and evidence binding

2026-11-02 checkpoint, updated 2026-11-03, PR #1190. **Implementation and
bounded proof, not complete Finding 6 acceptance.** At historical checkpoint
`2acef049`, three capture/evidence product contracts passed and the fourth
recovery contract failed. The bounded mutation result predates the subsequent
settlement/R4 changes; it is not current-tree assurance.

**Step-4 update (2026-11-03, #1169 WS4):** unknown-outcome recovery is implemented in
`review/dispatch/native-review-settlement.ts` (later user turn, interrupt + stable
idle boundary of the stale child, exact lineage, one audited reopen mutation) and
the release fence admits only the superseding re-arm attempt. The independent
review verified all four required native contracts and `independent-review-e2e`
in CI at `b9a41e5b`. The local follow-up below additionally proves R2 native
SIGKILL/reload continuation and a settlement crash boundary. Complete settlement
race acceptance, R4 residuals
and full reviewer parity remain open, so Finding 6 stays **BLOCKED** / ACTIVE V2
**NO-GO**. See the [current subcontract matrix](./phase0-contract-gates.md#p0-05--p0-08-evidence-breakdown-2026-11-03).

## Trust chain

### R1/R3 correction: initial review provenance

The initial-review history is no longer accepted by selecting its last assistant.
`NativeReviewInitialController` consumes live prompt, context, primary-request
and tool-boundary observations inside the existing native capture composition:

- The first context is exactly the observed host-prefixed user request, including
  its native message ID; attachments and additional history are rejected.
- Each primary request consumes exactly one preceding context snapshot. Before
  another context or terminal capture, exactly one corresponding assistant must
  extend that unchanged snapshot, with the observed effective model/variant and
  reviewer agent. A second completed assistant cannot borrow the first request's
  authority. There is no invented model-request assistant ID.
- Nonterminal assistants must finish with tool calls. Every tool must match its
  actual local before/after boundary by child, owning assistant ID, call ID, tool,
  input digest and terminal status. Parallel permitted tools and multiple review
  steps remain supported; arbitrary extra assistants do not.
- The final step is tool-free `stop` followed by successful idle. Foreign user,
  synthetic, switch, compaction, unexplained content and mutated prefix entries
  cannot become the capture baseline. Reload cannot synthesize missing receipts.

Pinned host source: `session/model-request.ts` calls the context hook before
`model.request`; `session/runner/step.ts` publishes each step and local tool calls
under their owning assistant ID. These observations bind a strict sequential
window; a history projection by itself supplies no authority. A changed or
unobserved execution path remains blocked rather than inferred from idle.

New native-host probes preserve a real multi-step/read positive and reject real
synthetic input during the initial review without serialization/evidence. The
four required product titles remain unchanged. This correction does not claim
restart recovery, universal host-path coverage or a completed independent audit.

**Tool-result provenance limit:** the live before/after receipts bind identity,
input and terminal status, not a digest of returned result content. A component
counterprobe supplied an original result in the after-boundary and different
result text in the subsequent history; both the original and replaced content
were accepted before that history became the next frozen prefix. Later prefix
mutation is rejected, but that is a different guarantee. This establishes the
controller's current validation limit, not a demonstrated reachable native-host
injection path. Do not describe these tests as a proof of tool-result-byte
attestation. The [R4 native result-boundary investigation](reviewer-tool-result-evidence.md)
now reproduces later privileged After/Context replacements and actual post-hook
normalization/truncation. It does not prove unprivileged reachability or establish
a provider-neutral immutable final-consumption boundary. Hashing a
pre-normalization or pre-truncation tool result must not be assumed equivalent
to the host history or outgoing request. R4 remains open; no production receipt
or evidence-recorder change is made by that research checkpoint.

### R2 restart reconciliation (2026-11-03)

`plugin-native-review-capture.test.ts` now proves the chain on real persistence and
outbox: committed generation-6 evidence, an injected projection failure, then a
restart without plugin runtime, capture fence, pending review or reviewer child.
The canonical `flowguard_plan` verdict consumes the committed invocation from
persisted state alone and the obligation becomes `consumed` without a second
reviewer prompt. This is component proof, not process death.

The follow-up native test in `opencode-reviewer-capture-live.smoke.test.ts`
also passes locally on macOS with the actual OpenCode 2.2.4 server and built
FlowGuard product hooks. A test-only observer fails the outward result assignment
after V6 evidence is durably committed. The test then kills the server with
`SIGKILL`, reloads the same stores without re-seeding activation/state, and
submits the canonical verdict through the native parent tool path. The original
obligation becomes `consumed`, the invocation identity/attempt/dispatch remain
unchanged, no new child or reviewer/serialization request appears, and the audit
prefix is preserved with a valid chain. This proves review continuation, not
the full Java/ProofGraph/ISO workflow or installed Desktop acceptance.

### Adversarial settlement follow-up (2026-11-03)

- Component composition: interrupt/wait/history failures and changing history
  leave the lock and audit unchanged. Two concurrent recovery calls reach the
  real session write lock: only one reopens with one durable semantic audit
  intent; the other rejects. Reconstructed authority rejects stale completion
  and old-child prompt/validation without changing evidence.
- Native crash boundary: a test-only barrier pauses immediately after the
  **real** host `interrupt(resume: false)` returns, before settlement can reopen.
  `SIGKILL` and reload retain the blocked obligation/dispatch/attempt and audit;
  only a later native retry completes through a fresh attempt. This is one
  controlled crash point, not an exhaustive crash matrix.
- Native old-child redispatch: after fresh-attempt recovery, a direct prompt to
  the interrupted historical child is refused without another provider request
  or evidence change. It is not proof that the host cannot perform arbitrary
  later activity after plugin unload.

Reproduce against a completed build, serially (do not rebuild `dist` while the
native host is running):

```sh
npm run build
OPENCODE_LIVE=1 npx vitest run --project smoke \
  src/cli/opencode-reviewer-capture-live.smoke.test.ts
npx vitest run --project integration \
  src/integration/plugin-native-review-capture.test.ts \
  src/integration/review/dispatch/native-review-settlement.test.ts
```

The four required product titles/outcomes, verifier, mutation selection/thresholds
and coverage timeout are unchanged. **NOT_VERIFIED:** native concurrent recovery
and forced late-completion scheduling across every settlement/re-arm crash point;
current-tree mutation and independent/installed acceptance of these additions.

Historical note (previous checkpoint):

An injected post-commit projection error leaves canonical evidence fulfilled;
completion replay does not serialize again, and the continuation remains
`awaiting_verdict`. The component regression records this distinction, not an
end-to-end recovery PASS. Required proof remains: committed evidence, failed
projection, actual process restart, canonical continuation, successful workflow
completion without another reviewer. The evidence recorder is not rewritten to
compensate for a missing projection proof.

### Dispatch through serialization

The native after-hook is not an authority source. It receives only the
pre-bound dispatch/attempt/child identity and asks the canonical capture owner to
prove one serialization window. Returned model text can never create a dispatch,
attempt, child or obligation.

1. **Pre-bound target.** The after-hook requires the exact native call, a current
   authorized dispatch, the created attempt, the actual child bound at progress
   time, and a unique pending obligation. Missing/foreign lineage throws
   `REVIEWER_EXECUTION_OUTCOME_UNKNOWN` and writes no evidence.
2. **Initial review completion.** The live initial-review controller must prove
   every step and tool boundary as described above, the exact frozen prompt and
   a normal terminal model/variant completion. History alone cannot establish it.
3. **Exclusive lease.** `NativeReviewCaptureFence` permits at most one capture
   per child. The lease owns the exact serialization request ID and prompt
   digest. A second begin, replay, foreign prompt, duplicate context/model step,
   or tool attempt fails closed. Tools are removed from the outgoing context;
   a provider-emitted tool still reaches the before-hook and permanently
   contaminates that lease.
4. **Terminal provenance.** After an explicit request ID, the history must be
   exactly `baseline + [user, assistant, idle(succeeded)]`. The assistant must be
   the one requested response, `finish: "stop"`, completed with no error, carry
   no tool content, and contain exactly the strict JSON payload. The primary
   model request must have been observed once with the same effective
   provider/model/variant. Missing/interrupted terminals are an unknown outcome,
   not an accepted capture.
5. **Canonical validation and binding.** The payload is parsed as one strict JSON
   object, validated as `ReviewerFindingsInput`, prepared with host provenance,
   then passed through the existing challenge/findings validators. The canonical
   evidence recorder binds attempt, invocation, dispatch completion and
   obligation fulfillment in one durable mutation; audit intents are written by
   the same outbox. No invocation exists on any failure path.

## Transport evidence generation 6

Historical `transportVersion: 5` (`native_task_message_json`) is unchanged and
remains explicitly validated. The current OpenCode transport is:

- `invocationMode: "native_subagent_message_json"`
- `transportVersion: 6`
- `capture`: the existing exact request/response/model/payload record
- `nativeProvenance`: the V2-only terminal window, primary model request,
  history digest, one user message, zero tool attempts, and canonical native call

The schema rejects v6 without matching provenance, or v5 carrying V2 provenance.
The v5 and v6 dispatches keep their own call identities; V2 completes the
original native call record and binds the child on the attempt instead of
rewriting the call ID. Historical bytes are not normalized.

## Fail-closed behavior

- A tool-contaminated serialization blocks with
  `REVIEWER_CAPTURE_PROVENANCE_INVALID`, leaves no invocation, and terminally
  rejects the attempt in the same mutation.
- An interrupted/unreadable terminal window blocks with
  `REVIEWER_EXECUTION_OUTCOME_UNKNOWN`; the dispatch becomes `outcome_unknown`,
  the attempt stale and a capacity lock is set. An interrupted terminal without an
  assistant row is classified the same way (not as a provenance violation). The
  step-4 settlement above is the only reopen path.
- Audit persistence failure prevents the state mutation from becoming accepted
  evidence through the existing canonical outbox. No second writer is used.
- The after-hook never trusts native result text, metadata completion, or a
  caller claim as evidence.

## Historical R1/R3 review checkpoint verification (`b54d9caa`)

- Full ordinary suite: **707 files / 12,997 passed / 2 existing skips**.
- Full pinned native smoke: **130 passed / 1 failed / 0 skipped**. The only
  failure is the unchanged recovery contract. Both added initial-review native
  probes pass: permitted multi-step/read and refused synthetic contamination.
- The unchanged independent-review verifier fails only the recovery contract.
- Typecheck, strict lint, format, architecture, build/doc drift, dependency/export
  usage, script tests and changed-workflow actionlint checks pass.
- CI coverage: **707 files / 12,988 passed / 11 skipped**, exit 0, unchanged
  15-second boundary.
- Bounded mutation: **82.57% total / 84.30% covered**, exit 0 at unchanged
  `break: 80`; **725 killed / 135 survived / 18 no coverage / 0 timeout** and
  501 compile-invalid mutants. The initial controller scores **88.52%**.
  The run keeps every previous source target/test and adds the initial-review
  controller and regressions. Its native Stryker 10.1.1 initial run executes
  **721 tests**; all **28 frozen source/test/config hashes** match `b54d9caa`.
  This is not an all-source or per-file mutation PASS: capture is **72.20%**,
  capture-failure routing **25.00%**, and the host adapter **73.61%**. Surviving
  and uncovered mutations remain visible; no threshold, test, target or mutator
  was removed to obtain the aggregate result.
- Mutation JSON SHA-256:
  `c908f7ac09ef4c07503437e0ef8a2b0264888b9c97d69346e0617aa7d09ba04d`.
- **NOT_VERIFIED:** hosted-CI acceptance and native tool-result-content
  provenance beyond the receipt identity/input/status checks above.
- **NOT_VERIFIED:** actual process-restart R2 continuation, unknown-outcome
  recovery and installed ACTIVE workflow acceptance remain open.

## Historical verification at the step-3 implementation checkpoint (`33efb381`)

- Full ordinary suite: **704 files / 12,871 passed / 2 existing skips**.
- Full pinned native smoke: **128 passed / 1 failed / 0 skipped**. The only
  failure is the unchanged recovery contract; three product capture/evidence
  contracts pass.
- Component proof: exact window/model/baseline/request/tool contamination,
  V5/V6 schema separation, and the V6 evidence mutation itself.
- CI coverage: **704 files / 12,862 passed / 11 skipped**, exit 0, unchanged
  15-second boundary.
- Bounded mutation on the frozen source/covering-test snapshot: **64.65%**
  (**448 killed / 175 survived / 70 no coverage / 0 timeout**), below the
  unchanged `break: 80` threshold. This is a real verification gap for the new
  capture/evidence surface, not a green mutation claim. Step 4 is not claimed.

# Finding 6 step 3: same-child capture and evidence binding

2026-11-02, PR #1190, head after the dispatch port. **Step 3 is implemented;
Finding 6 remains BLOCKED because unknown-outcome recovery (step 4) is not.**
The three capture/evidence product contracts now pass; the fourth
recovery contract remains intentionally red. Draft / ACTIVE V2 NO-GO is unchanged.

## Trust chain

The native after-hook is not an authority source. It receives only the
pre-bound dispatch/attempt/child identity and asks the canonical capture owner to
prove one serialization window. Returned model text can never create a dispatch,
attempt, child or obligation.

1. **Pre-bound target.** The after-hook requires the exact native call, a current
   authorized dispatch, the created attempt, the actual child bound at progress
   time, and a unique pending obligation. Missing/foreign lineage throws
   `REVIEWER_EXECUTION_OUTCOME_UNKNOWN` and writes no evidence.
2. **Initial review completion.** The child history must contain exactly the
   authorized user prompt with the exact native host prefix and frozen prompt
   digest, no compaction, and a normally completed final assistant step with a
   concrete model/variant.
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
  `REVIEWER_EXECUTION_OUTCOME_UNKNOWN`; the durable dispatch remains unresolved
  and the existing quarantine fences a new reviewer release. Step 4 must prove
  safe re-arm; this step does not.
- Audit persistence failure prevents the state mutation from becoming accepted
  evidence through the existing canonical outbox. No second writer is used.
- The after-hook never trusts native result text, metadata completion, or a
  caller claim as evidence.

## Verification

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

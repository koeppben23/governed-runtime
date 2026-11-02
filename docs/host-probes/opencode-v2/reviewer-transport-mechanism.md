# Finding 6: native reviewer transport prerequisite

2026-11-02, PR #1190, historical `f0de6a41` step-1 checkpoint. **Bounded mechanism positives, not reviewer acceptance.**
At this historical checkpoint the product's release/capture blocks were in place
and its four required native reviewer contracts still failed. Draft /
**ACTIVE V2 NO-GO** remains unchanged.
ADR-010's V1-parity/autonomous-operation amendment is not weakened.

The subsequent [step-2 dispatch port](./reviewer-dispatch-authority.md) connects
canonical authorization and actual Child binding, and the
[step-3 capture port](./reviewer-capture-evidence.md) adds the current
same-child terminal/evidence generation. The release blocks described below are
the historical step-1 state; recovery remains blocked in the subsequent ports.
Neither checkpoint closes Finding 6.

## Authorities and exact inspected versions

- Native installed CLI: **2.2.4**, client/plugin **2.2.4**. macOS arm64 executable
  SHA-256: `03fc30769f28dd346d2279baae77ef71308175cd49eb7a5be339d3860ee99ec1`.
- Upstream immutable source: [`v2.2.4`, `45898d0f8569225eb1ddb4ee13f8581b34dff311`](https://github.com/anomalyco/opencode/tree/45898d0f8569225eb1ddb4ee13f8581b34dff311).
  Source claims use that commit's Git objects, not a possibly modified checkout.
  The local upstream checkout contains unrelated edits; these were not reverted,
  built or used as installed-host proof. In particular, `session/model-request.ts`
  was re-read from the immutable commit rather than its modified working copy.
- V1 baseline inspected at local `origin/develop`
  `bd05351f3d04f592c3d865895e7c4283d74f623c`: structured follow-up, capture and
  dispatch/binding owners. [ADR-009](../../decisions/009-model-neutral-review-transport.md)
  records the prior successful V1 verification. No V1 live execution was rerun
  for this step; its historical result is not a new V2 PASS.
- Current canonical owners remain the dispatch ledger, attempt/obligation state,
  capture controller, strict JSON parser, findings validators, evidence recorder
  and audit outbox. This step introduces no alternate review authority or schema.

Living vendor references, read 2026-11-02:
[plugins](https://opencode.ai/v2/docs/build/plugins),
[server hooks](https://opencode.ai/v2/docs/build/plugins/server),
[migration](https://opencode.ai/v2/docs/migrate-v1). These are interface guides,
not a substitute for the pinned source and executable observations below.

## Pinned source semantics

| Owner at the upstream commit                                              | Established source fact                                                                                                                                          | Limit                                                                                          |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `packages/core/src/tool/plugin/subagent.ts:190–219,240–271`               | Native child creation/inheritance, actual child progress, new-child prompt prefix and foreground `jobs.block()`; result/metadata carry the child ID              | Completion text or child metadata alone does not bind a FlowGuard attempt                      |
| `packages/core/src/session/session.ts:155–188,278–280`                    | Prompt returns the durable inbox admission; `wait()` delegates to the execution coordinator's `awaitIdle()`                                                      | Admission is not completion of a particular request                                            |
| `packages/core/src/session/run-coordinator.ts:16–24,92–114,164–170`       | Interrupt acknowledges before cleanup finishes; execution settlement and `awaitIdle()` include the coordinator's own cleanup/settled hooks and successor recheck | This is not a universal descendant/job/remote-effect quiescence proof or a recovery capability |
| `packages/core/src/session/store.ts:194` and `session/history.ts:183–214` | `context()` loads the latest projection with a compaction boundary                                                                                               | Missing older content cannot establish that it never existed                                   |
| `packages/core/src/session/model-request.ts`, `prepare()`/`agentHook()`   | Context has session/agent/model/messages/tools; `model.request` has session/agent/model/kind, not an arbitrary assistant-message ID                              | Do not invent hook IDs or map the latest answer to a request by time/text                      |
| `packages/core/src/tool.ts:316–336`                                       | The before-tool hook runs even before request-snapshot availability checks                                                                                       | A denied/unoffered tool attempt remains contamination, not a clean capture                     |
| `packages/core/src/session/message-updater.ts:217–274`                    | Host step events create/update the owning assistant ID and persist finish/model/completion fields                                                                | V2 assistant messages do not acquire a V1 `parentID`                                           |

## Corrections to the four product fixtures

`opencode-reviewer-capture-test-helpers.ts` now loads the existing
`COMPONENT_ACTIVATION_SETUP` around the actual product. `openReview()` seeds its
strict workflow first, then explicitly enrolls that exact session/worktree/policy
in the component-only journal. It does **not** overwrite the strict state with a
generic activation fixture or represent the RPC as product StartGovernance.

The dispatch assertion now derives `nativeHostCallId(parentID, message.id, tool.id)`
from the real parent transcript's owning assistant/tool pair, not the raw provider
call ID. The four required titles and positive security outcomes remain intact.
No production reviewer block, verifier, evidence format, threshold or test
selection changes.

With these corrections the plan tool reaches the active product and emits its
pending review obligation. The first contract still fails because the expected
`reviewExecution` release is absent; actual authorization/capture has not been
connected. Consequently that run does not yet reach the corrected dispatch-ID
assertion; its positive product outcome is not claimed. The other three required
reviewer contracts also remain red. Fixing
their setup is not a replacement for their missing implementation.

## Executed isolated native mechanism

`src/cli/opencode-reviewer-transport.smoke.test.ts` and its test helper load a
separate observation/fencing fixture with the real native reviewer agent, **not
the FlowGuard product**. No product activation, dispatch record, review evidence
or audit write is performed. The returned JSON intentionally is fixture payload,
not accepted `ReviewerFindingsInput` or a new transport proof generation.

The local provider can hold a specific response through an explicit Promise gate.
It is not a sleep/timing guess or mocked host callback. Request sequence IDs are
captured before the await so concurrent requests cannot overwrite the fixture's
response/call identity. Text markers route deterministic provider replies and arm
sandbox instrumentation only; they are not an authorization mechanism.

Five actual-host cases pass:

1. **Foreground → same child → exact terminal window.** While the child's real
   provider response is held, the native task remains running and the parent
   prompt remains unsettled. Actual progress/session metadata agrees with the
   parent call's session/message/call tuple. After release, one child review
   assistant completes normally. Its first user prompt is exactly the host's
   documented prefix plus the supplied review bytes, not an arbitrary substring.
   The same child admits a fresh explicit serialization ID. While its response is
   held, admission/history does not show a completed capture. After release and
   the execution barrier, the entire pre-capture prefix is unchanged and the
   suffix is exactly that user request, one normal assistant and succeeded idle.
   Exactly one capture context/model request is observed. The host-selected
   `capture/probe#chosen` model agrees with persisted model and controlled wire
   `reasoning_effort: high`; no tools, required tool choice or StructuredOutput
   are added. No response `parentID` is synthesized.
2. **Foreign queued input.** Another real user request admitted during the held
   capture produces a second user and second assistant/model step. Choosing the
   latest JSON would conflate requests. This fixture exposes the invalid window;
   it does not claim that the still-unported product has rejected/bound it.
3. **Actual unoffered read attempt.** The context fixture removes executable
   tools. A provider-emitted read still reaches the native before-hook, which
   refuses it before execution. The actual history contains the failed read;
   the sentinel never appears in provider requests. A later JSON answer requires
   another step and does not erase that observed attempt.
4. **Interrupted exact request.** Interrupting the held serialization, then
   waiting on the host execution barrier, exposes its admitted request and
   interrupted idle. The host may persist an explicit aborted assistant row or no
   assistant row; either way no normal completed assistant exists. No quarantine
   is released, new attempt authorized or `quiescence: true` invented by this
   observation.
5. **Compaction during capture.** A real queued manual compaction completes and
   is visible as a checkpoint and a `model.request` of kind `compaction`, not an
   uninterrupted one-step capture. The provider supplies the pinned host's summary
   template; an earlier failed run correctly exposed a fixture response that did
   not match it. No custom host build or synthetic history projection is used.

Reproduction:

```sh
npm run build
OPENCODE_LIVE=1 npx vitest run --project smoke src/cli/opencode-reviewer-transport.smoke.test.ts
OPENCODE_LIVE=1 npx vitest run --project smoke src/cli/opencode-reviewer-capture-live.smoke.test.ts
```

Focused results: **5 mechanism positives passed**, **all four required product
reviewer contracts still failed**. Only the former is a bounded mechanism result;
it must not replace the latter in independent-review verification.

## Implementation sequence and remaining proof obligations

| Step                            | Canonical change after its prerequisites                                                                                                                                       | Required admission                                                                                                                                                                                                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Native mechanism             | This isolated foreground/same-child probe and corrected product fixtures                                                                                                       | Controlled request/terminal window observed; no product evidence acceptance                                                                                                                                                                                                                                                          |
| 2. Authorized dispatch          | Wire native before/after/context paths through `persistAuthorizedReviewDispatch()`, existing obligation/attempt and exact child enrollment; reuse `canonicalTaskPrompt()`      | Durable exact dispatch precedes child execution; reject wrong/replayed/cross-scope calls, background release, agent/model overrides and unbound children. Verify exact FlowGuard prompt bytes separately from the native prefix. Do not merely remove `assertReviewerBoundary()`                                                     |
| 3. Capture and binding          | Port the existing capture owner to actual V2 prompt/context/model/tool/history observations; keep strict parsing, findings validation and the canonical evidence/outbox writer | Exclusive child lease and exact admitted request; unchanged required history prefix; one corresponding normal assistant/model step; exact effective model/variant; no tools, interleaving, extra steps, truncation, drift, missing history or compaction during capture. Denied attempts contaminate. Audit failure prevents binding |
| 4. Unknown-outcome recovery     | Keep original dispatch/child/lease quarantine and use proven settlement authority, not caller claims                                                                           | Demonstrate relevant execution cannot continue before rearm; late activity cannot contaminate a fresh attempt. Capacity locks do not auto-release. Complete joint job/descendant quiescence remains NOT_VERIFIED; investigate the exact host gap if required interfaces cannot establish it                                          |
| 5. Product/installed acceptance | Four unchanged native contracts, independent-review verifier, full regression/coverage, architecture and targeted mutation, then native smoke and installed CLI/Desktop        | Passing real product execution/evidence/audit/recovery and exact candidate/artifact CI, not positive fixture callbacks or this report                                                                                                                                                                                                |

Important unverified assumptions must be resolved before implementation depends on
them: race-safe exclusive admission and snapshot/commit coupling; complete capture
coverage for all claimed native execution paths; auxiliary/generate requests,
effective-model changes and compaction handling; restart-safe quarantine and
rearm under original-dispatch settlement. This probe does **not** establish those
properties for all hosts/providers, reloads, abandoned attempts or arbitrary
concurrent callers. Missing required assurance still blocks the affected operation.

After provenance is demonstrated, replace the V1-shaped transport contract with
an explicit current V2 proof generation at its existing schema/validator owners.
Do not add a parallel capture pipeline, synthesize V1 fields, silently reinterpret
transport-v5 as V2 or conflate it with `review-assurance.v7`. Historical bytes stay
unchanged and remain inspectable with their corresponding historical version;
the current FlowGuard runtime must not add legacy dual-read/normalization shims.
The reviewer stays fully automatic with only existing policy exceptions.

## Local verification of this prerequisite change

- Focused native mechanism: **5 passed / 0 skips**.
- Corrected native product reviewer suite: **4 failed / 0 skips**, retaining its
  required titles and positive outcomes. The unchanged independent-review verifier
  fails on exactly those four contracts.
- Full native smoke with `OPENCODE_LIVE=1 RUN_OPENCODE_ACP_TESTS=1`:
  **122 passed / 4 failed / 0 skips** across 22 files. It is not a green suite.
- Final `npm test`: **701 files / 12,806 passed / 2 existing skips**. The first
  run exposed an unnecessary unregistered fixture error-code literal and the
  preceding README ADR fragment reference against the existing path checker.
  The fixture uses a diagnostic error name instead of a new product reason;
  README links to the canonical ADR file and names the amendment. Neither
  registry nor link verification was weakened. Their three focused suites passed
  **137 tests**, followed by the successful full rerun.
- Typecheck, strict lint, formatting, architecture (**538 tests**), build/doc
  drift, unused dependencies and diff check pass. No production runtime module,
  config/reason registry, capture validator, evidence generation, test exclusion
  or timeout/coverage/mutation threshold changed.

**NOT_VERIFIED:** product dispatch/capture/evidence/audit/recovery acceptance,
cross-provider/variant completeness, installed Desktop/CLI workflow and new-head
hosted CI. Run the four required native contracts and
`npm run test:independent-review-e2e` after the actual port, then the full release
gates in the plan above. No new production mutation result or local coverage run
is claimed for this test-only step. The separate CI production-graph timeout
diagnosis remains open; this prerequisite does not change its 15-second boundary.

# R4: native tool-result representation boundary

2026-11-02 research, updated 2026-11-04 and 2026-11-06, PR #1190. **R4
final-input integrity under the untrusted-co-installed-plugin contract is
NOT_SUPPORTED by the public OpenCode 2.2.4/2.2.5 APIs. This is a feasibility
finding, never R4 `PASS`. The 2026-11-06 operator decision accepts it as a
documented host limitation under the trusted-plugin operating model; untrusted
co-installed plugins are outside the supported V2 security boundary. R4 is not a
merge gate under that model, but no receipt may claim tool-result-byte
attestation.**

## Bounded feasibility conclusion (2026-11-04)

**Result: NOT_SUPPORTED on the pinned public host contract.** OpenCode has
internal send boundaries, but FlowGuard has no host-reserved, non-bypassable
integrity check there. The presence of an internal final send is not a public
plugin capability. No production code, tail hook, digest, verifier, test outcome,
provider/model selection or trust assumption is changed by this investigation.
The undesired evidence fulfillment in the counterexamples remains reproducible;
this documentation does not add a runtime refusal for those paths.

### Evidence and pin

- FlowGuard source/build: `9419453196c9a14ec7437c0ded72ff7722c27e86`.
- Executed host: `/opt/homebrew/bin/opencode`, reporting `opencode v2.2.4`;
  the existing fixture enforces that exact version. Node: `22.22.2`.
- Re-fetched source: OpenCode release commit
  [`45898d0f8569225eb1ddb4ee13f8581b34dff311`](https://github.com/anomalyco/opencode/commit/45898d0f8569225eb1ddb4ee13f8581b34dff311)
  (`release: v2.2.4`). Source conclusions below refer to this commit, not current
  upstream HEAD. Version matching is not a reproducible binary-build attestation.
- The [V2 server-plugin documentation](https://opencode.ai/v2/docs/build/plugins/server)
  describes mutable request hooks and ordering, not a protected final verifier.
  The pinned source and installed `@opencode/plugin@2.2.4` declarations were
  checked rather than assuming the live documentation is version-frozen.

### Last exposed mutation versus actual send

These are the last **supported hook** mutation points on the inspected paths,
not a claim that arbitrary code in the server process cannot mutate anything
later. Co-installed plugins remain untrusted for reviewer integrity.

1. **Shared hook dispatch:**
   [`plugin/hooks.ts:69–95`](https://github.com/anomalyco/opencode/blob/45898d0f8569225eb1ddb4ee13f8581b34dff311/packages/core/src/plugin/hooks.ts#L69-L95)
   appends registrations and passes the same event through callbacks in order.
   It returns that event without sealing it. The public
   [`ModelHooks` contract](https://github.com/anomalyco/opencode/blob/45898d0f8569225eb1ddb4ee13f8581b34dff311/packages/plugin/src/promise/registration.ts#L1-L19)
   offers registration/disposal and provider scoping, not an exclusive last
   observer, immutable receipt or protected veto. Registering another tail does
   not reserve the last position against future registrations.
2. **Native HTTP:** context processing is followed by media shaping and
   `model.request` in
   [`model-request.ts:263–333`](https://github.com/anomalyco/opencode/blob/45898d0f8569225eb1ddb4ee13f8581b34dff311/packages/core/src/session/model-request.ts#L263-L333).
   After protocol lowering, `http.request` callbacks may replace the web
   `Request`. Only after **all** callbacks return does
   [`model-request.ts:334–364`](https://github.com/anomalyco/opencode/blob/45898d0f8569225eb1ddb4ee13f8581b34dff311/packages/core/src/session/model-request.ts#L334-L364)
   construct the private `sent` request and call `handler(sent)`. The native
   [`executor.ts:229–246`](https://github.com/anomalyco/opencode/blob/45898d0f8569225eb1ddb4ee13f8581b34dff311/packages/ai/src/route/executor.ts#L229-L246)
   hands it to `http.execute`. FlowGuard cannot register a protected check between
   final construction and that handoff. `http.response` runs after sending and
   carries `before.request`, not a host-origin attestation of private `sent`;
   its TypeScript `readonly request` is neither a pre-send gate nor a runtime seal.
3. **Session WebSocket:**
   [`model-request.ts:366–391`](https://github.com/anomalyco/opencode/blob/45898d0f8569225eb1ddb4ee13f8581b34dff311/packages/core/src/session/model-request.ts#L366-L391)
   forwards `experimental.ws.send`'s replaceable `frame` to the transport.
   [`model-transport.ts:370–392`](https://github.com/anomalyco/opencode/blob/45898d0f8569225eb1ddb4ee13f8581b34dff311/packages/core/src/session/model-transport.ts#L370-L392)
   runs that interceptor after driver frame creation, then sends its returned
   string through `connection.sendText`; the connector calls
   [`ws.send(message)`](https://github.com/anomalyco/opencode/blob/45898d0f8569225eb1ddb4ee13f8581b34dff311/packages/ai/src/route/transport/websocket.ts#L285-L307).
   This is the last exposed frame rewrite, not an exclusive validator. Stateful
   continuation/checkpoint and HTTP fallback also preclude treating a single
   context snapshot as universal wire proof.
4. **AI-SDK routes:** the public
   [`sdk`/`language` hooks](https://github.com/anomalyco/opencode/blob/45898d0f8569225eb1ddb4ee13f8581b34dff311/packages/plugin/src/promise/aisdk.ts)
   can substitute provider objects. The host ultimately calls
   [`language.doStream(options)`](https://github.com/anomalyco/opencode/blob/45898d0f8569225eb1ddb4ee13f8581b34dff311/packages/core/src/aisdk.ts#L711-L723).
   When an SDK uses the host-supplied fetch, the HTTP middleware delegates to
   the selected `send` function in
   [`aisdk.ts:122–224`](https://github.com/anomalyco/opencode/blob/45898d0f8569225eb1ddb4ee13f8581b34dff311/packages/core/src/aisdk.ts#L122-L224).
   A substituted language implementation is not publicly required to use that
   fetch. Hence neither `http.request` nor an SDK wrapper establishes an
   all-provider mandatory final boundary. This is source evidence, not a new
   executed SDK-bypass probe.

### Six unchanged native controls

Reran `src/cli/opencode-reviewer-tool-result-live.smoke.test.ts` with its helpers
and assertions unchanged on the built source above: **6 passed, 0 failed,
0 skipped** (22.19 seconds). Interpretation remains deliberately asymmetric:

| Controls                                         | Count | Result                                                                                                                                                                         |
| ------------------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `observe`                                        | 1     | Original read correlates across After, terminal event, History, Context and fixture-provider request.                                                                          |
| `after-mutation`, `truncate`, `context-mutation` | 3     | Existing bounded protections reject before the replacement marker reaches the provider; no invocation or serialization.                                                        |
| `dynamic-context-mutation`, `http-mutation`      | 2     | **Counterexamples persist:** replacement marker reaches the fixture provider, History retains the original, one serialization binds an invocation and the obligation fulfills. |

This is a diagnostic runner PASS and an **R4 assurance failure**. It proves
fixture-provider reception on the exercised text/HTTP path, not internal model
consumption, unprivileged hook installation, all-provider/media coverage or
WebSocket rejection. Component-seeded activation is not installed operator
acceptance. Reproduction (build first; never rebuild during a native run):

```sh
npm run build
OPENCODE_LIVE=1 OPENCODE_CLI=/opt/homebrew/bin/opencode \
  npx vitest run --project smoke \
  src/cli/opencode-reviewer-tool-result-live.smoke.test.ts
```

### Required host-side extension, not a proposed plugin workaround

A usable host contract would need all of the following; these capabilities do
**not** exist in the inspected public 2.2.4 API:

- A host-owned validation/send transaction after every plugin transformation,
  host normalization/truncation, protocol/body overlay and transport lowering.
  The validator must see an owned immutable snapshot, and the host must send
  exactly that accepted snapshot with no subsequent plugin rewrite or retained
  mutable alias (no check/send race).
- A protected capability to deny dispatch before any bytes/frame are sent;
  ordinary plugins must not remove, reorder, replace or bypass that validator.
  Identical enforcement must cover retries, continuations, WebSocket full/delta
  frames, reconnects, HTTP fallback and SDK/custom transports. Opaque routes
  without this guarantee must be explicitly unsupported, not silently exempted.
- Host-origin lineage and a verifiable mapping from the canonical terminal tool
  result to the outgoing representation: session/child, owning assistant/tool
  call, model/provider, request/step, transport and any continuation base. A
  post-send receipt must distinguish accepted snapshot, attempted send and
  confirmed delivery; none alone proves a provider's internal model consumption.
- A documented enforcement/isolation boundary for untrusted plugin code. A new
  ordinary hook or a frozen object alone cannot protect a verifier against
  arbitrary same-process code. The host must state and enforce which plugin
  capabilities are confined; this investigation does not establish such isolation.

No host patch or upstream issue is created here. R4 remains **NOT_SUPPORTED**.
Under the 2026-11-06 operator decision, the trusted-plugin operating model
accepts this as a documented host limitation; untrusted co-installed plugins are
outside the supported V2 security boundary. `NOT_SUPPORTED` is not a `PASS`, not
an optional-review mode, human-reviewer substitution, policy exception or
provider restriction, and it authorizes no runtime bypass. P0-00 INACTIVE parity
and installed Desktop/CLI acceptance remain independent gates; PR #1190 may not
claim R4 assurance.

**NOT_VERIFIED in this documentation-only investigation:** new host enforcement
(requires the host extension), native SDK/WebSocket/media adversarial coverage,
installed Desktop/CLI acceptance, and full regression/coverage/default mutation
reruns (`npm test`, `npm run test:coverage:ci`, `npm run mutation`). The six
unchanged diagnostics do not substitute for those checks.

## Real Java workflow observation (2026-11-05, OpenCode 2.2.5)

A real Desktop workflow (`ses_e5474d7e2ffdq5xKh6vzeCt3FG`) reached PLAN and
delegated the reviewer child `ses_e54712495ffeJDoA48kWEn4aDf`. The local host
database retains the complete child history; the parent export alone did not.
The child ran six assistant steps and 31 tool calls. The only non-completed
result was the final `read`:

```text
call_03_Vy6mwEGD2kI2NeKt2D447586 read
path: .../src/test/resources
error: { type: "tool.execution", message: "File not found: .../src/test/resources" }
```

Earlier context checks passed while all prior tools were completed. The child
then failed with `REVIEWER_COMPLETION_UNVERIFIABLE`; the parent `subagent` result
only exposed `REVIEWER_EXECUTION_OUTCOME_UNKNOWN` ("did not expose an exact
completed child") with `metadata.sessionID` and `status: running`. The parent
cause was lost, and the artifacts do not contain the persisted
`session-state.json`, so the dispatch/attempt/capacity lineage and the offered
`retry_transport` recovery could not be confirmed from the supplied files.

The child session reports host version **2.2.5**, not the pinned 2.2.4 used by
the earlier R4 probes. An isolated host probe with a missing `read` was run
against the real **2.2.4** and **2.2.5** binaries (the 2.2.5 diagnostic used a
version shim solely to pass the old pin check; the executed binary was 2.2.5).
Both produced the same model-input error envelope:

```json
{
  "type": "error",
  "value": {
    "error": { "type": "tool.execution", "message": "File not found: ..." },
    "content": []
  }
}
```

FlowGuard's `modelToolResult` expected the unwrapped `{ error, content }`,
so every legitimate failed tool result was rejected. The canonical expectation
is corrected to the observed envelope; changing the error text or content is
still rejected by the same exact comparison. A real pinned 2.2.4 smoke test now
exercises the failed-read projection; the 2.2.5 shim observation is diagnostic
evidence, not a committed pin change.

Bounded corrections in this change:

- `toolResultMismatch` now reports the call ID, tool name, observed/expected
  structural shapes and short digests; it never logs tool content and retains
  the exact rejection decision.
- An errored `subagent` completion with a known child now reads the child's
  terminal error, durably closes the exact authorized dispatch/attempt, and
  preserves the child cause in the parent error detail. A terminal child cause
  (including `REVIEWER_COMPLETION_UNVERIFIABLE`) blocks with that cause and does
  **not** offer `retry_transport`; a non-terminal unknown outcome offers it only
  after the durable lineage is proven.
- Component tests cover both the terminal and non-terminal paths, including
  dispatch `outcome_unknown`, stale attempt, capacity lock, parent cause detail
  and the `unknownOutcomeTarget` recovery predicate.

The isolated failed-read reproduction explains the real reviewer abort: the
final missing `read` produced a legitimate error envelope that the old
comparison rejected. The child cause is preserved and the dispatch closure is
now durable; the terminal integrity cause does not silently become a retryable
transport failure. P1 `/start` selection and help metadata remain separate open
findings; no full Java workflow is claimed by this component evidence.

## Earlier bounded correction and counterexamples

The dated sections below retain earlier observations and check results. They are
historical evidence, not additional verification of the feasibility conclusion.

## R4 correction (2026-11-03, #1169 WS4)

Historical trust boundary (superseded by the 2026-11-06 amendment): co-installed
plugins were treated as untrusted for review evidence. FlowGuard registered two
**tail hooks per reviewer child** when the reviewer was admitted. Dynamic registration appends them after every setup-time
hook, including later-ordered plugins and the R4 fixture hooks:

- `execute.after` tail: the reviewer read result must still equal the digest
  FlowGuard recorded at its own after-hook position (receipt in
  `native-review-initial.ts`). A replacement invalidates the run; the next
  context hook refuses the request, so the replaced bytes never reach the model.
- `context` tail: every model-input tool result must equal the host projection
  of the stored native tool part (`to-llm-message.ts` mapping: one text part to
  `{type:'text', value}`, otherwise `{type:'content', value}`, errors to
  `{error, content}`). A mismatch invalidates the initial run or taints the
  capture lease before any HTTP request.

No result is frozen: the pinned host's post-hook tool path
(`tool.ts` `executeTool`, `runtime.ts` `normalizeContent`,
`tool-output.ts` `truncate`) and context lowering (`model-request.ts`
`replaceMedia`) were inspected and only copy, but freezing host `Message`
instances could still conflict with host internals. Legitimate host truncation
happens after all hooks and is stored in history, so it matches the context check.

The three native counterexamples are now rejection tests in
`opencode-reviewer-tool-result-live.smoke.test.ts` (no invocation, obligation not
fulfilled, marker never in a reviewer provider request, no serialization); the
`observe` positive stays. The follow-up ran all six result-boundary probes
locally on macOS with the real pinned 2.2.4 host.

**Residual limits (NOT_VERIFIED / not covered):** hooks registered dynamically
after FlowGuard's tails; hooks ordered before FlowGuard that alter a result
before FlowGuard observes it; `http.request`/WebSocket/AI-SDK transport
replacement after context. These remain documented R4 limits.

## Follow-up: reachable plugin residuals (2026-11-03)

**Operator decision after `ed7b698d`: retain the existing security contract.**
Co-installed plugins remain untrusted for reviewer evidence. R4 requires a
demonstrated host-side integrity boundary; there is no authorization to weaken
the verifier, exclude these paths as trusted, or create a second reviewer runtime.
The 2.2.4 public `ModelHooks` API offers registration/disposal and provider scope,
not an exclusive final observer. In the pinned source, `PluginHooks.trigger`
returns the same mutable event after registration-ordered callbacks, and
`model-request.ts:340–363` constructs the actual private `sent` HTTP request only
after request hooks return. A response-hook `readonly request` TypeScript field
is not an immutable host-origin receipt. WebSocket send/receive callbacks also
return mutable frames. No supported all-provider final-consumption proof is
established by those interfaces. Another tail/early digest is not a closure.
This blocks R4 acceptance, not safe implementation of the independent parity
backlog; the native counterexamples are retained.

Two additional native diagnostics now reproduce residual replacements through
ordinary plugin hook APIs, without changing the product, host source, reviewer
tool or evidence recorder:

| Probe                      | Actual order / mutation                                                                                                                                                                    | Observed result                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `dynamic-context-mutation` | A plugin registers its context callback in the first reviewer `model.request`, after FlowGuard has attached its tails. The callback replaces the read's `tool-result` on the next context. | Marker reaches the reviewer fixture provider; history retains the original result; V6 evidence fulfills the obligation. |
| `http-mutation`            | A plugin replaces tool-message content in `http.request` after context validation.                                                                                                         | Marker reaches the reviewer fixture provider; history retains the original result; V6 evidence fulfills the obligation. |

These tests explicitly assert the **undesired** fulfilled outcome as a
counterexample diagnostic. Their green test runner result is not an integrity
PASS. The three existing After/Context rejection tests and the unchanged-read
positive still pass in the same run.

The fixture controls plugin installation/registration (privileged relative to
an ordinary caller). It does not prove that caller text can install code, or
that every provider/WebSocket path is reachable. It does establish that these
installed-plugin APIs can bypass the present tails on the pinned host. Under
the historical operator assumption that co-installed plugins are untrusted for
review evidence, **these paths cannot be excluded as trusted-host behavior**.
R4 acceptance therefore required an enforcement boundary or an explicit operator
contract decision. The 2026-11-06 amendment made the latter: R4 is `NOT_SUPPORTED`
and the supported V2 model is trusted-plugin. No narrower threat model was
silently adopted and no speculative digest/second evidence authority is
introduced here.

```sh
npm run build
OPENCODE_LIVE=1 npx vitest run --project smoke \
  src/cli/opencode-reviewer-tool-result-live.smoke.test.ts
```

## Historical research scope and authority (before `b9a41e5b`)

The real pinned OpenCode 2.2.4 host loads FlowGuard's product hooks and existing
dispatch/capture/evidence/audit owners. A deterministic OpenAI-compatible HTTP
provider drives an initial reviewer read, continuation and same-child JSON
serialization. Component activation is explicitly seeded: this does not prove
interactive/autonomous activation authorization or an installed ACTIVE workflow.

`opencode-reviewer-tool-result-test-helpers.ts` installs observations and explicit
mutation hooks **after** `Product.setup` through the shared native test fixture.
These are privileged fixture hooks, not an unprivileged attacker, replacement
read tool, replacement reviewer runtime or production authority. Successful
counterexample tests mean that the undesired outcome was reproduced, not that
FlowGuard rejected it. Only test helpers/tests and evidence documentation change.

FlowGuard's current receipt owner is
`src/integration/review/dispatch/native-review-initial.ts`: it binds local tool
identity, input and terminal status, not result bytes. No new receipt authority,
digest, provider restriction or compensating authentication system is introduced.

## Answers to the four review questions

### 1. Where is the final tool result available?

There are distinct representations, not one universal final result:

- Tool implementation output is initially normalized by
  [`tool/runtime.ts`](https://github.com/anomalyco/opencode/blob/45898d0f8569225eb1ddb4ee13f8581b34dff311/packages/core/src/tool/runtime.ts).
  The native read already presents an array of content parts at `execute.after`.
- [`tool.ts:158–173`](https://github.com/anomalyco/opencode/blob/45898d0f8569225eb1ddb4ee13f8581b34dff311/packages/core/src/tool.ts#L158-L173)
  runs After callbacks, then normalizes content/images again.
- [`runner/step.ts:124–128`](https://github.com/anomalyco/opencode/blob/45898d0f8569225eb1ddb4ee13f8581b34dff311/packages/core/src/session/runner/step.ts#L124-L128)
  applies generic output truncation before terminal publication.
  [`tool-output.ts:69–119`](https://github.com/anomalyco/opencode/blob/45898d0f8569225eb1ddb4ee13f8581b34dff311/packages/core/src/tool-output.ts#L69-L119)
  skips it if `metadata.truncated` is already defined.
- [`publish-llm-event.ts:607–624`](https://github.com/anomalyco/opencode/blob/45898d0f8569225eb1ddb4ee13f8581b34dff311/packages/core/src/session/runner/publish-llm-event.ts#L607-L624)
  publishes local `session.tool.success` with the session, owning Assistant, call
  ID, normalized/truncated content and metadata. This is a terminal execution
  representation; the probe verifies its exact content against stored History.
  It is **not** proof of the later model-input representation.

### 2. Can content change after Before/After observation?

Yes. The native probes demonstrate all of these separately:

| Mode               | Observed outcome                                                                                                                                                                                                                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `observe`          | Real read content matches After, terminal event and History; Context maps it to a tool result and the provider receives its text.                                                                                                                                                                                     |
| `after-mutation`   | A later test hook replaces the After content with a string. Host normalization converts it to a text part; terminal event, History, Context and provider request contain the replacement. Evidence still fulfills.                                                                                                    |
| `truncate`         | A later test hook injects 3,000 lines plus an end sentinel and clears the truncation flag. The host's actual generic truncator removes the sentinel and adds the full-output notice. The terminal event reports `truncated: true`; History and provider text match the truncated representation, not the After bytes. |
| `context-mutation` | A later test Context hook replaces the outgoing generic tool result. After, terminal event and stored History retain original text; the provider receives the replacement. Evidence still fulfills.                                                                                                                   |

Hooks execute sequentially in registration order:
[`plugin/hooks.ts:88–95`](https://github.com/anomalyco/opencode/blob/45898d0f8569225eb1ddb4ee13f8581b34dff311/packages/core/src/plugin/hooks.ts#L88-L95).
The later hooks here are deliberately privileged instrumentation. These results
do not establish that an ordinary model/user/RPC caller can install such a hook
or cause the same modification without that privilege.

### 3. Can the actual outgoing representation be bound to the receipt?

**For the observed text/HTTP path, correlation is demonstrable; reliable
provider-neutral production enforcement is not established.** Each test matches
the exact child/session, owning Assistant and call across After, terminal event
and stored tool entry, then the same call in outgoing Context, the HTTP hook and
the actual provider-received request. The latter proves receipt by the fixture
provider, not internal consumption by a real model.

[`to-llm-message.ts:127–141`](https://github.com/anomalyco/opencode/blob/45898d0f8569225eb1ddb4ee13f8581b34dff311/packages/core/src/session/runner/to-llm-message.ts#L127-L141)
maps one text part to `{ type: "text", value }` and multiple parts to
`{ type: "content", value }`. The test checks that distinction without equating
the pre-truncation representation to the model result.
[`openai-chat.ts:589–623`](https://github.com/anomalyco/opencode/blob/45898d0f8569225eb1ddb4ee13f8581b34dff311/packages/ai/src/protocols/openai-chat.ts#L589-L623)
lowers content text parts with newline joining and the corresponding tool-call
ID; other providers/media need their own mapping and are not tested here.

[`model-request.ts:263–387`](https://github.com/anomalyco/opencode/blob/45898d0f8569225eb1ddb4ee13f8581b34dff311/packages/core/src/session/model-request.ts#L263-L387)
builds a model request after mutable Context hooks, with further media shaping.
`model.request` itself does not expose messages or an owning Assistant ID.
HTTP hooks may replace the request, and WebSocket hooks expose separate frame
transformations. An earlier product observation is therefore not automatically
an immutable last observation. Transport-hook mutation and WebSocket/provider
coverage are source observations, not additional executed native counterprobes.

A terminal-result digest could bind stored execution content, but alone cannot
prove what later Context/transport transformations transmit. Re-reading History
also cannot detect the demonstrated Context-only replacement. Neither is
implemented as a speculative fix. A reliable final-consumption/enforcement
contract must be established before adding such an attestation.

### 4. Does the native lifecycle reject manipulated result content?

**Not in the two privileged replacement probes.** Both reach the real canonical
evidence writer, one persisted invocation and a fulfilled obligation; the
Context-replacement case performs exactly one serialization. The host/product
does not reject these injected replacements. This is stronger than a synthetic
component counterexample but weaker than proof of an unprivileged production
attack. The required assurance-positive rejection outcome remains unproved;
these diagnostic green tests must not be counted as acceptance of R4.

## Reproduction and limits

```sh
OPENCODE_LIVE=1 npx vitest run --project smoke src/cli/opencode-reviewer-tool-result-live.smoke.test.ts
```

All four diagnostics pass on the pinned host (Node 22.22.2). They leave the four
required reviewer-product contracts, verifier, evidence recorder, mutation
selection/thresholds and coverage timeout unchanged. The previously published
82.57% bounded aggregate mutation PASS is not a rerun or a per-file assurance
claim; its security-sensitive survivors remain relevant.

Checkpoint checks:

- Focused native run (R4 + initial-review + four required product contracts):
  **9 passed / 1 failed / 0 skipped**. All four R4 diagnostics and both initial
  provenance probes pass. The unchanged fresh-attempt recovery product contract
  fails (`blocked` instead of `fulfilled`); the other three product contracts pass.
- `npm run test:independent-review-e2e`: **FAIL**, reporting only that same
  required recovery contract. The verifier and required titles are unchanged.
- `npm run check`, `npm run lint:strict`, `npm run check:format`,
  `npm run check:unused-dependencies`: **PASS**.
- `npm run test:architecture`: **51 files / 538 tests PASS**.
- `npm run check:doc-drift`: **PASS**, including build and 17 documentation tests.

**NOT_VERIFIED on this research delta:** full ordinary/native regression,
coverage and mutation reruns. Recovery commands are `npm test`,
`OPENCODE_LIVE=1 npm run test:smoke`, `npm run test:coverage:ci` and the unchanged
mutation profiles (`npm run mutation` for the default profile). No production
authority/guard/transition changes are made in this checkpoint.

**NOT_VERIFIED:** unprivileged replacement reachability; all-provider/media and
WebSocket binding; reliable immutable final-consumption enforcement; hosted CI
and installed Desktop/CLI ACTIVE acceptance. R2 restart reconciliation and
unknown-outcome recovery remain separate step-4 obligations. No Finding 6 closure
or complete PR audit is claimed.

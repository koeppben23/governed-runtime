# R4: native tool-result representation boundary

2026-11-02 research, updated 2026-11-03, PR #1190. **Bounded correction and
remaining native counterexamples, not complete R4 acceptance. R4 is open;
Finding 6 remains BLOCKED / ACTIVE V2 NO-GO.**

## R4 correction (2026-11-03, #1169 WS4)

Trust boundary (operator decision): co-installed plugins are untrusted for review
evidence. FlowGuard now registers two **tail hooks per reviewer child** when the
reviewer is admitted. Dynamic registration appends them after every setup-time
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
the existing operator decision that co-installed plugins are untrusted for
review evidence, **these paths cannot be excluded as trusted-host behavior**.
R4 acceptance is therefore **BLOCKED** on an enforcement boundary or an explicit
operator contract decision; no narrower threat model is silently adopted and no
speculative digest/second evidence authority is introduced here.

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

# Phase 02 follow-up: prevention surfaces and reviewer chain — OpenCode 2.2.4

**NO-GO. P0-04 and P0-05 remain NOT_VERIFIED as complete gates.** This report
records bounded installed-host observations, including two concrete preventive
facts and two counterexamples. It does not implement a product policy, mint
independent-review evidence, prove an operator channel, or certify Desktop/TUI.
P0-01 remains BLOCKED; product implementation and merge remain prohibited.

## Authorities, artifacts and method

- [ADR-010](../../../decisions/010-host-neutral-opt-in-governance.md),
  [gate matrix](../phase0-contract-gates.md),
  [probe threat model](../../../trust-boundaries.md#opencode-v2-phase-02-probe-threat-model-1169).
- Final runs **2026-10-31T11:14:03.993Z** (prevention) and
  **2026-10-31T11:19:05.792Z** (reviewer); Node **22.22.2**, installed
  CLI/server, client and plugin **2.2.4**, macOS. Not Desktop, not an
  interactive human TUI.
- Binary SHA-256:
  `03fc30769f28dd346d2279baae77ef71308175cd49eb7a5be339d3860ee99ec1`.
  [Sanitized facts](./facts.json) bind exact probe-source and private
  raw/report bytes. Digests identify observations, not signed host honesty.
- Official living docs inspected **2026-10-31**:
  [plugin server/sessions/tools](https://opencode.ai/v2/docs/build/plugins/server),
  [client/events](https://opencode.ai/v2/docs/build/client),
  [tools](https://opencode.ai/v2/docs/tools),
  [agents](https://opencode.ai/v2/docs/agents),
  [config](https://opencode.ai/v2/docs/config).
  Installed 2.2.4 behavior and types delimit the tested contract. Living docs
  alone are not version-pinned evidence.
- Deterministic local OpenAI-compatible provider; isolated disposable
  HOME/DB/worktree. The plugin and permission configuration are **test
  instrumentation**. No real provider, operator session, shared service or
  backup was contacted/restored. Raw prompts, paths and request bodies remain
  private.

## Findings

### MCP: advertised-tool denial and executable control

The initial MCP attempts exposed an important readiness issue: without a
catalog warm-up, the model context sometimes did not list the MCP tool, or the
host listed it while rejecting execution with `No tool named ... currently
available`. A warm-up prompt that waits until the session context advertises
`mcprobe_echo` was required. The final runs used **two warm-up prompts** before
the actual call. This is a probe-readiness barrier, not evidence that the host
can be trusted to expose a tool and executor atomically.

Final bounded observation:

| Case                         | Advertised | Tool result                | Marker  | Before/after hook |
| ---------------------------- | ---------- | -------------------------- | ------- | ----------------- |
| Plugin denies `mcprobe_echo` | Yes        | Error `FG_PROBE_DENIED`    | Absent  | before only       |
| Same tool allowed (control)  | Yes        | Completed with `mcp-probe` | Present | before + after    |

The deny occurred before the MCP tool result/marker, and the allowed control
actually executed. **SUPPORTED_BOUNDED:** local advertised MCP tool denial in
this exact fixture. **NOT_VERIFIED:** Code Mode-wrapped MCP, other servers,
resource-only MCP paths, plugin absence/unload, permission interactions,
cross-session invocation, installed FlowGuard policy and universal MCP
prevention. A before-hook throw is not a substitute for an independent host
boundary.

### Hosted/provider-executed actions

- A provider request configured with a visible `web_search` hosted-tool
  definition was rejected by the plugin's final-request hook: denied hook
  observed and **0** provider requests. The control without the definition
  reached the local provider exactly once. This is a bounded **pre-request**
  gate for definitions visible in the final request.
- The recorded Alibaba hosted-tool fixture attempt reached the local provider
  once and produced a terminal mock response, but **no provider-executed tool
  part** and no stable hosted completion. It cannot prove a real hosted action,
  its side effect, or a post-response fence. **NOT_VERIFIED.**
- Source-level `providerExecuted` paths have no local `execute.before` in the
  historical analysis. A provider that autonomously emits an unoffered hosted
  action is not contained by a hook-only design. **Universal preventive
  containment remains NOT_SUPPORTED**; the correct product scope must exclude
  providers/protocols with unpreventable hosted actions or require an explicit,
  tested capability contract.

### Command shell interpolation

An SDK-invoked native file command containing a Markdown shell block executed
`node` to write a timestamp:

- shell write: `11:14:09.998Z`;
- plugin prompt hook: `11:14:10.001Z`;
- delta: **3 ms**, shell **before** prompt admission;
- no `tool.execute.before` and no tool fence.

The plugin prompt hook cannot reject or transform this already-executed host
side effect. This is a concrete gap for any design that treats `/start`/command
admission or prompt hooks as a preventive boundary. It was **not** a real TUI
slash-command test; TUI/Desktop behavior remains NOT_VERIFIED. The command
fixture is not installed into a user project. A command shell block must not be
used for a security-significant operator decision.

### Reviewer chain

The native `subagent` tool created a visible child of the exact parent. The
simple fixture produced one child provider request with session header, model
`probe`, variant `chosen`, and wire `reasoning_effort: high`. The child context
was exactly: reviewed user prompt → assistant `REVIEW_TERMINAL` with
`finish: stop`, no tool parts → succeeded idle. The parent terminal was
`PARENT_REVIEW_DONE`. The request, child, parent tool-call ID and terminal
message were bound together; no latest-message/timestamp heuristic was used.
**This is a bounded positive exact-chain observation.**

Adversarial cases:

1. **Later forged answer:** after the original terminal, the SDK prompted the
   same child with `FORGED_AFTER_TERMINAL`; the host accepted it and produced a
   second assistant answer. A naive "latest assistant" capture would return the
   forged text, while the exact original chain remained bound to the first
   terminal. Exact invocation binding is mandatory; host session reuse must not
   be mistaken for the original response.
2. **Reviewer tool attempt:** the child attempted `probe_echo`; the host/plugin
   denied it before effect, the child nevertheless produced a terminal
   `REVIEW_WITH_TOOL_TERMINAL`, and the parent eventually completed. The child
   had two provider requests, both with effective `high` effort. The adversarial
   provider caused repeated subagent calls; a probe-side loop guard stopped
   parent fan-out after three subagent parts. The earlier unbounded attempt
   remained running at the 8-second wait and produced more than 100 subagent
   tool parts; that raw attempt is retained privately, not treated as a pass.
   The final report records `flowCompleted: true` but
   `cleanReviewEligible: false` because the child attempted a tool. The exact
   review contract must reject tool attempts or prove a genuinely tool-free
   child; a terminal after a denied tool is not automatically clean.

**P0-05 remains NOT_VERIFIED:** no frozen review subject, independent reviewer
identity, installed FlowGuard evidence generation, challenge/findings binding,
post-terminal late-tool negative, Desktop/TUI, or proof that the host rejects
child reuse. The simple chain is a feasibility result, not an accepted review.

## Failed and superseded attempts

Timestamped private directories retain all attempts. Initial MCP calls without
a warm-up did not advertise the tool, and one intermediate run advertised it but
returned `No tool named`; these were not accepted as a prevention result. The
final warm-up made the deny and allow-control results deterministic. One
reviewer attempt without a loop guard produced an unbounded parent fan-out and a
wait timeout; the final run documents the bounded guard and the repeated
subagent parts rather than hiding them. No failed run was relabelled PASS, and no
historical report/evidence bytes were modified.

## Reproduction

From the repository root with Node from `.node-version` and the pinned probe
package installed:

```sh
umask 077
npx vitest run --project scripts scripts/opencode-v2-probe/review-evidence.test.ts scripts/opencode-v2-probe/evidence-binding.test.ts
node scripts/opencode-v2-probe/probes/p0-prevention-surfaces.mjs
node scripts/opencode-v2-probe/probes/p0-reviewer-provenance.mjs
```

Each invocation creates a new timestamped private output directory. Exit 0
means the observation program completed and cleaned up; it is **not** a P0-04
or P0-05 PASS. The MCP readiness warm-up and reviewer loop guard are probe
safety/readiness controls, not product mechanisms. Source-byte regression tests
bind this dated measurement and preserve earlier checkpoint hashes.

## Verification

Local checks on this checkpoint (Node 22.22.2): focused review/scope/binding
tests **25 tests PASS**; `npm run test:scripts` **21 files / 292 tests PASS**;
`npm test` **694 files / 12,400 tests PASS, 2 skipped**;
`npm run test:architecture` **51 files / 538 tests PASS**; repository Markdown
links **4 tests PASS**. `npm run check`, `npm run lint:strict`,
`npm run check:format`, `npm run check:unused-dependencies` and
`npm run check:doc-drift` (including build and 17 doc tests) passed. An initial
full-suite run hit an unrelated pre-existing PERF threshold
(`executeReview < 5ms`, observed 7.9ms); the isolated test passed and a full
rerun passed **694 files / 12,400 tests, 2 skipped** without lowering the
threshold. A full local coverage run passed **694 files / 12,391 tests, 11
skipped** with **83.48% branches** and unchanged 80% thresholds.

The first pushed-SHA GitHub coverage attempt was red on an unrelated
pre-existing concurrency test (`iso27001-java-demo.test.ts`, expected publication
outcomes `[0,1]`, received `[0,0]`). The isolated test passed 10/10 non-instrumented
runs and the full local coverage run passed; the failed CI job was rerun and the
exact SHA then passed. This is recorded as a residual concurrency-test flake, not
as evidence that concurrent publication is safe or stable. Final committed-head
PR/CI verification is reported separately in PR #1190; older green CI is not used
as proof for this change. No product mutation result is claimed here.

## Remaining NO-GO / NOT_VERIFIED

Universal MCP and provider-hosted prevention, real TUI/Desktop command origin,
interactive operator authority, full P0-02-H, independent reviewer identity and
a new evidence generation, installed FlowGuard INACTIVE/ACTIVE, G-04/G-05,
product mutation (`npm run mutation`) and final acceptance against current
`develop`. Production simplification remains a later porting obligation.
PR #1190 remains Draft; Issue #1169 remains In progress.

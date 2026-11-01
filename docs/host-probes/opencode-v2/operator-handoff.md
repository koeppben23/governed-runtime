# Operator handoff: pinned 2.2.4 RPC counterexample

Finding 5, PR #1190, 2026-11-01. **BLOCKED**, not an operator-decision
acceptance. ADR-010 D3 remains unchanged. This report bounds the ordinary
TUI-to-server RPC mechanism; it does not prove that every possible host integration
is impossible. Draft / **ACTIVE V2 NO-GO** remains in force.

## Version-bound source inspection

The inspected upstream tag `v2.2.4` resolves to
[`45898d0f8569225eb1ddb4ee13f8581b34dff311`](https://github.com/anomalyco/opencode/tree/45898d0f8569225eb1ddb4ee13f8581b34dff311).
The installed CLI reports `opencode v2.2.4`; the local client/plugin packages are
2.2.4. Current vendor documentation describes interfaces, not installed proof:
[TUI](https://opencode.ai/v2/docs/build/plugins/cli) and
[RPC](https://opencode.ai/v2/docs/build/plugins/rpc).

At that exact upstream revision:

- `packages/tui/src/context/keymap.tsx:69–76,215–221` routes programmatic
  dispatch through `dispatchCommand()` and passes the command's event into the
  registered callback. Event presence alone is not proof of keyboard input.
- `packages/server/src/handlers/rpc.ts:8–14` forwards RPC ID, method and input;
  it does not pass an attributable UI invocation to the RPC service.
- `packages/core/src/rpc.ts:42–44,108–123` constructs a shared error factory and
  calls the selected handler with parsed caller input and that context.
- `packages/plugin/src/promise/adapter.ts:121–145` constructs the Promise
  handler context with only an execution `signal` and `error` factory. Neither
  identifies whether an HTTP caller was the TUI or an ordinary SDK client.

## Executed installed-host counterexample

The extended existing test in
`src/cli/opencode-authority-primitives.smoke.test.ts` uses the unmodified pinned
host, isolated server/config/data and a real PTY running its TUI. It registers an
**observation-only fixture RPC**, not an activation endpoint or product mandate.

1. Programmatic keymap dispatch, including the text `\x07`, produces the synthetic
   `{ name: "command", ctrl: false, sequence: "" }` event. The fixture's local
   keyboard check does not issue RPC for it.
2. SDK `session.command("authority-probe")` fails with `CommandNotFoundError`;
   a prompt containing the slash command and fabricated event/origin text runs
   natively without invoking the TUI callback or fixture RPC.
3. Actual PTY Ctrl+G produces `{ name: "g", ctrl: true, sequence: "\x07" }`.
   The local callback sends its action/session/event claim to the fixture RPC.
4. The handler observes the input, own context keys `error`/`signal`, an ordinary
   Object prototype, an AbortSignal and a function-valued error factory.
5. An ordinary SDK RPC call sends exactly the same payload twice, without another
   UI action. Both calls produce the identical observed input/context shape;
   no new TUI callback occurs. Serializing `origin: "host-ui"` or the key event
   therefore does not preserve the local source distinction at this boundary.

Reproduction (requires the pinned CLI and Python 3 PTY support):

```sh
OPENCODE_LIVE=1 npx vitest run --project smoke src/cli/opencode-authority-primitives.smoke.test.ts
```

Result: **3 passed, 0 skipped**. This is a mechanism counterexample, not a
Start/Approve/Override/RecoverCapacity/End positive. No product authority is
created, verifier weakened or required product positive replaced.

## Canonical integration points, not alternative authorities

| Operation          | Current owner and missing handoff                                                                                                                                                                                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Start              | `adapters/governance-activation.ts` owns journal commit and its non-serialized authorization port; `machine/governance-activation.ts` owns lifecycle transitions. `integration/opencode-governance.ts` currently authorizes child enrollment, not root UI decisions. Native tool execution requires existing activation/workflow authority before calling hydrate. |
| Hydrate / actor    | `integration/tools/hydrate/hydrate.ts`, `rails/hydrate.ts` and `adapters/actor.ts` own workflow initialization and actor resolution. A source receipt must not bypass these or substitute for policy/actor assurance (`shared/actor-assurance.ts`).                                                                                                                |
| Approve / override | `integration/tools/decision/decision-tool.ts` resolves actor/policy and persists rail/state/audit outcomes. `integration/user-decision-intent.ts` is an in-memory command/verdict intent, not a durable action/worktree/policy/generation-bound UI proof. The native plugin does not register the old command-before callback as operator authority.               |
| RecoverCapacity    | `integration/plugin-beforehooks.ts` contains command-derived capacity release; that callback is not registered as a native UI recovery path. It must not be wired to ordinary SDK command execution. The capacity lock and reviewer recovery checks remain authoritative.                                                                                          |
| End                | The activation writer/machine support ending/inactive journal transitions, but no native UI producer validates safe closure of workflow/reviewer/mutation obligations and submits an authorized root End. `/finish` and `/abort` are not EndGovernance.                                                                                                            |

The missing capability is a demonstrated handoff of an actual attributable UI
decision to these canonical owners, distinguishable there from an SDK invocation.
Ordinary plugin RPC alone is **NOT_SUPPORTED** for that source distinction.
An SDK-accessible registration token, echoed nonce, command string or copied key
event does not repair it. No signing/authentication service, second runtime,
direct host-database writer or duplicated activation authority is introduced as
compensation.

Other host-native handoff possibilities and Desktop behavior remain
**NOT_VERIFIED**. Recovery requires demonstrating an admissible host mechanism
with real UI positives plus SDK/replay/scope/concurrent-use negatives, then wiring
and testing atomic actor/policy/state/audit consumption. Until then only the
affected operator-decision path stays blocked; independent adapter/recovery work
may continue. Findings 2–4/8, 9–11 and the accepted call-ID contract are unchanged.

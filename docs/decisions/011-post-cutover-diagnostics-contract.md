# ADR-011: Post-cutover diagnostics and human-decision UX contract

- **Status:** Accepted as architecture by the operator; portable diagnostic
  export implemented; installed-host and native-UI acceptance **NOT_VERIFIED**
- **Date:** 2026-11-05
- **Deciders:** FlowGuard operator
- **Landing gate:** [PR #1197](https://github.com/koeppben23/governed-runtime/pull/1197)
  remains draft until #1190 is independently accepted; it then retargets to
  `develop`. Merging into the cutover branch before that would expand #1190.
- **Scope:** Post-cutover product work tracked by
  [#1191](https://github.com/koeppben23/governed-runtime/issues/1191) and its
  focused child [#1196](https://github.com/koeppben23/governed-runtime/issues/1196)
- **Subordinate to:** [ADR-010](./010-host-neutral-opt-in-governance.md),
  especially the
  [native command channel amendment](./010-host-neutral-opt-in-governance.md#native-command-channel-amendment-2026-11-03)
- **Related:** [ADR-008](./008-reviewer-authority-boundaries.md),
  [ADR-009](./009-model-neutral-review-transport.md),
  [Phase-0 contract gates](../host-probes/opencode-v2/phase0-contract-gates.md),
  [#1169](https://github.com/koeppben23/governed-runtime/issues/1169)

## Context

FlowGuard's OpenCode V2 cutover is tracked by #1169 and PR #1190. At the time of
this decision, PR #1190 is review-ready but not merge-ready: R4 and installed
Desktop acceptance remain open. This ADR therefore defines a **post-cutover**
contract. It does not expand #1190, does not authorize a partial merge, and does
not convert planned diagnostics or UX into acceptance evidence for the cutover.

The product backlog in #1191 requires operators to understand, navigate and
diagnose successful, blocked, crashed/recovering and terminal workflows. That
requires four things that must not be conflated:

1. Canonical governance state and review evidence.
2. Host-visible session history and observations.
3. A read-only projection that explains both without inventing facts.
4. A separate decision path that can only use existing canonical commands.

The original #1191 body and the initial #1196 body still required a host-UI
interaction that is distinguishable from agent/SDK invocation before native
decision controls could be enabled. ADR-010's 2026-11-03 amendment withdrew that
requirement for OpenCode: a plugin command callback runs identically for UI, SDK
and agent-shell callers. FlowGuard records the channel as `host_command` and
resolves the actor canonically; it must not claim verified human authorship.

This ADR records the consequences of that correction for the post-cutover
diagnostics and UX work, and the additional boundaries required because
"read-only" is not the same as "harmless".

## Decision

### D1. One read-only projection and one diagnostic access boundary

Diagnostics, Markdown output, a future Session Explorer and native Desktop/TUI
surfaces consume **one versioned read-only projection** derived from existing
authorities. There is no second persisted state, dashboard database, event
store, policy evaluator, session registry or review authority.

The diagnostic entry point is deliberately separate from the productive
governance runtime path. The productive path requires a valid ACTIVE scope and
resolvable workflow state; a blocked, crashed or corrupt workflow may have
neither. Diagnostics must still be collectable in those cases.

That exception is limited to **reading and reporting**:

- Diagnostics may read canonical state, review assurance, activation records,
  audit data, host-visible history and diagnostic logs.
- Diagnostics MUST NOT start governance, hydrate, reconcile audit, unlock
  capacity, consume obligations, mutate workflow state or repair host records.
- A diagnostic read never makes a formerly ACTIVE workflow valid, INACTIVE or
  resumable.
- The diagnostic path never becomes an authorization or evidence source.

### D2. Scope authorization and foreign-session exclusion

Read-only access is not an access grant. A diagnostic request is authorized only
for the requested local root/workspace context and for child or continuation
sessions whose relationship is positively established.

- A host `parentID` field alone does not prove FlowGuard enrollment, delegation
  or review binding.
- Reviewer children may be discovered from canonical attempts, dispatches,
  invocations, observations and verified native relationships.
- If a relationship is ambiguous, contradictory or unavailable, the projection
  reports a gap and **does not fetch or merge foreign session content**. The
  candidate remains in the graph as `lineage: not_verified`; its state and host
  transcript are not read.
- A child is read only when its persisted invocation names the requested root
  session as its parent. Attempts or observations without that positive link
  remain `not_verified` rather than being treated as root descendants.
- A corrupt or unavailable governance state may be read and reported as
  **untrusted**. It must not be trusted for further scope expansion or repaired
  by the diagnostic path.
- Capture boundaries are recorded per source and per session, not only as one
  global success flag.

The canonical session authority remains
[`adapters/session-authority.ts`](../../src/adapters/session-authority.ts). A
minimal diagnostic read operation may be added to that owner; no module may
re-derive a session directory from a fingerprint and session ID locally.

### D3. Completeness is explicit and denominator-preserving

Every diagnostic snapshot and every projected view reports capture completeness
as `COMPLETE`, `PARTIAL` or `NOT_VERIFIED`. Completeness is projected on three
independent axes: `lineage`, `canonicalState` and `hostHistory`.

`COMPLETE` means only that all declared sources and known descendants were
captured within the declared boundary. It never means:

- the provider exposed all hidden reasoning;
- every historical session in a worktree was discovered;
- a reviewer outcome is valid;
- governance or evidence is valid.

Known-but-inaccessible children stay in the inventory and in the completeness
denominator. Removing an unreachable known child from the denominator is
forbidden, because it would manufacture apparent completeness. Missing,
stale, duplicate, rejected, exhausted, interrupted and `outcome_unknown`
attempts remain visible as such.

A known reviewer child without its own FlowGuard state is normal in the native
host model, but it is not fully bound canonical state. The manifest therefore
reports `canonicalState: partial` and the overall status cannot be `COMPLETE`
unless the capture contract explicitly records an accepted gap. `COMPLETE`
requires `lineage: complete`, `canonicalState: complete` and, when requested,
`hostHistory: complete`.

### D4. Content, privacy and export integrity

The projection includes, to the extent the host actually exposes them:

- host messages and parts with native message, part and session identities;
- tool invocations, inputs, results, errors and available execution states;
- native timestamps and available model/trace metadata;
- capture paging, compaction, truncation and race boundaries;
- provider-visible reasoning only where the host exposes it. Provider-hidden
  reasoning is never reconstructed or claimed.

Privacy handling is schema-aware, not merely string-based:

- Default exports redact sensitive prompts, tool payloads, credentials, paths
  and personal data where possible.
- Native technical correlation IDs are preserved where they are required for
  lineage. This is not a blanket allow-list for every field ending in `Id`;
  actor identifiers and free-text fields may be personal data.
- Unknown free-text and payload fields are treated conservatively.
- Redaction happens **before** persistent diagnostic output. Raw values are not
  first written to an unprotected intermediate file.
- A raw export requires explicit, informed user action and protected local
  storage. Model-supplied arguments cannot grant that consent.
- There is no automatic upload or telemetry, no raw dump into chat or audit, and
  no claim of complete anonymization.
- File hashes and sizes describe the bytes actually written. Original audit
  verification and the redacted audit projection are reported separately; a
  redacted event must not be presented as an unchanged hash-chain original.
- A JSON export is a diagnostic artifact, not an authorization or evidence
  certificate, and remains separate from the governed `/export`.

### D5. Native decisions use `host_command` and bind the displayed revision

This decision is a direct application of ADR-010's 2026-11-03 amendment.

- Native decisions use channel `host_command` with the actor resolved by the
  canonical actor authority under the frozen policy.
- `host_command` records how a decision arrived. It never proves a human and
  never raises actor assurance.
- Whether a decision satisfies a gate remains a policy and actor-assurance
  decision, not a property of the channel.
- A native control is not disabled merely because physical human presence is
  unattested. It is unavailable when canonical authorization, policy, review
  readiness or safe binding is missing.

A decision requested from a rendered review view carries an **untrusted expected
binding**, at minimum:

- root session and workspace/worktree;
- activation identity and generation;
- policy digest;
- gate phase;
- relevant review obligation;
- subject kind and displayed subject digest.

At the existing canonical decision boundary, immediately before commit, the
runtime re-reads and verifies that binding together with actor, policy, review
and blocker prerequisites. Replay and concurrent use remain enforced by the
existing decision mechanisms.

If the displayed binding and the current binding differ, the action is refused
and the view must be reopened. Presenting revision A and approving revision B
through a stale control is forbidden. If the supported host path cannot carry
the expected binding to that boundary, the view is read-only and offers command
instructions; it must not perform a background approval.

Decision controls use only commands from the canonical directive. Plain
`/approve` is never actionable at an exhausted gate that requires
`/override-approve`, and no UI component invents an actor, rationale, evidence
or audit event.

### D6. Host capability is proven, not inferred; quality gates cover UI code

Native OpenCode GUI and TUI surfaces are optional progressive enhancements. The
portable Markdown/file path remains complete and must not depend on a GUI.

- A documented API is not evidence for the pinned installed build. Desktop,
  CLI/TUI and headless capabilities are probed and reported separately.
- File logging remains the reliable baseline. A configured `ui` mode without an
  active sink must not silently discard diagnostics; the system reports sink
  availability and delivery failure.
- Toasts and notifications are redacted, deduplicated, rate-limited and linked
  to the exact diagnostic context. They never approve, mutate state or become
  evidence.
- Before production GUI/TUI `.tsx` code is added, TypeScript, ESLint, Prettier,
  coverage, architecture, placement and file-size checks must include `.tsx`.
  Otherwise a new production surface would silently escape existing guards.
- Install, ownership, packaging and uninstall must prove which native parts are
  actually loaded. A successful registration call is not proof that a user saw
  a panel or a warning.

### D7. Ownership between #1191 and #1196

| Owner      | Responsibility                                                                                                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#1191**  | Shared diagnostic/presentation projection, `/debug-export`, Session Explorer, doctor diagnostics, blocker/recovery details, log viewer, review-view content and notifications      |
| **#1196**  | `/start` chooser, specialized Next Action projection over existing directives, and native Desktop/TUI interaction surfaces derived from the shared projection                      |
| **Shared** | Canonical command/session/decision authorities, binding rules, freshness/completeness semantics, privacy rules and installed-host verification. No second Next Action or registry. |

#1191 may provide the projection type and contract. #1196 implements the
interaction surfaces and chooser. Neither issue may introduce a rival command
catalogue or persisted view state.

## Implementation status (2026-11-06)

Implemented in this repository state:

- `flowguard debug-export` and native `/debug-export` produce a bounded,
  write-once snapshot of the root session and known reviewer children.
- Root and child resolution uses the canonical session authority. A known child
  that cannot be resolved remains in the graph and completeness denominator.
- A child is read only after its invocation positively names the requested root.
  Foreign or unlinked candidates remain `lineage: not_verified` and are not
  fetched; the manifest reports `PARTIAL`.
- The snapshot verifies the canonical audit chain, preserves native session,
  message and part IDs, captures optional host transcripts through the installed
  OpenCode CLI or the native plugin context, and redacts before persistence.
- The manifest records per-file SHA-256/size, capture boundaries, redaction mode,
  per-axis completeness (`lineage`, `canonicalState`, `hostHistory`) and explicit
  `COMPLETE`/`PARTIAL`/`NOT_VERIFIED` status.
- Per-artifact and total byte budgets, a per-session host timeout and a total
  capture duration are enforced. Oversized artifacts are skipped with an explicit
  `ARTIFACT_TOO_LARGE`/`AUDIT_TOO_LARGE`/`HOST_HISTORY_TOO_LARGE` warning and
  `PARTIAL`, never silently truncated. The manifest itself is bounded by the
  per-file budget.
- The diagnostic entry works before ACTIVE governance and never starts,
  hydrates, reconciles, approves or repairs.
- Doctor reports the native diagnostic command as available in this build and
  explicitly keeps native Desktop delivery `NOT_VERIFIED`; it does not execute
  the command.
- Native `/diagnostics` provides the portable post-cutover views tracked by
  #1202: `explorer` projects exact known lineage and explicit `not_verified`
  gaps with obligation/attempt/dispatch/invocation IDs; `review` displays the
  exact subject revision/digest, verbatim material, reviewer verdict, findings
  and ProofGraph declarations versus evaluation while declaring decision
  authority `NOT GRANTED`. Only reviewer output positively bound to the displayed
  revision is used as the current verdict; stale or unassigned output, including
  an implementation-review loop whose `currDigest` differs from the displayed
  implementation digest, remains visible as historical material. `logs` reads a
  bounded tail of the existing
  JSONL sink with level/session/trace/time filters, sensitive-field masking and
  explicit truncation, malformed-line and missing-correlation states;
  `notifications` reports unsupported
  delivery and keeps file logs as the complete fallback. The command writes no
  artifact and creates no second store, logger or authority.
- Cross-surface tests keep the exported `session-graph.json`, the explorer
  projection and the rendered Markdown facts aligned.
- The optional TUI companion now provides the #1196 workflow chooser. It reads a
  read-only `GetNextAction` RPC projection with session, phase, policy,
  state-digest and canonical activation identity/generation binding, opens the
  canonical three-choice dialog, cancels without executing anything, re-reads
  state and re-checks the active session before requesting the selected
  command, and rejects late dialog results after plugin unload. An installed
  pinned-host PTY proof covers open, cancel without transition, `/task`
  selection through `session.command`, and the canonical READY → TICKET
  transition. It handles only `CHOOSE_FLOW`; native approval/override decisions
  and persistent status remain separate. Desktop GUI delivery remains
  `NOT_VERIFIED` without an installed proof.

Still not implemented or not verified:

- Revision-bound native approval/override controls and persistent Next Action
  status (owned by the remaining #1196 slices).
- Installed Desktop GUI panel visibility and notification delivery.
- Calibration of the default byte/time budgets against representative large
  workflows.
- Complete PII detection coverage.

Focused verification for this slice is recorded in the owning PR. It does not
constitute installed Desktop acceptance or cutover approval.

## Options considered

1. **Extend the cutover PR with diagnostics and GUI work.** Rejected: it expands
   an unfinished high-risk migration and conflates cutover acceptance with
   post-cutover product UX.
2. **Build a separate dashboard backend or read model.** Rejected: it creates a
   second authority, stale projection and a new persistence surface.
3. **One read-only projection over existing authorities, delivered after the
   cutover in separate PRs.** Chosen.

## Consequences

- The first deliverable after cutover is the diagnostic access boundary and
  projection, followed by `/debug-export`; UI surfaces come later and consume
  the same data.
- Diagnostics can support incident recovery without becoming a recovery tool.
- Honest partial results require more explicit schema fields and tests than a
  best-effort export, but they prevent false `COMPLETE` and false lineage.
- Revision-bound decisions add a server-side precommit check; hosts that cannot
  carry the binding degrade to read-only rather than to an invented approval
  channel.
- Desktop UX may remain unsupported on a pinned host. That is an acceptable,
  documented outcome; a fake GUI success is not.
- Cutover, R4, installed Desktop acceptance and final merge remain governed by
  #1169/#1190 and are not satisfied by this ADR.

## Delivery sequence

1. **AP0:** Align #1191/#1196 with ADR-010; accept the cutover.
2. **AP1–AP2:** Diagnostic access boundary, canonical projection and doctor
   extensions.
3. **AP3–AP4:** `/debug-export` and privacy controls, accepted together.
4. **AP5:** Native packaging and complete TSX quality gates.
5. **AP6:** Session Explorer, blockers, log viewer and shared projection.
6. **#1196:** `/start` chooser and persistent Next Action.
7. **AP7:** Revision-bound review UI and installed Desktop notifications.

## Non-goals

- No new runtime, sandbox, dashboard database, event store, identity service or
  review authority.
- No V1 compatibility path.
- No expansion of PR #1190 or reinterpretation of R4.
- No provider-reasoning reconstruction.
- No raw diagnostic upload or chat dump.
- No UI-generated approval, evidence, provenance or human-attestation claim.
- No claim of supported Desktop UX without an installed, pinned-host proof.

## Open and unverified items

At decision time the following remain **NOT_VERIFIED** and must not be presented
as product facts:

- Completion and acceptance of the V2 cutover, R4 resolution and installed
  Desktop acceptance.
- Actual GUI/TUI capability of the pinned OpenCode build, including notification
  delivery and panel visibility.
- Whether the supported host command path can transport the expected decision
  binding; if not, native approval controls remain read-only.
- Exact capture limits for sessions, bytes, time and concurrency; these are
  calibrated against representative large workflows.
- Complete PII detection coverage; redaction limitations are reported.

## Acceptance contract

- [ ] Diagnostic capture leaves phase, obligations, locks, approval and audit
      authority unchanged; no implicit start or hydration.
- [ ] Known-but-unreachable children remain in the manifest and prevent
      `COMPLETE`; foreign or ambiguous sessions are never merged.
- [ ] A child whose invocation names another root is not read; the graph keeps it
      as `lineage: not_verified` and the manifest is not `COMPLETE`.
- [ ] A host-only reviewer child reports `canonicalState: partial`, even when its
      host transcript is complete.
- [ ] Oversized host transcripts, audit trails, artifacts and total captures
      produce explicit warnings and `PARTIAL`, not silent truncation.
- [ ] Partial failure yields a truthful partial artifact with actionable
      diagnostics, not apparent success.
- [ ] Redacted default output contains no injected secrets or personal data and
      preserves the technical IDs needed for exact lineage.
- [ ] Native decisions use `host_command`, canonical actor/policy checks and the
      server-side binding check; a stale view cannot approve a changed revision.
- [ ] Decision availability matches canonical directives across ordinary,
      exhausted, blocked, stale, ACTIVE/INACTIVE and terminal cases.
- [ ] File logging remains the fallback when UI delivery is unsupported; no
      silent diagnostic loss is reported as success.
- [ ] Installed Desktop and CLI/TUI behavior are verified separately, with exact
      package, host, surface and artifact identities.
- [ ] No diagnostic or presentation component is treated as governance evidence.

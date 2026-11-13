# FlowGuard Desktop UX — first native product slice (#1196)

> **Post-merge status:** PR #1207 is merged into `develop`. This document
> preserves the historical implementation and acceptance narrative; references
> below to "Draft PR #1207" describe the state at the time of the recorded
> evidence. The GUI artifact acceptance remains bound to the recorded bundle
> hash; independent screenreader, zero-restart and live-profile uninstall gates
> remain open.

<!-- prettier-ignore-start -->

**Status:** Implemented native Review Workbench, compact disclosure, reviewer timeline/ProofGraph, Session Explorer/audit chronology, and the read-only chat/composer status surface; installed-verified on Desktop 2.2.6 artifact `f9c53e8f` (GUI bundle `bb8c8cd2…b06ff81e`). VoiceOver, zero-restart and live-profile uninstall acceptance remain open.  
**Capability probe:** Panel + `session.header` Slot `PASS` on installed OpenCode Desktop 2.2.6 (2026-11-07); pinned 2.2.5 remains `NOT_VERIFIED`.  
**Primary target:** OpenCode Desktop 2.2.6 (installed native UI required); 2.2.5 remains NOT_VERIFIED.  
**Related:** #1196, #1203 diagnostics, #1204 portable chooser, #1205 TUI chooser, #1206 native decisions/Desktop chooser, ADR-011  
**Contract owner:** existing FlowGuard governance and diagnostic projections; no UI authorization

## Continued hardening after installed artifact e054159a (2026-11-07)

**Status: installed Desktop 2.2.6 acceptance PASS for artifact `2651c0cb` on
the optional current-session completion refresh. The autonomous-Start transcript
removal is verified by code plus product-composition regression (no installed
autonomous Start was run because it would mutate governance).** The older
bundle acceptance remains valid only for its own artifact. Zero-restart
installer proof, active-profile uninstall and independent screenreader coverage
remain open.

1. Autonomous `StartGovernance` now returns its existing authoritative RPC
   result without a `session.synthetic` transcript message. Audit confirmation,
   actor assurance, activation revision and `GetNextAction` remain unchanged;
   native host-command `/start` still publishes its existing report.
   A product-composition regression checks first and repeated autonomous
   Start create neither `prompt` nor `synthetic` messages.
2. The composer pill optionally subscribes to the sidecar
   `session.execution.succeeded` event with `createKeyed` and cleanup. A
   completion for the **current session only** triggers the same read-only RPC
   projection as manual Refresh. Each request has a generation fence; older
   responses cannot overwrite newer results. Missing event support, disconnects
   and missed events retain the explicit Refresh fallback. Installed Desktop
   2.2.6 exposes the endpoint lookup as `ctx.servers`; newer plugin typings name
   it `ctx.serverEndpoints`. The bundle prefers the documented name when
   present and falls back to the running host surface. Acceptance on artifact
   `2651c0cb` observed a disposable session change from `FlowGuard · inspect`
   to `FlowGuard · NOT_VERIFIED · last read` after its execution succeeded,
   without a user click, while a completion in another session left the open
   demo pill at `FlowGuard · inspect`. The fixture was deleted; the demo
   session stayed unchanged.
3. The existing title/rows provide the host-native accessible name and
   keyboard interaction. **Independent screenreader testing remains pending.**
   Required installed tests: VoiceOver on macOS and, if supported, a second
   screenreader; focus order, name/role/value, live updates, stale and blocked
   verbalization, keyboard-only menu use, and reduced-motion/zoom behavior.
4. Installer host lifecycle is deliberately **not relaxed** when launched
   inside the managed service. Byte-exact artifact write and hot reload do
   not prove a clean post-install restart; `--no-restart-host` plus an
   out-of-process verification/restart is the non-destructive operator path.
   The active-profile uninstall remains PARTIAL; no destructive uninstall was
   attempted against the live demo. A disposable ownership-matched fixture,
   followed by an isolated running-host unload/reload proof, is required
   before changing that status.

No claim of completed #1196 automatic updates across *all* governance
transitions is made. The completion event is an incremental read-only signal,
not a guaranteed durable subscription or an audit feed. The plugin never
interprets missing events as approval.

## Remaining gates continuation — bounded reconciliation and accessibility

This PR extends the optional, read-only status path beyond
`session.execution.succeeded`: after the composer pill has been rendered,
a 30-second reconciler refreshes **only the visible current sidecar session**.
It skips hidden windows, does not query at registration or first render and
cleans up on GUI unload. Events and timer ticks are serialized and coalesced
so a slow server cannot accumulate unbounded concurrent reads.

The OpenCode SDK states that live RPC/event subscriptions do not replay
missed notifications. Thus a 30-second reconciler is **best-effort eventual
visibility while the GUI is visible and connected**, not an audit feed or a
hard latency guarantee for every governance transition. Missing data remains
`NOT_VERIFIED`; no state, decision or audit mutation is introduced.

Chat cards and the Workbench now expose named regions with polite, atomic
status announcements. Installed Desktop 2.2.6 acceptance on artifact
`f9c53e8f` confirms the visible-session 30-second reconciliation, the retained
completion fast path, the ARIA region/live semantics and no governance
mutation. This remains **static accessibility hardening**, not
VoiceOver/screenreader acceptance; VoiceOver is still `NOT_VERIFIED`.

The native isolated uninstall E2E pins the same live host PID and an unaffected
observer plugin. It passed 1/1 against the exact packed artifact with the
repository-pinned native CLI candidate `2.2.5`; a one-off rerun with the
installed Desktop `2.2.6` CLI (temporary candidate-version override, restored
afterwards) also passed 1/1. The recorded installed evidence remains
version-bound to the `2.2.5` run. The repository's current native API baseline
is `2.2.7`, but the independently verified host smoke pin remains `2.2.5`; the
API baseline update does not extend this installed evidence. The real active
profile was not uninstalled. Zero-restart upgrade still requires an external
revision-A-to-B runtime fingerprint proof; the installer self-restart guard
remains untouched.

The full evidence checklist and negative test matrix are maintained in
[Desktop remaining gates](../host-probes/opencode-v2/desktop-2.2.6-remaining-gates.md).
The installed GUI evidence applies only to bundle `bb8c8cd2…b06ff81e`.

## Desktop host and RPC adapter isolation (PR #1207)

The Desktop view code now depends on two local semantic bridges rather than
reaching into OpenCode compatibility details or spelling RPC method strings:

- `gui-host-bridge-bundle.ts` owns the installed 2.2.6 `ctx.servers`
  compatibility fallback for the typed `ctx.serverEndpoints` API, the
  sidecar `session.execution.succeeded` filter and reactive cleanup.
  Other UI components request `subscribeFlowGuardSessionCompletion`.
- `gui-rpc-client-bundle.ts` owns the RPC identifier, native
  `rpc.call` envelope and four canonical methods. Its exported
  TypeScript `FlowGuardGuiRpcClient` port is owned by
  `src/integration/gui-rpc-client-contract.ts` and reuses canonical
  RPC input/output types. No `templates -> integration` dependency exists. Presentation code calls `getNextAction`,
  `getWorkbenchReview`, `getWorkbenchDiagnostics`, or
  `submitDecision` without knowing RPC transport names.
- `submitDecision` always injects the mounted session ID after the
  caller's fields. This is transport session binding only, **not** new
  decision authority. Server-side revision, actor and policy checks remain
  mandatory and unchanged.

This is a source-layer split inside the single installed Desktop plugin,
**not** an independently deployable UI package or host-neutral implementation
of other GUI targets. Contract/unit tests are required for the adapters.
The changed GUI bundle has installed Desktop 2.2.6 acceptance on artifact
`e8e1e90d`: the Workbench read the canonical review, timeline and diagnostics
through the typed client; the pill refreshed manually at EVIDENCE_REVIEW; a
disposable session auto-refreshed from `FlowGuard · inspect` to
`FlowGuard · NOT_VERIFIED · last read` after completion; its
`flowguard-live` `v1` assistant block rendered the live card; and the
canonical decision chooser opened with `/approve`, `/request-changes`,
`/reject` and was dismissed with Escape. Earlier screenshots remain valid only
for their own artifacts.

## Inline chat and composer status — optional Desktop extension (PR #1207)

The official OpenCode V2 GUI SDK documents the `CodeBlock` registry
for explicitly authored Markdown blocks and `ComposerPill` immediately
above the session composer. The latter is **not** part of the model transcript.
Both surfaces are installed-verified on Desktop 2.2.6 artifact `e054159a`
(see the [acceptance record](../host-probes/opencode-v2/desktop-2.2.6-workbench-acceptance.md#inline-chat-and-composer-status--pr-1207-continuation)).

- The palette action **FlowGuard: inspect status beside chat** (`flowguard-inline`)
  refreshes one session-bound status pill by calling the existing read-only
  `GetNextAction` and, for review gates, `GetWorkbenchReview` RPCs.
- The pill also exposes **Inspect/Refresh canonical status**. Nothing is
  fetched on plugin registration. User action or an observed current-session
  execution-completed event performs the RPC reads.
- No synthetic message is inserted. An earlier prototype used
  `session.synthetic({ resume: false })`, but that could introduce
  otherwise non-authoritative UI notices into future model context.
  **That implementation has been removed.**
- The optional `CodeBlock` renderer recognizes the exact
  `flowguard-live` fence with payload `v1` only. It renders an existing
  message if one contains that marker; it never creates or posts a message.
- These presentations are **live, read-only diagnostic views**, not historical
  review snapshots, and never authorize decisions. Review digest/phase
  consistency is re-read; missing or stale data fails closed.
- No automatic host-command execution, decision RPC, hydration or audit write
  occurs from the pill or block. Existing `/status` portable fallback remains.
- Unsupported GUI contributions must degrade without disabling other parts of
  FlowGuard. TUI/headless and existing command templates are unchanged.
- Installed Desktop 2.2.6 acceptance on artifact `e054159a` covers actual pill
  placement above the composer, manual refresh at EVIDENCE_REVIEW, phase changes
  to READY and PLAN, session switching, renderer reload, light/dark, keyboard
  opening/closing, a rendered `flowguard-live` `v1` card and `v2` fallback, and
  the absence of prompt, workflow, decision, hydrate or audit mutation. A
  mid-read phase race (`STALE`) was not induced live; bundled tests cover the
  fail-closed path. No separate screenreader session was available.
- The separate autonomous `StartGovernance` synthetic report was removed in
  artifact `2651c0cb`; that path now returns only its authoritative RPC result.
  The interactive `/start` report is unchanged. See the hardening section
  above.

Official SDK: https://opencode.ai/v2/docs/build/plugins/gui/

## Same-PR delivery amendment (2026-11-07)

The user explicitly chose to retain the remaining native Desktop product-UX work
on the existing **Draft PR #1207**, instead of splitting it after the first
installed proof. The earlier “PR Design-0 / Proof-1 / Slice-2” progression below
is a logical validation sequence, **not** a requirement to open separate PRs.

The prior GUI bundle was installed-verified on Desktop 2.2.6 for READY,
PLAN_REVIEW (including canonical decision and stale rejection), EVIDENCE_REVIEW,
BLOCKED diagnostics, keyboard and light/dark. The newer **compact progressive-
disclosure UI** is implemented on #1207 but has **no installed PASS yet**.
The previous evidence and SHA remain historical and cannot be attributed to the
newer bundle. Keep #1207 Draft until the updated installed UX and tests pass.

Further visual product work such as evidence drill-down, timeline, session
context and usability measurements will use #1207 too; each new UI build
requires version-bound evidence and preservation of the canonical safety path.

## Native Session Explorer + audit chronology continuation

The same Draft PR #1207 now implements a read-only native session lineage
view and verified audit-chain chronology composed from the canonical Explorer
and audit verifier. Installed Desktop acceptance is pending for this artifact;
previous GUI evidence does not authorize promotion. This is not a host
transcript replay or causal proof; missing/invalid/large audits remain
NOT_VERIFIED or invalid.

## Product decision

The deliverable is a coherent, genuinely usable **native desktop product experience**: orientation → a review workbench → an authorized decision **or** guided recovery. An architecture-only PR, command palette, markdown transcript, screenshots of mocks or test-stubbed UI cannot satisfy #1196's first product milestone.

The interface is _host-native_, not a custom skin of the complete OpenCode application. OpenCode-specific components are adapters over existing canonical view and interaction semantics. TUI remains tailored to terminal capabilities. Cursor and VS Code will initially be read-only and must be verified separately. Never infer enforcement support from extension API compatibility.

## Verified starting point and unknowns

<!-- prettier-ignore -->
| Surface / mechanism                                | Evidence in repository                                                        | First-slice implication                                                |
| -------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Portable /start, /status, /why, /help, /finish     | Canonical workflow choice and status projections (PR #1204)                   | Mandatory semantic fallback                                            |
| OpenCode TUI chooser                               | Installed PTY integration with READY→TICKET (PR #1205)                        | Preserve as independent surface                                        |
| Native review decisions                            | GetNextAction + DecisionBinding + SubmitDecision; server re-checks (PR #1206) | Reuse; never implement a UI decision engine                            |
| OpenCode Desktop on-demand chooser                 | Installed GUI bundle; operator-reported visual flow after #1206               | Baseline interaction exists; archive version + package hash separately |
| Persistent Desktop Next Action                     | No `session.header` registration in #1206 bundle                              | **NOT_IMPLEMENTED**, not a shipped feature                             |
| TUI permanent status slot                          | Earlier pinned probe reports NOT_SUPPORTED                                    | Maintain alternative entrypoint                                        |
| Native Desktop panel/slot/route for full workbench | Installed 2.2.6 probe: Panel + header Slot paint, manual refresh and session switch; pinned 2.2.5 not tested | **PARTIAL**: host capability proven on 2.2.6; full workbench remains pending |
| Review/diagnostics/session/proof views             | Existing ADR-011 diagnostic projections                                       | Compose; no new review/ProofGraph authority                            |

Do not confuse an observed Desktop chooser with a proven persistent Desktop panel. `GetNextAction.actions[].visibility` indicates presentation priority, **not** executable eligibility.

## Product journeys — executable screen flows

### Journey 1: Choose work from READY

1. Session enters ACTIVE / READY with team policy; FlowGuard is passive until explicitly opened.
2. User can discover FlowGuard's compact orientation without memorizing a command where a verified host slot is available; otherwise use the installed on-demand command/panel entry and portable fallback.
3. Orientation shows: session, governance state, **READY**, short message “Choose a workflow”, and exactly the canonical `/task`, `/architecture`, `/review` choices with `/task` recommended. Neither highlighted nor recommended means selected or dispatched.
4. User selects `/task`; prompt for task text or file; cancel leaves READY, submit uses the existing host command. After actual state transition the next action becomes `/plan`.
5. A reload, stale activation or session switch must close or invalidate the interaction and never start work in a different session.

### Journey 2: Review a frozen subject and decide

1. Entry opens a **single Review Workbench** rather than independent status/findings/approval popups.
2. Top-level subject region displays exact subject kind, revision/digest, active review gate, and revision-freshness indicator; reviewer verdict/evidence is a separate region.
3. Reviewer result is clearly labeled **independent review**; it is **not** operator approval.
4. Decision region lists only the actions of the canonical directive, and only enables a native action if a valid decision binding and supported host carrier exist. Gate-specific recovery and missing evidence remain visible.
5. Select a decision; on fresh server-side binding perform `SubmitDecision` through the existing host-command authority. On stale/binding mismatch, show “The reviewed version changed — reopen the review” and record no decision.
6. At exhausted gates offer `/override-approve` only when canonical rules permit; request and persist non-empty rationale via the existing authority.

### Journey 3: Understand and resolve a blocker

1. Compact orientation announces **BLOCKED** with a plain-language cause, not only a reason code.
2. Expanded recovery view states impact (“What cannot proceed”), legitimate next action and link to underlying evidence.
3. Drill-down exposes canonical reason code, obligation, activation/session and audit details without making them mandatory for routine users.
4. For outcome_unknown/mutation ambiguity or incomplete reviewer evidence, **do not** offer “Fix automatically”, bypass or speculative safe-action buttons.
5. Recovery action (where authorized) must always use canonical command/authority; when not possible the UI is read-only with exact instructions.

### Journey 4: Inspect without deciding

1. Read-only timeline displays real phase transitions, reviewer cycles, attempts and outcome_unknown/stale markers; no fabricated progress percentage.
2. Evidence/ProofGraph displays claim → check → evidence → status and distinguishes VERIFIED, MISSING, NOT_VERIFIED and unavailable.
3. Session navigator shows the root, verified reviewer descendants with generation, and worktree context, marking incomplete or conflicting lineage as incomplete. Switching sessions invalidates open decision views.
4. Detail drill-down is available without a mutation, audit append or implicit hydration.

## Information architecture

```text
[ FlowGuard orientation — compact, per visible session ]
  current governance / phase / work / one next action or blocker
                  |
      Open FlowGuard details
                  |
  +---------------------------------------------+
  | FlowGuard Workbench                         |
  |  Header: session · phase · canonical status |
  |  Subject: exact revision/digest              |
  |  Review: reviewer verdict · findings         |
  |  Evidence: completeness · critical claims   |
  |  Decision: eligible actions or safe guidance |
  +---------------------------------------------+
        |             |              |
    Recovery       Timeline     Forensic detail
```

The compact orientation should be one small host-native surface **only if that slot visibly renders in the pinned Desktop**. Otherwise the same opening context belongs in a discoverable, nonpersistent native workbench entry. A modal chooser alone is not the complete product requirement.

### Progressive disclosure

<!-- prettier-ignore -->
| Level    | What is visible                                                                                                              | Explicitly not shown by default            |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Compact  | Root/session shorthand; ACTIVE/INACTIVE; phase; current work; one next action or main blocker                                | Audit IDs, digests, raw JSON               |
| Expanded | Subject version; review outcome; findings counts; missing verification; safe choices and recovery                            | Full event payloads and verbose internals  |
| Forensic | Full subject binding; activation ID/generation; policy/state digests; attempts; audit chain; session lineage; log references | Never hide uncertainty or incomplete paths |

### Screen-state inventory

<!-- prettier-ignore -->
| State                                       | Heading / primary content                                            | Primary available interaction                   | Failure/edge behavior                            |
| ------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------ |
| READY                                       | “Choose a workflow”; three exact choices                             | Explicit `/task`, `/architecture` or `/review`  | Cancel → no transition                           |
| TICKET                                      | “Task captured”; bound ticket digest                                 | Canonical `/plan`                               | Display captured subject/revision                |
| PLAN_REVIEW / ARCH_REVIEW / EVIDENCE_REVIEW | “Decision required”; exact reviewed subject and independent findings | Bound `SubmitDecision` only where authorized    | Stale subject blocks; review ACCEPT not approval |
| REVIEW_PENDING or other system work         | “Review in progress”; no premature decision buttons                  | Inspect details/status                          | No fake approval or progress                     |
| BLOCKED / RECOVERY                          | “Action blocked”; impact and canonical recovery                      | Only actual safe action / read-only instruction | outcome_unknown not auto-resolved                |
| TERMINAL                                    | “Workflow complete”; actual evidence/readiness                       | View/export if canonically allowed              | No next-step mutation inventing                  |
| INACTIVE                                    | “FlowGuard not active”                                               | `/start` by explicit user                       | Read-only view never hydrates                    |
| EMPTY / LOADING                             | Clear asynchronous state                                             | Cancel/back                                     | No ghost action while loading                    |
| STALE                                       | “State changed”; refresh/open again                                  | Refresh                                         | Disable previous action immediately              |
| DISCONNECTED / DENIED                       | Reason + next safe diagnostic step                                   | Retry/read-only                                 | No optimistic success                            |
| EVIDENCE INCOMPLETE                         | Coverage/verification missing marker                                 | Inspect missing claims                          | No green approved indicator                      |

## Native design language — implementation guidance

- **Visual hierarchy:** one-line current status, strong review subject title, smaller supporting metadata and a single primary action area. Do not duplicate large Markdown transcript content.
- **Density:** compact by default; expanded panels reveal details progressively. Normal and narrow desktop widths must avoid clipping action labels; long findings wrap/truncate only with full-title access.
- **Typography:** native host scale and font stack. Use tabular numerals for version, count and timing metadata; monospace only for command, digest and identifier snippets.
- **Color & icon semantics:** normal/system/blocked/success/unknown distinctions use text plus icon, never color alone. Honor host dark/light palette and contrast; do not hardcode decorative green for all “ACTIVE” claims.
- **Copy:** action-oriented and precise. Differentiate “Review accepted”, “Operator approved”, “Waiting for evidence” and “Operation requested” from durable completion.
- **Interaction:** keyboard-first focus order: context → review subject → findings → safe actions → details. Escape closes dialog without state mutation; back preserves session scope; reload/dispose invalidates pending controls.
- **Async:** loading skeleton or text, stale refresh, disconnected state and explicit unavailable evidence, all from live canonical snapshots, not cached permanent UI state.
- **Notifications:** only decision-needed or new blocker updates, deduplicated and redacted; no toast-as-evidence or unsolicited modal.
- **Privacy:** redact private workspace paths, token contents and sensitive fields before any exported screenshots and logs.

## Capability proof plan (before choosing the renderer)

Run on the _actually installed_ OpenCode Desktop build and exact packaged FlowGuard artifact. Record host version/OS, artifact and wrapper SHA-256, setup registration, visible UI, session switch, cleanup/unload, and package checksum.

<!-- prettier-ignore -->
| Candidate                              | Required proof                                                                                        | If unavailable                                                                                         |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `session.header` / compact status slot | Visible compact state; updates after READY→TICKET; different session shows different data             | Mark NOT_SUPPORTED/NOT_VERIFIED; use native on-demand workbench and Markdown                           |
| Native Session Panel / named route     | Real rendered workbench; keyboard focus; normal/narrow layout; open/close/reload                      | Identify supported host route or downgrade scope explicitly; **cannot** close #1196 on chooser-only UX |
| Review decision control                | Displayed exact frozen subject, `SubmitDecision` stale/duplicate rejection, no action on cancellation | Read-only decision guidance with canonical commands                                                    |
| Host theme and accessibility APIs      | Light/dark and keyboard interaction visible and observable in installed app                           | Preserve host-native styles, report unsupported functionality                                          |
| TUI equivalent                         | Independent installed proof; no assumption that GUI controls work in TUI                              | Preserve the TUI chooser / portable fallback                                                           |

Installed tests must include **actual visibility and interaction**, not merely an exported SDK type, successful CJS evaluation or a stubbed `ctx.add`.

## Minimum vertical-slice PR plan

**PR Design-0 (this document):** host-capability-backed information architecture, screen-state inventory, actual task flows, responsive/theming/accessibility expectations and acceptance matrix. No runtime changes; not a product milestone and not a merge-blocker for already-merged #1206.

**PR Proof-1:** small, *optional*, pinned installed Desktop capability probe for a genuine panel/route and compact slot. Include observed screenshots/logs and honest PASS / NOT_SUPPORTED / NOT_VERIFIED per slot. Do not implement a new status backend here.

**PR Slice-2:** one real native Desktop UX, from compact/open entry to review workbench and guided blocker recovery, composing existing canonical projections. Extract only shared view contracts needed for this slice; do not fork governance state. Secure decisions reuse `SubmitDecision` and expected binding.

**PR Drilldown-3:** audit/timeline, ProofGraph/evidence, and session context navigation in same workbench, using existing diagnostics. Preserve available/unknown denominators.

**PR Host-4:** Cursor and VS Code read-only renderers of the same versioned snapshot, individually installed/verified. Separate runtime enforcement from display.

**PR Quality-5:** task-based usability/visual/accessibility/recovery checks against prior slash-command experience, independent governance-security approval and host lifecycle acceptance.

## Acceptance and falsification matrix

### Technical / governance
- [ ] No duplicated state machine, policy evaluator, review authorization, evidence store or audit writer.
- [ ] Read-only requests do not activate, hydrate or mutate a workflow or append audit.
- [ ] Displayed subject and bound decision match; tampered, replayed, double-click, wrong-root/session/worktree, changed activation/policy/subject and disposed UI cannot execute.
- [ ] Autonomous workflows do not acquire new human modal requirements.
- [ ] Downgraded/unsupported host capabilities are explicitly labeled and preserve usable portable fallback.

### Visual / interactive
- [ ] Installed Desktop build visibly renders the compact/expanded/forensic experience; include normal and narrow layouts, dark/light and empty/loading/stale/denied cases.
- [ ] Native keyboard operation and Escape/back work without unwanted transitions; focus is visible and safe after closing.
- [ ] Findings and actions are readable without clipped content; review result is not visually confused with approval.
- [ ] No screenshot-only proof: exact same artifact can be installed, updated, unloaded and uninstalled.

### Usability — thresholds must be frozen before trials
- [ ] First-time user can locate the current next action, reviewed revision, independent reviewer result vs approval, and safe blocker recovery.
- [ ] Compare identical tasks against the baseline slash-command/Markdown interface. Measure success/failure, wrong decisions, time-to-action, interruptions and revision recognition.
- [ ] Document participant count, task fixtures, decision thresholds and results before claiming improvement; no invented UX performance benefit.

## Out of scope for this design PR

Implementation of any unverified native extension API, an OpenCode fork, synthetic persisted Next Action, an independent authorization engine, mock screenshots presented as proof, full client-side replacement UI, a Cursor governance adapter, and any change to active PR #1206.

<!-- prettier-ignore-end -->

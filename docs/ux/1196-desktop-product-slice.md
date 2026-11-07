# FlowGuard Desktop UX — first native product slice (#1196)

**Status:** DESIGN BASELINE / IMPLEMENTATION NOT YET VERIFIED  
**Primary target:** OpenCode Desktop 2.2.5 (installed production UI required)  
**Related:** #1196, #1203 diagnostics, #1204 portable chooser, #1205 TUI chooser, #1206 native decisions/Desktop chooser, ADR-011  
**Contract owner:** existing FlowGuard governance and diagnostic projections; no UI authorization

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
| Native Desktop panel/slot/route for full workbench | Extension API descriptions only, no pinned visible proof yet                  | **NOT_VERIFIED**: first concrete host-capability probe                 |
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
3. Session navigator shows root, reviewer children and worktree context, marking incomplete lineage as incomplete. Switching sessions invalidates open decision views.
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

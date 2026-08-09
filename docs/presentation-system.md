# FlowGuard Presentation System

Canonical Markdown presentation language for all FlowGuard user-facing output.
Every consumer that renders FlowGuard status, cards, plans, or diagnostics MUST
comply with this contract. FlowGuard controls Markdown content and structure;
OpenCode controls fonts, colors, themes, native cards, and application chrome.

## 1. Result Forms

Every visible FlowGuard result has one semantic form and exactly one visible
closing block. The closing block is either the renderer-owned conclusion or,
when no presentation payload exists, the command template's canonical fallback.
They MUST NOT both be displayed.

| Form           | Required information order                              | Closing block              |
| -------------- | ------------------------------------------------------- | -------------------------- |
| Success        | Status or outcome, relevant evidence, available context | Recommended next action    |
| Blocked        | Status, blocker with code, evidence or recovery context | Next action or recovery    |
| Decision       | Status, decision context, available choices             | Decision required          |
| Review pending | Status, review obligation context                       | Independent review pending |
| Terminal       | Status or final artifact context                        | Terminal message           |
| Diagnostic     | Blocker, root cause, observed and required evidence     | Recovery                   |

Embedded plan, ADR, ticket, and evidence bodies are artifact content, not
presentation authority. They appear before the trusted closing block and cannot
produce a typed conclusion or routing metadata.

## 2. Document Types

| Type            | `kind`            | Use                                                     |
| --------------- | ----------------- | ------------------------------------------------------- |
| Compact Card    | `compact_card`    | Single-surface status, readiness, quick info            |
| Review Card     | `review_card`     | Plan review, architecture review, review report         |
| Plan Document   | `plan_document`   | Reserved — see note below                               |
| Diagnostic Card | `diagnostic_card` | Blocker details, validation results, evidence drilldown |

> **Note on `plan_document`:** This type is **reserved and not currently
> produced in production**. The full plan body is rendered by embedding it into
> the Plan Review Card (`review_card`) as an `embeddedMarkdown` section under
> `## Proposed Plan` (see §4), not as a standalone `plan_document`. The type is
> retained for a possible future standalone plan surface; until then it carries
> no conclusion and has no production builder.

## 3. Heading Hierarchy

- `#` — Reserved for review/plan documents only. Compact and diagnostic cards
  must not use `#`.
- `##` — Section headings within compact cards, review cards, and diagnostic
  cards.
- `**Label:**` — Summary lines within sections. For key-value pairs only.

**Single document title (H1):**

- A document has **at most one** top-level `#` heading, contributed by a
  `TitleSection` placed first. This is the document title (e.g.
  `# FlowGuard Plan Review`).
- Content embedded via `embeddedMarkdown` (agent-authored plan/ADR/ticket
  bodies) may carry its own headings, but the renderer **demotes** them so no
  embedded heading is shallower than the section that owns it. A body embedded
  under a `## Proposed Plan` section therefore starts at `###`, never `#` or
  `##`. This guarantees exactly one document `#` and prevents heading-level
  inversion (an H1 nested under an H2). See §4.

## 4. Embedded Markdown Normalization

`embeddedMarkdown` is the only path that carries content authored outside the
presentation layer (agent plan/ADR bodies, ticket text). It is normalized at the
shared renderer boundary — never per embedder:

- **Heading demotion:** ATX headings are demoted so the shallowest embedded
  heading is at least one level deeper than the owning section (`###` under a
  `##` section; `##` for a label-only embed that sits at document level). This
  enforces the single-H1 rule (§3) and prevents heading-level inversion.
  Relative heading structure within the body is preserved.
- **Whitespace sanitization:** trailing whitespace is stripped and runs of three
  or more newlines are collapsed to a single blank line, so embedded content
  cannot break the spacing invariants (§5).
- **Code-fence exemption:** fenced code blocks are opaque. Their content —
  including `#` lines that are not headings, internal blank lines, and
  indentation — is preserved verbatim and never demoted or sanitized.

Because normalization happens in the renderer, embedders (plan card, architecture
card, `/help` current-plan and ticket bodies) never pre-process embedded content.

Embedded content may contain prose that resembles an instruction, but it remains
artifact content under its owning section. Only a typed renderer conclusion at
the end of the document is a FlowGuard presentation conclusion.

## 5. Spacing Rules

- Exactly `\n\n` (one blank line) between non-empty sections.
- Never `\n\n\n` between structural blocks. Triple-newlines within code-fence
  content are permitted (code-fence content is exempt from the structural
  spacing rules).
- No leading newline at the start of the document.
- No trailing newline at the end of the document.
- No trailing whitespace on any line.

## 6. Status Label Normalization

| Raw value             | Presentation label  |
| --------------------- | ------------------- |
| `blocked`             | Blocked             |
| `ready_with_warnings` | Ready with warnings |
| `changes_required`    | Changes required    |
| `not_verified`        | Not verified        |
| `in_progress`         | In progress         |
| `ready`               | Ready               |

Raw enum strings (e.g. `SCREAMING_SNAKE_CASE`, `ready_with_warnings`) must
never appear un-normalized in user-facing output.

## 7. Symbol Set

The symbols below are the canonical Unicode vocabulary for review artifacts,
including `reviewCard`. OpenCode may render the separate transient
`presentation.markdown` field with the `presentation.opencode.glyphProfile`
ASCII profile when configured. That fallback changes only renderer-owned status
and action markers; it does not transliterate arbitrary Markdown, embedded
artifact content, or user-authored text. `reviewCard` remains Unicode and must
be displayed verbatim.

| Symbol | Meaning               | When to use                                               |
| ------ | --------------------- | --------------------------------------------------------- |
| `→`    | Recommended action    | Exactly one per document, for the primary next action     |
| `-`    | Available action      | Commands the user can choose from, without recommendation |
| `⚠`    | Warning / recoverable | Non-blocking issues, degraded state, config warnings      |
| `✓`    | Verified              | Confirmed gate, passed check, satisfied obligation        |
| `✗`    | Failed                | Failed check, rejected work, broken invariant             |
| `?`    | NOT_VERIFIED          | Claims or data that could not be verified                 |
| `—`    | N/A                   | Explicitly not applicable (use sparingly)                 |

**Rules:**

- Never emojis.
- Never symbols without accompanying text.
- Never present `—` (N/A) as a placeholder for missing data — omit instead.

## 8. Conclusion Types

Every document with user-relevant actions must end with one conclusion:

| Conclusion          | When                                                                               |
| ------------------- | ---------------------------------------------------------------------------------- |
| `next_action`       | One recommended action exists. Rendered with `→`.                                  |
| `decision_required` | Multiple valid actions, none recommended by authority. Rendered with `•` for each. |
| `terminal`          | No further actions exist. Rendered as a plain message without action symbols.      |
| `review_pending`    | An independent reviewer must complete work before workflow progress.               |
| `recovery`          | A diagnostic supplies canonical recovery steps without one primary command.        |

A document never contains more than one conclusion.

## 9. NULL / NOT_VERIFIED Rules

- Fields that are `null` or `undefined` are **omitted** from the output, except
  the mandatory `ProofGraphSection` on a state-bound governance result. A
  resolved session with no declared claims renders graph-level `NOT_DECLARED`.
- Never replace missing data with `"unknown"`, `"—"`, or fabricated fallback text.
- Never let the renderer substitute a default when a field is absent — the
  upstream projection decides omission.
- Claims marked NOT_VERIFIED must carry the `?` symbol and state that
  verification was not possible without fabricating authority.

## 10. Action Presentation

Every command-based action shares a single representation:

```ts
interface PresentationAction {
  readonly invocation: string | null;
  readonly description: string;
  readonly visibility: 'recommended' | 'available';
}
```

- `invocation: null` is only valid for non-command actions (e.g. "Review the
  findings and decide"). Must never render with backtick-fencing.
- `invocation` values with `/` prefix are rendered as `` `/invocation` `` in
  backticks.
- `description` provides human-readable context for the action.

## 11. Reason Codes

Reason codes (e.g. `PLAN_APPROVE_WITH_TEXT`, `MISSING_EVIDENCE`) are always
rendered in backticks. Never use reason codes as plain inline text.

### 11.1 Human Projection for Migrated Reason Codes

"Migrated" reason codes carry human-authored copy in the canonical copy table
(`src/presentation/reason-copy.ts`, the `REASON_COPY` authority). A code is
migrated exactly when it has an entry in that table; the projection derives its
`impact` classification and its human copy from it and never from the technical
`BlockedCategory` taxonomy.

Migrated reason codes render differently on the two default surfaces. The
rendered presentation (`/status`, `/why`, `/finish`) makes the headline the
primary human copy and keeps the reason code as diagnostic identity in Details:

- **Headline becomes the primary human copy.** The context-free `headline` is
  the `BlockerSection.text`, so `{placeholder}` interpolation context never
  leaks onto the rendered surface.
- **The reason code is diagnostic identity, not the headline.** It moves out of
  the primary `Blocked:` line and into `**Details:**`.
- **The registry-verbatim message is never lost.** It is carried as the
  projection's `canonicalMessage` and rendered under `**Details:**`.
- **The human-authored explanation renders as `**Why:**`** when present.

```markdown
⚠ **Blocked:** Discovery drift blocks mutating tools
**Recovery:** Re-run discovery and flowguard_hydrate to reconcile drift against persisted evidence
**Why:** The discovery surface drifted from the persisted binding and the onDrift policy blocks mutating tools. Reconcile drift before continuing.
**Details:**
`DISCOVERY_DRIFT_BLOCKED`
Discovery drift verdict is drifted; policy onDrift=block stops mutating tools
```

The structured blocked tool result stays canonical and additive:

```text
message  = canonical registry message
headline = humanized headline
code     = canonical code
recovery = canonical recovery
```

`message` remains the interpolated registry message; `headline` is carried as an
additive field (migrated codes only) so plugin boundaries read the human copy
without message parsing. Unmigrated blocked output is byte-identical.

### 11.2 ProofGraph Claim Human Projection

Claim verification states are projected through a single vocabulary authority
(`src/presentation/human-verification.ts`) that maps six canonical states to
five human labels. Only `PROVEN` renders as `Verified`; `UNPROVEN` and
`NOT_VERIFIED` both render as `Not verified` but remain diagnostically distinct.

Default surface (human mode):

- `PROVEN` → `✓ Verified`
- `UNPROVEN` → `? Not verified`
- `NOT_VERIFIED` → `? Not verified`
- `CONTRADICTED` → `✗ Failed`
- `STALE` → `⚠ Needs re-check`
- `BLOCKED` → `⚠ Blocked`

Diagnostic mode (`detail: 'diagnostic'`) renders the raw canonical state,
claim id, claim scope, required evidence kinds, counterexample requirement,
binding diagnostic code, freshness digest, and candidate id when present.

Evidence requirements are projected from two distinct canonical sources
that MUST NOT be collapsed:

- `requiredEvidence` (provider kinds) → `RequiredEvidenceProjection`
- `counterexampleRequirement` (assertion / aggregate_check binding) →
  `CounterexampleRequirementProjection`

Claim statements are rendered verbatim. No per-reference satisfied/missing
evidence status is inferred. `candidateId`, provider identity, and claim
scope are rendered only when canonically present. Binding diagnostic copy
lives in a single exhaustive authority (`src/presentation/claim-diagnostic-copy.ts`).

## 12. Density

`compact` is the default and currently only density. Future expansions (e.g.
`verbose` for diagnostics) will be represented as part of the document `kind`,
not as a renderer parameter.

## 13. Code Fences

- Code sections use fenced Markdown blocks.
- Fence length is deterministically chosen to exceed the longest backtick run
  within the content by at least 1, with a minimum of 3.
- Language identifiers are validated against `[A-Za-z0-9_+.#-]+`. Invalid
  identifiers are rejected with an explicit error.

## 14. Bullet List (`bulletList`)

Generic bulleted list for non-command items (exit options, enumerations).
Renders as:

```markdown
- Item one
- Item two
```

- Empty items are rejected with a contract error.
- Distinct from `commandList` — no invocation, no description, no visibility.

## 15. Guidance (`guidance`)

Non-normative action recommendations for /finish.

| `GuidanceStatus`  | Symbol | Rendering                                 |
| ----------------- | ------ | ----------------------------------------- |
| `recommended`     | `-`    | `- **Action:** Recommended — reason.`     |
| `not_recommended` | `-`    | `- **Action:** Not recommended — reason.` |
| `not_verified`    | `-`    | `- **Action:** Not verified — reason.`    |

- Must NOT be confused with executable commands (`commandList`).
- Must NOT be confused with advisory notices (`notice`).
- Every item must have non-empty `action` and `reason` fields.

## 16. Notice Multi-Message

The `NoticeSection` now supports `additionalMessages?: readonly string[]`
for rendering multiple messages under a single heading:

```markdown
## Warnings

⚠ First warning.
⚠ Second warning.
```

- Each message receives its own symbol prefix.
- Empty messages in `additionalMessages` are rejected.
- Backwards-compatible: existing single-message notices are unaffected.

## 17. Tables And Long Content

Compact FlowGuard state is rendered through typed key-value, checklist,
artifact, and findings sections; the renderer does not generate Markdown tables.
Tables and long bodies may appear only as embedded artifact content. They are
structurally normalized but never truncated, summarized, or converted by the
renderer. Canonical upstream projections may instead reference an artifact when
they intentionally avoid returning its full content.

## 18. Archive Labels

Archive lifecycle states (`pending` | `created` | `verified` | `failed`)
are normalised via `parseArchiveLabel()`. Unknown values throw a contract
error. The known set is derived from the state domain, not manually
duplicated.

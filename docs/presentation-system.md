# FlowGuard Presentation System

Canonical visual language for all FlowGuard user-facing output. Every consumer
that renders FlowGuard status, cards, plans, or diagnostics MUST comply with
this contract.

## 1. Document Types

| Type            | `kind`            | Use                                                     |
| --------------- | ----------------- | ------------------------------------------------------- |
| Compact Card    | `compact_card`    | Single-surface status, readiness, quick info            |
| Review Card     | `review_card`     | Plan review, architecture review, review report         |
| Plan Document   | `plan_document`   | Full plan body with context metadata                    |
| Diagnostic Card | `diagnostic_card` | Blocker details, validation results, evidence drilldown |

## 2. Heading Hierarchy

- `#` — Reserved for review/plan documents only. Compact and diagnostic cards
  must not use `#`.
- `##` — Section headings within compact cards, review cards, and diagnostic
  cards.
- `**Label:**` — Summary lines within sections. For key-value pairs only.

## 3. Spacing Rules

- Exactly `\n\n` (one blank line) between non-empty sections.
- Never `\n\n\n` between structural blocks. Triple-newlines within code-fence
  content are permitted (code-fence content is exempt from the structural
  spacing rules).
- No leading newline at the start of the document.
- No trailing newline at the end of the document.
- No trailing whitespace on any line.

## 4. Status Label Normalization

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

## 5. Symbol Set

| Symbol | Meaning               | When to use                                               |
| ------ | --------------------- | --------------------------------------------------------- |
| `→`    | Recommended action    | Exactly one per document, for the primary next action     |
| `•`    | Available action      | Commands the user can choose from, without recommendation |
| `⚠`    | Warning / recoverable | Non-blocking issues, degraded state, config warnings      |
| `✓`    | Verified              | Confirmed gate, passed check, satisfied obligation        |
| `✗`    | Failed                | Failed check, rejected work, broken invariant             |
| `?`    | NOT_VERIFIED          | Claims or data that could not be verified                 |
| `—`    | N/A                   | Explicitly not applicable (use sparingly)                 |

**Rules:**

- Never emojis.
- Never symbols without accompanying text.
- Never present `—` (N/A) as a placeholder for missing data — omit instead.

## 6. Conclusion Types

Every document with user-relevant actions must end with one conclusion:

| Conclusion          | When                                                                               |
| ------------------- | ---------------------------------------------------------------------------------- |
| `next_action`       | One recommended action exists. Rendered with `→`.                                  |
| `decision_required` | Multiple valid actions, none recommended by authority. Rendered with `•` for each. |
| `terminal`          | No further actions exist. Rendered as a plain message without action symbols.      |

A document never contains more than one conclusion.

## 7. NULL / NOT_VERIFIED Rules

- Fields that are `null` or `undefined` are **omitted** from the output.
- Never replace missing data with `"unknown"`, `"—"`, or fabricated fallback text.
- Never let the renderer substitute a default when a field is absent — the
  upstream projection decides omission.
- Claims marked NOT_VERIFIED must carry the `?` symbol and state that
  verification was not possible without fabricating authority.

## 8. Action Presentation

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

## 9. Reason Codes

Reason codes (e.g. `PLAN_APPROVE_WITH_TEXT`, `MISSING_EVIDENCE`) are always
rendered in backticks. Never use reason codes as plain inline text.

## 10. Density

`compact` is the default and currently only density. Future expansions (e.g.
`verbose` for diagnostics) will be represented as part of the document `kind`,
not as a renderer parameter.

## 11. Code Fences

- Code sections use fenced Markdown blocks.
- Fence length is deterministically chosen to exceed the longest backtick run
  within the content by at least 1, with a minimum of 3.
- Language identifiers are validated against `[A-Za-z0-9_+.#-]+`. Invalid
  identifiers are rejected with an explicit error.

# Compact command transport on OpenCode V2

2026-11-17. Design and contract evidence only. No live Desktop/TUI acceptance
run was executed for this change.

## Problem

Installed FlowGuard commands were Markdown prompt templates. OpenCode expands a
Markdown command into a durable user prompt and renders the complete expanded
body in the transcript. Every FlowGuard command therefore repeated its full
instructions after invocation.

## Implemented mechanism

- The plugin registers every installed command identity natively. OpenCode no
  longer installs the corresponding Markdown command files.
- The visible user prompt is only `/command` plus the user's arguments.
  Attachments, agent mentions and skills are forwarded unchanged.
- The context hook finds the latest user message. If it starts with a native
  FlowGuard command, the hook injects that command's canonical template body as
  a system part marked `source: flowguard-command-instructions`.
- Tool-driven continuations keep the same latest user message, so the body
  applies for the command turn. A later ordinary prompt no longer matches and
  does not receive the previous body.
- `/check` uses the same path: only `/check` is submitted, while its canonical
  body is injected.
- Deterministic native commands (activation, decisions, lifecycle, diagnostics)
  keep their existing executors and result presentation. Pure UI commands keep
  their existing panel/chooser actions.

The mechanism adds no workflow, activation, approval, evidence or audit
authority. The ordinary tools and machine gates remain the only execution
authority. Injection is presentation and transport only.

## Installation and upgrade

OpenCode installations no longer write command templates. A pre-existing command
file at a native identity is accepted only when its bytes equal the current
managed template; install removes exactly that file. Any other content remains a
`MANAGED_ARTIFACT_CONFLICT` and is never removed or overwritten. Other supported
hosts keep their portable template files.

## Verified in this change

- Contract test: every installed template command has exactly one native
  registration; `/check` is separate and `/start` is not duplicated.
- Contract test: the visible prompt is the command plus arguments; attachments,
  mentions, skills and delivery survive.
- Contract test: injection only matches the latest user command, never an older
  command after a later prompt, never ordinary prose, and never duplicates.
- Contract test: `/check` submits only `/check` and still waits, restores the
  previous agent and clears scope.
- Installer tests: no command template is written for OpenCode; an exact managed
  upgrade file is removed; foreign bytes still block installation.
- Doctor tests: missing native command files are expected; an obsolete exact
  template is a warning; unreadable files remain errors.
- Full unit and integration suites, type checks, lint and architecture checks
  are run by the owning PR.

## Not verified

- `NOT_VERIFIED`: visible rendering on pinned OpenCode Desktop and TUI builds.
  No installed-product screenshot or UI capture was produced for this change.
- `NOT_VERIFIED`: model adherence when the command body is a system part instead
  of the user message. It is structurally present in the provider request, but
  no live model-quality evaluation was run.
- `NOT_VERIFIED`: multi-turn clarification after an initial command. The body is
  injected only while the command prompt is the latest user message; a reply to
  a model question is a new ordinary prompt and does not re-inject it.
- `NOT_VERIFIED`: token accounting. Hiding the body from the transcript does not
  by itself reduce model context; the body still travels in system context for
  the command turn.

## Required installed-host acceptance

Use a disposable profile and record the exact Desktop/CLI/TUI version, SDK
version, package digest and command file removals.

1. Invoke `/implement`, `/task`, `/status`, `/help` and `/check`; verify only the
   command line and arguments are visible.
2. Inspect the provider request or plugin diagnostics; verify the canonical body
   is present in system context for the command turn and absent after a later
   ordinary prompt.
3. Verify attachments, mentions and skills still reach the model.
4. Verify `/check` still restores the previous agent and clears scope.
5. Verify a blocker or review gate still displays its complete canonical card.
6. Repeat after an upgrade from a previous install that still has command files;
   verify exact managed templates are removed and foreign files are preserved.

Until this run exists, UI compactness and model adherence remain
`NOT_VERIFIED`; unit evidence is not installed-product acceptance.

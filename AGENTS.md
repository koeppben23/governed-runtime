# Governed Runtime Contributor Notes

This repository builds FlowGuard, but working in this repository is not itself a
FlowGuard-governed runtime session.

## Local Agent Behavior

- Do not call FlowGuard workflow tools merely because this file exists.
- Treat FlowGuard commands, sessions, evidence, and audit artifacts as product
  behavior to inspect or modify, not as the mandatory control plane for ordinary
  repository edits.
- Use the normal development tools available in this workspace unless the user
  explicitly asks you to exercise FlowGuard runtime behavior.
- If a product test requires FlowGuard artifacts, run the repository test or
  command that owns that behavior; do not invent governance evidence in chat.

## Product Mandates

- Installed FlowGuard agent mandates are owned by `src/templates/mandates.ts`.
- The root `AGENTS.md` is local contributor guidance only and must not be used as
  the canonical source for installed mandate text.
- Keep product mandate changes aligned with their renderer, hash guards, install
  tests, and documentation contracts.

## Engineering Rules

- Make the smallest correct change that satisfies the user request.
- Preserve canonical authorities, schemas, state transitions, and fail-closed
  behavior in product code.
- Do not hide failures with silent fallbacks; surface errors explicitly.
- Do not claim tests or verification passed unless they were run.
- Mark unexecuted or unproven claims as `NOT_VERIFIED`.
- For trust-boundary reviews, use `docs/trust-boundaries.md` as the canonical
  review contract.

## Verification

- Run the narrowest relevant tests for the touched surface.
- For behavior touching state, policy, evidence, audit, identity, archive,
  installer, release, CI, persistence, migration, or security boundaries, include
  negative-path coverage when practical.
- Before finishing, check that runtime, docs, tests, schemas, templates, and
  generated/hash guards remain aligned.

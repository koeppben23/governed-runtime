# Implementation Guidance

Use this guide for implementation depth beyond `AGENTS.md`.

## Before Implementation

- Identify the authoritative source for behavior (schema, state model, policy, command surface, or adapter contract).
- Read current implementation, nearby tests, and docs before changing code.
- Classify risk (`TRIVIAL`, `STANDARD`, `HIGH-RISK`) and choose the smallest safe workflow.
- Prefer fail-closed behavior over best-effort continuation.

## During Implementation

- Keep changes small, local, and contract-preserving.
- Reuse existing paths before adding new layers or aliases.
- Do not introduce fallback or compatibility paths that can hide defects.
- Preserve single sources of truth for state, policy, evidence, and archive ownership.
- Treat authority placement as a hard constraint:
  - machine and rails own workflow logic,
  - adapters own I/O,
  - docs describe behavior and do not redefine runtime authority.

## Testing Strategy

- Add tests that prove risky behavior and unhappy paths, not only happy paths.
- For `HIGH-RISK` changes, include deterministic blocked or failure-path assertions.
- Keep tests behavior-focused and stable; avoid assertion patterns that pass for the wrong reason.
- Do not weaken tests to accommodate an implementation shortcut.

## Verification Expectations

- `TRIVIAL`: verify only if touched content can break (links, snippets, generated docs).
- `STANDARD`: targeted tests/checks plus lint/typecheck when practical.
- `HIGH-RISK`: negative-path coverage plus lint, typecheck, build, and relevant integration/e2e checks.
- Release/installer: validate exact generated artifact install path.

## Documentation Rules

- Update docs when behavior, interfaces, or operator expectations change.
- Keep claims grounded in implemented behavior.
- Do not overclaim enterprise or compliance outcomes unsupported by evidence.
- Keep guidance consistent with root `AGENTS.md` and avoid introducing a second output contract.

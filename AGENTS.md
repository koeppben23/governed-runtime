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

## Local Commands

- `npm test` — full unit + integration suite.
- `npx vitest run --project unit <file>` — run a focused unit test file.
- `npx vitest run --project integration <file>` — run a focused integration test file.
- `npx vitest run --project smoke <file>` — run a focused smoke test file.
- `npm run check` — TypeScript compilation (`tsc --noEmit`).
- `npm run lint:strict` — ESLint with `--max-warnings=0` as a CI gate.
- `npm run check:format` — Prettier formatting check.
- `npm run build` — production build to `dist/`.
- `npm run test:architecture` — dependency rules and file-size enforcement.
- `npm run check:unused-dependencies` — Knip stale dependency/module check.

## Verification Checklist

Before marking any task complete:

1. Run `npm run check` — zero type errors.
2. Run `npm run lint:strict` — zero warnings.
3. Run the narrowest relevant test command for the touched surface.
4. Run `npm run test:architecture` for dependency, module-boundary, file-size, or architecture-sensitive changes.
5. Run `npm run build` for CLI, package, runtime entrypoint, or distribution changes.
6. Run `npm run check:unused-dependencies` when imports, exports, packages, or module boundaries change.
7. For state, policy, archive, audit, review, or enforcement authority changes, run `npm run mutation` when mutation scope changed or the touched authority is mutation-covered. If not run, mark `NOT_VERIFIED` with the recovery command.
8. For new reason codes, verify `npx vitest run --project unit src/config/reasons-completeness.test.ts`.
9. For documentation contract changes, run the relevant docs drift or contract tests for the touched area; if no such test exists, state that explicitly in the verification notes. Reason-code or reason-doc changes must include:
   ```
   npx vitest run --project unit src/config/reasons-completeness.test.ts src/documentation/__tests__/reasons-doc-drift.test.ts
   ```
10. Before pushing, run `npm run check:format`; the CI pre-push hook requires clean Prettier output.

## Git Conventions

- Branches: `fix/<name>`, `feat/<name>`, `chore/<name>`.
- Commits: conventional commit format (`fix(scope):`, `feat(scope):`, `docs:`, `chore:`).
- Never commit unless explicitly asked by the user.
- Never force-push without explicit user instruction.
- Push with `--force-with-lease` when rebasing; never use plain `--force`.

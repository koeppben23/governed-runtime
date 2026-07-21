# CLAUDE.md

This file provides Claude Code with project context. For detailed rules, see `AGENTS.md`.

## Project

This is the FlowGuard repository — a deterministic, fail-closed governance runtime for AI-assisted engineering workflows.

## Architecture

* `src/machine/` — state machine, phase transitions, guard evaluation
* `src/config/` — config schemas, reason codes, policy types
* `src/integration/` — plugin lifecycle, tools, review pipeline
* `src/rails/` — command routing and state-machine orchestration
* `src/state/` — session state management
* `src/shared/` — canonical serialization, digests, utilities

## Key Commands

* `npm test` — full unit and integration suite
* `npm run check` — TypeScript compilation
* `npm run lint:strict` — ESLint
* `npm run build` — production build
* `npm run test:architecture` — dependency, module, and file-size rules

## Critical Rules

* Never commit unless explicitly asked.
* Never force-push without explicit instruction.
* Use `--force-with-lease`, never plain `--force`.
* Do not present assumptions as established facts; mark them `ASSUMPTION`.

See `AGENTS.md` for the full contributor guidance.

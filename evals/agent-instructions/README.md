# Agent Instruction Eval Suite

Deterministic, provider-neutral conformance corpus with separate instruction
surfaces. `repository_contributor` covers repository-local guidance such as
`AGENTS.md`; `flowguard_product` covers the managed mandates FlowGuard installs
for customer hosts. Results retain the surface and must not be compared across it.

## Structure

```
cases/              — YAML case definitions (8 cases)
schema.ts           — Zod schemas for cases, runner config, and results
load-cases.ts       — YAML parser → typed EvalCase[]
assertions.ts       — Pure assertion evaluation functions
score.ts            — PASS / FAIL / RUNNER_ERROR scoring
run.ts              — Orchestration: load → spawn → assert → score → report
runners/
  process-runner.ts — Generic shell-free process runner
fixtures/
  fake-agent.mjs    — Deterministic fake CLI for testing the runner itself
__tests__/          — Unit tests for all modules
```

## Case classes

| Class | `mode` | Description |
|-------|--------|-------------|
| Workspace | `workspace` | Full mini-repository with fixture. Evaluates real file changes. |
| Output-only | `output-only` | Evaluates stdout/stderr output. No filesystem interaction. |

For `flowguard_product`, the runner materializes the managed mandate through the
production renderer, digest, managed artifact builder, and OpenCode instruction
entry before invoking the configured host.

## Running

### Manual (with a real host)

Not automated in CI. Requires a locally installed agent command:

```json
{
  "name": "example-host",
  "command": "agent-command",
  "args": ["run"],
  "timeoutMs": 600000,
  "workspaceMode": "copy"
}
```

### Automated (with the fake agent)

```sh
npx vitest run --project scripts evals/
```

## Scoring

- `PASS`: all hard assertions satisfied
- `FAIL`: any hard assertion violated
- `RUNNER_ERROR`: spawn failed, timeout, signal, or internal runner failure

Advisory assertion failures produce warnings but do not cause `FAIL`.

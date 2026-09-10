# Agent Instruction Eval Suite

Deterministic, provider-neutral conformance corpus with separate instruction
surfaces. `repository_contributor` covers repository-local guidance such as
`AGENTS.md`; `flowguard_product` covers the managed mandates FlowGuard installs
for customer hosts. Results retain the surface and must not be compared across it.

Every case declares `instructionSurface` explicitly. Product cases additionally
declare `instructionHost`; the harness currently supports `opencode` only and
fails closed when product host metadata is absent or unsupported. Claude Code and
Codex product transport behavior remains `NOT_VERIFIED` until dedicated host
materializers exist.

## Structure

```
cases/              — YAML case definitions (12 cases: 8 contributor, 4 product)
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

For `flowguard_product` + `opencode`, the runner materializes the managed mandate
through the production renderer, digest, managed artifact builder, and the
production `mergeOpencodeJson` path before invoking the configured host. Existing
customer OpenCode configuration and non-FlowGuard instruction entries are
preserved rather than overwritten.

## Running

### Manual (with a real host)

Not automated in CI. Requires a locally installed agent command. The runner
configuration is validated by `RunnerConfigSchema`; use only fields defined by
that schema. Provider/model metadata is not currently part of the persisted
result contract, so live cross-provider comparisons remain `NOT_VERIFIED` for
reproducible provenance until that contract is extended.

Example using stdin prompt transport:

```json
{
  "name": "example-host",
  "command": "agent-command",
  "promptTransport": "stdin",
  "args": ["run"],
  "staticEnv": {},
  "secretEnvNames": ["PROVIDER_API_KEY"],
  "timeoutMs": 600000
}
```

For argument transport, set `"promptTransport": "argument"` and include exactly
one `{prompt}` placeholder in `args`.

`secretEnvNames` is an explicit allowlist of secret environment variables copied
from the parent process into the child. Other parent-process environment values
are not inherited except for the small runtime environment allowlist required to
spawn local processes. Never place secret values in `staticEnv`.

### Automated (with the fake agent)

```sh
npx vitest run --project scripts evals/
```

## Scoring

- `PASS`: all hard assertions satisfied
- `FAIL`: any hard assertion violated
- `RUNNER_ERROR`: spawn failed, timeout, signal, or internal runner failure

Advisory assertion failures produce warnings but do not cause `FAIL`.

# Agent Instruction Eval Suite

Deterministic, provider-neutral conformance corpus with separate instruction
surfaces. `repository_contributor` covers repository-local guidance such as
`AGENTS.md`; `flowguard_product` covers the managed mandates FlowGuard installs
for customer hosts. Results retain the surface and must not be compared across it.

Every case declares `instructionSurface` explicitly. Product cases additionally
declare `instructionHost`; the harness supports `opencode`, `claude-code`, and
`codex` and fails closed when product host metadata is absent or unsupported.
Host materialization is coupled to production code: OpenCode uses the managed
mandate renderer and production JSON merge path, while Claude Code and Codex use
their production plugin-template generators. Live model behavior is a separate
assurance dimension and remains `NOT_VERIFIED` until a real host/provider runner
is executed.

## Structure

```
cases/              — YAML case definitions (20 cases: 8 contributor, 12 product)
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

For `flowguard_product`, the runner materializes the selected host transport
before invoking the configured process. OpenCode uses the production renderer,
digest, managed artifact builder, and `mergeOpencodeJson` path. Claude Code uses
`claudeCodePluginFiles`; Codex uses `codexPluginFiles` plus an isolated repo-scope
marketplace registration matching the production registration contract. Existing
customer OpenCode configuration and non-FlowGuard instruction entries are
preserved rather than overwritten. Runner arguments may use `{workspaceRoot}`
when a real host CLI needs an explicit path to the isolated product transport.

## Running

### Manual (with a real host)

Live provider runs require a locally installed agent command and are not treated
as verified merely because the deterministic harness passes. The runner
configuration is validated by `RunnerConfigSchema`; use only fields defined by
that schema. Provider, model, provider model version, runner version, command,
arguments, checked-out Git commit, FlowGuard version, and mandate digest are
persisted in `summary.json`. Missing runner/model identity is rejected before a
run starts so live results cannot silently lose reproducibility provenance.

Example using stdin prompt transport:

```json
{
  "name": "example-host",
  "command": "agent-command",
  "provider": "provider-id",
  "model": "model-id",
  "modelVersion": "provider-model-version",
  "runnerVersion": "runner-cli-version",
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
npx vitest run --project evals
```

The deterministic suite verifies case parsing, isolation, transport
materialization, assertion/scoring behavior, provenance persistence, and report
redaction. It does **not** establish that a named external model followed the
instructions; only a real host/provider run can establish that evidence.

## Scoring

- `PASS`: all hard assertions satisfied
- `FAIL`: any hard assertion violated
- `RUNNER_ERROR`: spawn failed, timeout, signal, or internal runner failure

Advisory assertion failures produce warnings but do not cause `FAIL`. Persisted
and rendered quality totals are grouped only by `instructionSurface`; contributor
and FlowGuard-product results are never collapsed into one assurance number.

# Agent Instruction Eval Suite

Deterministic eval harness with separate instruction surfaces. `repository_contributor`
covers repository-local guidance such as `AGENTS.md`; `flowguard_product` covers a
host-specific FlowGuard product transport. Results retain the surface and product host;
they are never collapsed into one cross-surface or cross-host assurance claim.

Every case declares `instructionSurface` explicitly. Product cases also declare
`instructionHost`; supported hosts are `opencode`, `claude-code`, and `codex`.
Missing or unsupported host metadata fails closed.

## Assurance boundary

Materialization and live behavior are separate assurance dimensions:

- **OpenCode** materialization uses the production managed-mandate renderer, digest,
  managed artifact builder, and production `mergeOpencodeJson` path.
- **Claude Code** materialization uses the production Claude plugin-template generator.
- **Codex** materialization uses the production Codex plugin-template generator plus an
  isolated marketplace registration matching the production registration contract.

The deterministic harness proves that those host-specific files are materialized from
production code and that the runner/reporting machinery behaves correctly. It does **not**
prove native host load, model-context visibility, hook trust, or model compliance.
In particular, the full installed `flowguard-mandates.md` is wired as an OpenCode
instruction source; Claude Code and Codex use their own plugin adapter surfaces. Their
plugin materialization must therefore not be cited as evidence that the full v5 mandate
body was injected into a model context. Native load and behavioral compliance remain
`NOT_VERIFIED` until observed with the matching real host/provider.

## Structure

```
cases/              — YAML case definitions (20 cases: 8 contributor, 12 product)
schema.ts           — Zod schemas for cases, runner config, and result provenance
load-cases.ts       — YAML parser → typed EvalCase[]; rejects duplicate IDs
assertions.ts       — Pure assertion evaluation functions
score.ts            — PASS / FAIL / RUNNER_ERROR scoring by surface and product host
run.ts              — Orchestration: load → spawn → assert → score → report
runners/
  process-runner.ts — Shell-free, bounded, isolated process runner
fixtures/
  fake-agent.mjs    — Deterministic fake CLI for runner plumbing tests
__tests__/          — Unit/regression tests for framework contracts
```

## Case classes

| Class       | `mode`        | Description                                                     |
| ----------- | ------------- | --------------------------------------------------------------- |
| Workspace   | `workspace`   | Full mini-repository with fixture. Evaluates real file changes. |
| Output-only | `output-only` | Evaluates stdout/stderr output. No fixture content required.    |

For `flowguard_product`, the selected host transport is materialized before the
configured process starts. Existing customer OpenCode config and non-FlowGuard
instruction entries are preserved rather than overwritten. Runner arguments may use
`{workspaceRoot}` when a real host CLI needs the isolated workspace explicitly.

## Running

### Automated deterministic suite

```sh
npx vitest run --project evals
```

This verifies case parsing, duplicate-ID rejection, regex validation, environment
isolation, symlink-safe snapshots, host transport materialization, assertion/scoring,
provenance persistence, output bounds, and report redaction. A PASS here is harness and
transport-template evidence, **not** external-model behavior evidence.

### Manual strict run with a real host

A strict runner is explicitly one host. It must declare:

- `runnerKind: "live-host"`
- exactly one `instructionHost`
- non-synthetic provider/model identity
- the real host command and its runner version
- a deterministic `seed` when the run participates in required non-inferiority comparison
- provider secrets only through `secretEnvNames`

Example:

```json
{
  "name": "claude-code-live",
  "command": "claude",
  "provider": "anthropic",
  "model": "claude-model-id",
  "modelVersion": "provider-model-version",
  "runnerVersion": "host-cli-version",
  "seed": "v5-ni-seed-1",
  "runnerKind": "live-host",
  "instructionHost": "claude-code",
  "promptTransport": "stdin",
  "args": ["--plugin-dir", "{workspaceRoot}/flowguard-plugin"],
  "staticEnv": {},
  "secretEnvNames": ["ANTHROPIC_API_KEY"],
  "timeoutMs": 600000
}
```

Run the CLI with `--require-live-host` for a strict live run. Product cases are then
restricted to the runner's bound `instructionHost`; a Claude runner cannot silently
produce OpenCode or Codex product assurance. Repository-contributor cases remain a
separate surface.

`--require-non-inferiority` is stronger: it requires a baseline summary and implicitly
requires a host-bound `live-host` runner, a non-synthetic provider, and a deterministic
`seed`. The seed is passed to the child process as `FLOWGUARD_EVAL_SEED`, persisted in
run provenance, and included in the runner-config digest. Baseline and candidate runs
must have compatible provider/model/runner/host/config provenance and the same seed;
dirty worktrees make the comparison `NOT_VERIFIED`.

For argument prompt transport, set `"promptTransport": "argument"` and include exactly
one `{prompt}` placeholder in `args`.

`staticEnv` is for non-secret static configuration only. Secret-like environment keys
are rejected there; credentials must be named in `secretEnvNames`. Only the explicit
secret allowlist plus a small process-runtime environment allowlist is inherited by the
child process.

## Provenance

`summary.json` schema v3 persists enough run identity to distinguish materially
different evaluations without persisting secret values:

- provider, model, model version, runner version, and optional deterministic seed
- runner kind and bound host when declared
- command, arguments, prompt transport, effective timeout
- runner-config digest and secret environment **names**
- checked-out Git commit and dirty-worktree state
- FlowGuard version and installed mandate digest
- canonical parsed case-corpus digest

Reports are grouped by both `instructionSurface` and product `instructionHost`.
Provider credential values are never persisted and every explicitly declared secret
value is redacted regardless of length.

## Scoring

- `PASS`: all hard assertions satisfied
- `FAIL`: any hard assertion violated
- `RUNNER_ERROR`: spawn, timeout, signal, workspace, or framework failure

Advisory assertion failures produce warnings but do not cause `FAIL`. Synthetic/advisory
runs never establish live product assurance. A strict live PASS is evidence only for the
specific host/provider/model/run provenance captured in that report; it is not a global
cross-provider claim. Required non-inferiority additionally refuses incomparable
provenance or dirty-worktree evidence rather than silently treating it as equivalent.

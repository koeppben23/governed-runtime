# OpenCode v2.2.4 Phase 0 host-probe report

Status: **NO-GO for the current #1169 acceptance contract**

Date: 2026-10-30
Host: OpenCode Desktop and CLI 2.2.4
Scope: installed-artifact host probe only. No FlowGuard production runtime,
v1 SDK baseline, `TESTED_OPENCODE_HOST_VERSION` or existing v1 test was
changed.

This report is evidence for issue #1169. It does not claim OpenCode v2
support, and it does not claim that the missing guarantees are impossible.
It records which guarantees were demonstrated, which failed, and which remain
unverified.

## Host and method

| Item                                 | Recorded value                                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| CLI                                  | `opencode v2.2.4`                                                                               |
| Global CLI package                   | `@opencode/cli@2.2.4`                                                                           |
| Desktop `CFBundleShortVersionString` | `2.2.4`                                                                                         |
| Desktop `CFBundleVersion`            | `2.2.4`                                                                                         |
| Desktop `app.asar` SHA-256           | `aaf7c79f7694268e5c10fe934fdf3870ed9dc234a3116e2e9d2a8451e91f86d7`                              |
| Desktop code signature               | Developer ID Application: Anomaly Innovations, Inc. (5NZ4Q7NXJ4), notarized                     |
| Isolated probe server                | `opencode serve`, private port, isolated HOME/config/data/state/cache/DB                        |
| Deterministic provider               | OpenAI-compatible capture provider; Alibaba Responses fixture for the provider-executed attempt |
| Desktop backend                      | PID 37045, child of Desktop PID 36822, `.../cli/2.2.4-arm64/opencode-cli serve --service`       |
| Desktop sessions touched             | **No**; only `server.info` was read                                                             |

The isolated CLI server and the Desktop backend are separate evidence targets.
The Desktop backend identity was obtained from `opencode api server.info` and
the process ancestry; it was not inferred from the CLI probe. No existing
session was created, modified or deleted for that check.

Reproduction:

```sh
node scripts/opencode-v2-probe/backup-restore.mjs
node scripts/opencode-v2-probe/run-all.mjs --skip-backup
```

`run-all.mjs` intentionally exits non-zero when any probe step is
`NOT_SUPPORTED` or `NOT_VERIFIED`; the complete evidence is still written
before it reports the failure.

The probe package and its own lockfile live under
`scripts/opencode-v2-probe/`. Raw JSON evidence is kept locally under
`scripts/opencode-v2-probe/evidence/` and is not committed.

## Backup and restore

`P0-01` passed:

- Config, state, small data files and the SQLite database were copied.
- The 10.9 GB database was backed up with `sqlite3 .backup`, not by copying
  WAL files.
- Backup integrity: `ok`.
- Restore integrity: `ok`.
- Live and restored databases both contain 31 tables, including
  `session`, `session_inbox`, `session_message`, `session_part` and
  `session_share`.
- The backup was retained for operator inspection; the token only records
  the temporary path and hashes.
- No live session was used by the isolated probes.

This closes the backup/restore part of P0-01. The Desktop backend identity and
full plugin activation are recorded below.

## Results

### Plugin discovery and activation

**Discovery: supported. Full activation: supported. Setup failure: NOT_SUPPORTED.**

The host log records:

```text
loading plugin .../.opencode/plugins/flowguard-probe.js
```

After activation, the probe observed `setup:ready`, registered plugin tools
(`probe_echo`, `probe_direct`), and registered `probe-plugin-command`. The
positive plugin path is therefore real, not a linked-source or unit-test
assumption.

However, when `setup()` threw, the host **remained alive and accepted session
operations**, with no `setup:ready` and no hooks. That is a host fail-open
state. `flowguard install` and `doctor` must detect it; the runtime cannot
retroactively install hooks that do not exist.

**Consequence:** missing plugin activation must be detected at install/doctor
time and must block. A successful loader is not, by itself, a GO.

### v1 tool discovery under v2

**NOT_SUPPORTED for the existing `.opencode/tools/flowguard.ts` path.**

A v1-style `.opencode/tools/legacy-probe.ts` file with default and named
exports was present and was **not** discovered in either the setup tool list or
the session tool list. A plugin tool registered through `ctx.tool.transform`
was discovered, and a tool with `codemode: false` appeared as a direct model
tool.

**Consequence:** the current v1 tool artifact is not a v2-compatible tool
surface in this installed build. FlowGuard's tools must be registered through
the plugin and exposed deliberately as direct tools where required.

### Preventive tool fences

**Local tools: SUPPORTED. Code Mode: SUPPORTED. MCP: NOT_VERIFIED.
Provider-executed: NOT_VERIFIED.**

Real side-effect probes:

| Case                          | Result                                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `edit` denied                 | target file remained `original\n`; hook saw `edit`; no after-hook                                                            |
| `shell` denied                | marker file was not created; hook saw `shell`                                                                                |
| Code Mode `execute` denied    | local capture server received **0** fetches; nested `probe_echo` did not run                                                 |
| Direct plugin tool allowed    | `probe_direct` executed and produced an after-hook                                                                           |
| MCP tool                      | MCP server connected, but the host did **not** advertise its tool in the session tool list; no MCP execution path was proven |
| Provider-executed hosted tool | a recorded hosted-tool fixture was replayed; the host did not reach a stable terminal provider-executed tool completion      |

Source inspection confirms the local `execute.before` path is not invoked for
`providerExecuted` calls. A permission or policy deny may still contain such a
tool, but that containment was not proven in this run.

### Command shell blocks and command provenance

**Shell blocks: confirmed executable before prompt admission.
Command origin: NOT_SUPPORTED. Automatic capacity recovery: NOT_SUPPORTED.**

A native Markdown command containing:

```text
!`touch <marker>`
```

created the marker **before** the prompt hook observed the expanded command
text. No `tool.execute.before` hook was involved. A raw prompt containing
`/probe-shell` did not execute the shell block.

This means a native Markdown command can mutate the host before any FlowGuard
tool hook or prompt hook sees it. FlowGuard-owned commands must not contain
shell interpolation if the guarantee is to cover them. Whether arbitrary
project commands can be prevented at all is a separate host limitation.

The command API and prompt hook expose no authoritative human-command origin:

- native Markdown command: host expands and submits a prompt;
- plugin command: plugin's `execute()` receives only `{ sessionID, prompt,
delivery }`;
- SDK `session.command` and SDK `session.prompt` are distinguishable in the
  probe only by call path, not by a host-stamped origin field;
- a child or SDK client can invoke the same command path.

Therefore a host-verified "fresh explicit user command" was not demonstrated.
The #1168 capacity lock cannot be released automatically under this contract.
Only a separately operator-authorized recovery action is a viable alternative,
and it must not be synthesized by an LLM or SDK prompt.

### Reviewer child, request lineage and completion

**Visible child and same-child follow-up: SUPPORTED.
Exact v5 request/assistant lineage: NOT_SUPPORTED.**

Demonstrated on a real isolated host:

- `subagent` created a visible child with `parentID` equal to the parent.
- The child used the `probe-reviewer` agent and the expected model.
- A second `session.prompt` with an explicit `messageID` in the **same child**
  produced a second terminal assistant and idle marker.
- The child history contains user, assistant and idle records.
- Every assistant record had these fields:
  `id, time, type, agent, model, content, finish, rawFinish, cost, tokens`.
- **No assistant record contained `parentID`.**
- `session.generate()` returned text and added **0** messages to session
  history.

The v5 reviewer capture requires `response.parentID === requestMessageID`.
OpenCode v2 does not expose that field. A v2 replacement would have to use a
new history-chain assurance (inbox delivery → user message → step events →
assistant → idle marker), and would need a new evidence generation. It must not
be labeled v5 or `host_message_validated`.

The same child is still usable for a follow-up, so the transport shape is
viable; the exact v5 provenance claim is not.

### `subagent` contract

**Host behavior: SUPPORTED. Required FlowGuard rejection: not yet implemented.**

The installed host accepted:

- caller-supplied `sessionID` reuse of an existing child;
- caller-supplied `model: probe/probe#chosen`, which reached the provider as
  `reasoning_effort: high`;
- `background: true`, which returned a running child and later completed it.

These are host capabilities, not acceptable governance behavior. The v2
adapter must reject caller-selected children, model overrides and background
reviewer execution, or validate them against exact dispatch authority before
allowing them.

### Model and provider wire fidelity

**SUPPORTED.**

With a chosen variant, the final provider request for:

- parent,
- reviewer child,
- same-child serialization

all contained the selected model, `reasoning_effort: high` and
`max_completion_tokens: 8192`.

With the default model, the request had no `reasoning_effort` and the same
native output limit. This proves that effective model/variant settings can be
observed at the final wire request; it does not prove the governance adapter
already preserves them.

### Output continuation and step ceiling

**Host behavior: SUPPORTED. Reviewer acceptance policy: NOT_VERIFIED.**

- One `finish: length` step: host inserted a synthetic continuation message,
  made a second assistant step, ended with `stop`, and idle outcome
  `succeeded`.
- Three consecutive `finish: length` steps: host retained all three assistant
  messages with `finish: length`, inserted two synthetic continuations, and
  ended with an **idle outcome `failed`**. `session.wait()` still returned
  normally.
- Step ceiling: with `steps: 2`, the final request used `tool_choice: none`;
  the tool definitions were still present in the context, the final assistant
  ended with `stop`, and the history contained two assistant steps plus idle.

A final `stop` after an internal continuation is not proof of an unmodified
review. FlowGuard must inspect the whole assistant history and idle outcome,
and must classify the enforced final step as exhausted rather than accepted.

### Mandate instruction activation

**SUPPORTED.**

The context hook exposed `core/instructions` in
`system.metadata.experimental.instructions`; the probe mandate token appeared
verbatim in that source. This provides a real host-side check for #724:
missing or unresolved FlowGuard instructions can be blocked instead of being
treated as active.

## Mandatory gate summary

| Gate                                           | Status                            | Evidence                                                                        |
| ---------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------- |
| Backup/restore                                 | PASS                              | 10.9 GB SQLite backup + restore; integrity `ok`; 31/31 tables                   |
| Desktop backend identity                       | PASS                              | server PID 37045 child of Desktop PID 36822; version 2.2.4; no sessions touched |
| Plugin discovery                               | PASS                              | host log + `setup:ready`                                                        |
| Full plugin activation                         | PASS                              | tools and commands registered                                                   |
| Plugin setup failure fail-closed               | **NOT_SUPPORTED**                 | host stayed alive with no hooks                                                 |
| V1 tool file compatibility                     | **NOT_SUPPORTED**                 | `.opencode/tools/legacy-probe.ts` absent from tool lists                        |
| Local file/shell/code-mode fences              | PASS                              | no file/marker/network side effect                                              |
| MCP preventive fence                           | **NOT_VERIFIED**                  | MCP connected but tool not advertised                                           |
| Provider-executed tool fence                   | **NOT_VERIFIED**                  | fixture did not produce stable completion; local hook is absent by source       |
| Command shell-block prevention                 | **NOT_SUPPORTED**                 | marker created before prompt admission                                          |
| Host command origin                            | **NOT_SUPPORTED**                 | no authoritative origin field in v2 path                                        |
| Visible reviewer child + same-child follow-up  | PASS                              | `parentID`, explicit follow-up, idle markers                                    |
| v5 request/assistant lineage                   | **NOT_SUPPORTED**                 | no `parentID` on v2 assistant; `generate` adds no history                       |
| `subagent` identity/model/background controls  | Host accepts; adapter must reject | separate contract probe                                                         |
| Parent/reviewer/serialization model wire       | PASS                              | final provider requests                                                         |
| `finish:length` and step-ceiling host behavior | PASS as host behavior             | 1×/3× and `steps:2` probes                                                      |
| Governance handling of length/step             | **NOT_VERIFIED**                  | no production adapter yet                                                       |
| Mandate source activation                      | PASS                              | `core/instructions` includes probe token                                        |

## Decision

**NO-GO for the unchanged #1169 acceptance contract.**

This is not a claim that v2 is impossible. The probe found viable mechanisms
for the visible child, same-child follow-up, model/variant fidelity, local
tool fences, mandate-source validation and backup/restore. The blockers are
specific:

1. **Command origin** has no host-authoritative signal. Automatic capacity
   unlock must not be implemented. The issue must either accept an
   operator-authorized recovery action or keep the lock closed.
2. **Exact v5 request lineage** is unavailable because v2 assistant messages
   have no `parentID`. A new history-chain evidence generation would be a
   weaker, explicitly versioned contract and needs its own review.
3. **Shell blocks in native Markdown commands** run before prompt admission and
   outside tool hooks. FlowGuard-owned commands must avoid them or move to a
   plugin command path; arbitrary project commands remain a host limitation.
4. **MCP and provider-executed tools** were not proven preventively covered.
   They need either a host-supported containment mechanism or an explicit
   `NOT_SUPPORTED` limitation.
5. **Plugin setup failure is fail-open in the host.** Install/doctor must
   detect missing activation; runtime cannot enforce without loaded hooks.

No production migration was started. The v1 baseline, `TESTED_OPENCODE_HOST_VERSION`
and existing v1 tests remain unchanged.

## Reproduction and artifacts

- Probe code: `scripts/opencode-v2-probe/`
- Probe README: `scripts/opencode-v2-probe/README.md`
- Raw local evidence (not committed): `scripts/opencode-v2-probe/evidence/`
- Sanitized fixtures: `scripts/opencode-v2-probe/fixtures/`
- Backup retained by the run; the temporary path is recorded in the raw
  backup report, not in this committed report.

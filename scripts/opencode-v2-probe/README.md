# OpenCode v2 Phase 0 host probe

This directory is an **installed-artifact** probe for the OpenCode v2 host
guarantees required by issue #1169. It does not import FlowGuard production
code and it does not change the v1 SDK baseline, `TESTED_OPENCODE_HOST_VERSION`
or the repository's production runtime.

## Scope

- Run against a disposable project with an isolated `HOME`, config, data,
  state, cache and SQLite database.
- Use a constructed environment, not inherited `process.env`. NODE/BUN options,
  provider credentials, host configuration/server overrides, proxies and Git
  redirection are not copied. PATH and shell remain trusted fixture dependencies.
- Before loading a project, reject detected ancestor `opencode.json(c)`,
  `.opencode` and `AGENTS.md`, system configuration and macOS managed preference
  files (including the actual OS user's profile). Check both alias and real-path
  ancestry, then use canonical paths. No operator settings are deleted/overridden.
- Pin `opencode v2.2.4`, both SDK package versions and the server-reported
  version; record binary SHA-256 and package-manifest digests. Check reported
  mutable paths remain inside the fixture root. This is not a dependency sandbox,
  egress firewall, signed build attestation or same-user security boundary.
- Scoped `.gitattributes` preserves LF for the byte-bound libraries, plugins and
  executables even on Windows checkouts; the evidence guard never normalizes
  source bytes to excuse a mismatch. This does not certify Windows host isolation.
- Spawn a private `opencode serve` process; never attach to the operator's
  shared background service.
- Use a deterministic OpenAI-compatible local provider for parent, reviewer and
  serialization requests.
- Record actual side effects and negative paths. A hook throw without a
  side-effect probe is not evidence.
- The focused P0 follow-up is
  `docs/host-probes/opencode-v2/2026-10-30-2.2.4/P0_SECURITY_GATE.md`.
- Keep the raw JSON evidence under `evidence/` (gitignored). The committed
  report contains only sanitized facts.

## Prerequisites

- OpenCode 2.2.4 Desktop and CLI.
- Node.js 22+.
- `sqlite3` for the backup/restore probe.

The probe itself has its own package and lockfile:

```sh
cd scripts/opencode-v2-probe
npm ci
```

## Run

### Current bounded Phase-02 sequence

Read the [probe threat model](../../docs/trust-boundaries.md#opencode-v2-phase-02-probe-threat-model-1169)
and [gate matrix](../../docs/host-probes/opencode-v2/phase0-contract-gates.md)
before running a probe. Backup facts must be inspected, not inferred from exit 0;
do not repeat a multi-GB backup unnecessarily. Backups and restored copies contain
credentials and live lock/service metadata: keep private and do not install that
metadata into the operator environment. Structural SQLite integrity/row counts
are not semantic replay or application restore acceptance.

```sh
# Use the repository's .node-version; the host subprocess receives a fresh env.
umask 077
npx vitest run --project scripts scripts/opencode-v2-probe/isolation.test.ts scripts/opencode-v2-probe/native-parity.test.ts
FG_PROBE_OUT=scripts/opencode-v2-probe/evidence/phase02/p0-00-canonical \
  node scripts/opencode-v2-probe/probes/p0-native-parity.mjs
FG_PROBE_OUT=scripts/opencode-v2-probe/evidence/phase02/p0-01 \
  node scripts/opencode-v2-probe/probes/p0-command-origin.mjs
```

`p0-native-parity` compares an absent plugin with `plugin/passive.js`: no
registrations, instructions, permissions or provider transforms. It checks native
tool schemas, the observed catalogue/variants and agent permissions, effective
mock `high` reasoning, real shell output and normal answer completion. Only exact
disposable-root paths are normalized for comparison; raw data remains private.
This is a mechanism fixture, **not installed FlowGuard INACTIVE acceptance**.
It does not exhaustively execute every model, tool or UI surface.

`p0-command-origin` attempts the same plugin command through the SDK and a
model-driven native shell, using a deliberately same-process-accessible fixture
credential. Successful agent admission refutes human-origin inference from that
API/callback; it cannot certify or disprove every independent operator channel.
The command's exit 0 means the negative observation reproduced, **not a P0-01
PASS**. No governance approval/activation is executed. Real TUI/Desktop human
interaction remains NOT_VERIFIED.

Harness modes are `absent`, `passive`, and the default `diagnostic`. Diagnostic
mode registers the historical instrumentation and reviewer; do not use it as the
INACTIVE baseline. `host.activate()` loads the location fixture; it is **not**
trusted `StartGovernance`. Missing/malformed journals and MCP connection failures
surface explicitly. Startup failure attempts owned-child/provider/root cleanup;
normal close is idempotent. This does not prove cleanup of all host-managed
grandchildren after forced termination.

### Historical observation runner (not current acceptance)

From the repository root:

```sh
# 1. Backup and restore gate. Keeps the backup for operator inspection.
FG_PROBE_KEEP_BACKUP=1 \
FG_PROBE_BACKUP_REPORT=scripts/opencode-v2-probe/evidence/backup/report.json \
node scripts/opencode-v2-probe/backup-restore.mjs

# 2. Historical observation probes. The backup is intentionally skipped because it was
#    already verified above and is large.
node scripts/opencode-v2-probe/run-all.mjs --skip-backup
```

Individual probes can be run directly, for example:

```sh
node scripts/opencode-v2-probe/probes/fences.mjs
node scripts/opencode-v2-probe/probes/reviewer-lineage.mjs
node scripts/opencode-v2-probe/probes/model-wire.mjs
```

`run-all.mjs` is not the Phase-02 acceptance sequence. Its historical
`p0-inactive-host` case tests provider-removal lockdown, not ADR-010 INACTIVE
noninterference. A historical probe's `passed` can mean an observation reproduced
(including missing lineage), not that the current security gate passed. The
shared harness has changed; reruns are new observations, not historical bytes.

## Evidence layout

`evidence/<probe>/report.json` is written by each probe. The summary is written
to `evidence/summary.json`. These files are ignored by git because they can
contain local temporary paths and provider request bodies.

The current bounded Phase-02 report lives at:

`docs/host-probes/opencode-v2/2026-10-31-2.2.4-phase02/README.md`

Historical report (bytes retained unchanged):

`docs/host-probes/opencode-v2/2026-10-30-2.2.4/README.md`

## What is deliberately not done here

- No v2 production adapter.
- No changes to `src/integration`, `src/state`, `src/cli` or existing v1 tests.
- No claim that a successful loader is a GO.
- No claim that a local negative path proves provider-executed or MCP coverage.
- No use of the operator's live sessions or database in the isolated probes.

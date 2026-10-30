# OpenCode v2 Phase 0 host probe

This directory is an **installed-artifact** probe for the OpenCode v2 host
guarantees required by issue #1169. It does not import FlowGuard production
code and it does not change the v1 SDK baseline, `TESTED_OPENCODE_HOST_VERSION`
or the repository's production runtime.

## Scope

- Run against a disposable project with an isolated `HOME`, config, data,
  state, cache and SQLite database.
- Spawn a private `opencode serve` process; never attach to the operator's
  shared background service.
- Use a deterministic OpenAI-compatible local provider for parent, reviewer and
  serialization requests.
- Record actual side effects and negative paths. A hook throw without a
  side-effect probe is not evidence.
- The focused P0 follow-up is
  `docs/host-probes/opencode-v2/2026-10-30-2.2.4/P0_SECURITY_GATE.md`.
- The patched-host experiment and its adversarial regression probe are in
  `docs/host-probes/opencode-v2/2026-10-30-2.2.4/host-enforcement/` and
  `scripts/opencode-v2-probe/probes/p0-host-enforcement.mjs`.
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

From the repository root:

```sh
# 1. Backup and restore gate. Keeps the backup for operator inspection.
FG_PROBE_KEEP_BACKUP=1 \
FG_PROBE_BACKUP_REPORT=scripts/opencode-v2-probe/evidence/backup/report.json \
node scripts/opencode-v2-probe/backup-restore.mjs

# 2. All host probes. The backup is intentionally skipped because it was
#    already verified above and is large.
node scripts/opencode-v2-probe/run-all.mjs --skip-backup
```

Individual probes can be run directly, for example:

```sh
node scripts/opencode-v2-probe/probes/fences.mjs
node scripts/opencode-v2-probe/probes/reviewer-lineage.mjs
node scripts/opencode-v2-probe/probes/model-wire.mjs
```

## Evidence layout

`evidence/<probe>/report.json` is written by each probe. The summary is written
to `evidence/summary.json`. These files are ignored by git because they can
contain local temporary paths and provider request bodies.

The committed report lives at:

`docs/host-probes/opencode-v2/2026-10-30-2.2.4/README.md`

## What is deliberately not done here

- No v2 production adapter.
- No changes to `src/integration`, `src/state`, `src/cli` or existing v1 tests.
- No claim that a successful loader is a GO.
- No claim that a local negative path proves provider-executed or MCP coverage.
- No use of the operator's live sessions or database in the isolated probes.

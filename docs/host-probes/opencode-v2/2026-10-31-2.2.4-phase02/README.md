# Phase 02: bounded feasibility checkpoint — OpenCode 2.2.4

**Decision: NO-GO for security-critical product implementation and merge.**
This report completes neither Phase 02 nor Issue #1169. All work remains in
Draft PR #1190 on `feat/1169-opencode-v2-port`. Production runtime and historical
2026-10-30 evidence are unchanged. The actual production simplification required
by ADR-010 is still outstanding.

## Authorities and exact scope

- [ADR-010](../../../decisions/010-host-neutral-opt-in-governance.md),
  [gate matrix](../phase0-contract-gates.md),
  [canonical probe threat model](../../../trust-boundaries.md#opencode-v2-phase-02-probe-threat-model-1169).
- Runner: Node 22.22.2; macOS private `opencode serve`, not the shared service,
  not Desktop and not an interactive TUI. Installed host and both SDK packages:
  **2.2.4**. Host binary SHA-256:
  `03fc30769f28dd346d2279baae77ef71308175cd49eb7a5be339d3860ee99ec1`.
- [Sanitized facts](./facts.json) bind the exact probe-source bytes and private
  raw evidence digests. Digests identify observations; they do not authenticate a
  malicious host, make private evidence publicly reproducible, or certify a
  signed dependency supply chain. SDK digests in private reports cover package
  manifests, not the entire installed dependency tree.
- Official living docs consulted **2026-10-31**:
  [configuration](https://opencode.ai/v2/docs/config),
  [instructions](https://opencode.ai/v2/docs/instructions),
  [CLI](https://opencode.ai/v2/docs/cli),
  [plugin loading](https://opencode.ai/v2/docs/build/plugins),
  [server hooks/commands](https://opencode.ai/v2/docs/build/plugins/server).
  Their descriptions are not version-pinned security evidence.

## Backup prerequisite

The retained backup and disposable restore both report SQLite integrity `ok`;
the observed counts in 31 tables match. The report has no warnings. No live
operator session/configuration was modified by these host probes.

**NOT_VERIFIED:** semantic replay of sessions, attachments, pending work and
external evidence. Counts were taken from a live database after its backup, not
under a cross-file/application quiescence guarantee. A row-count match does not
prove equivalent contents. Config/state copies contain sensitive credentials
and lock/service metadata; do not publish or activate them. The fresh backup's
paths remain only in the private report; no restore into live paths was run.

## Infrastructure findings and changes

The inherited harness could not establish absence/INACTIVE parity: it always
installed an instrumenting plugin and reviewer, inherited `process.env`, set a
historical password alias, and could lose journal failures. Ambient
`NODE_OPTIONS` was actually set; its value was not copied into the host fixture.

The current harness constructs its environment, isolates mutable host paths,
uses one canonical temporary root, checks reported paths and version pins,
records binary/manifest digests, and rejects detected ancestor/system/managed
config/instruction discovery. All **35 candidate paths** checked per final parity
case were absent. It neither deletes nor overrides operator machine settings.
Discovery is a snapshot, not race-free OS containment. Dependencies are symlinked
to installed probe packages; egress and same-user file/process access are not
sandboxed. Windows fixture isolation is explicitly unverified/blocked.

Modes now distinguish absent, passive and diagnostic plugins. Journal failures
surface; MCP readiness timeout no longer silently counts as connected. Startup
failure attempts resource cleanup, and normal owned-child close is idempotent.
Unit tests cover contamination, malformed/missing journals, escaping paths,
wrong host version and graceful/forced owned-child termination. Installed-host
startup-failure and all-grandchild forced-cleanup acceptance remain NOT_VERIFIED.

## P0-00 — native mechanism fixture, not product PASS

Final observation: **2026-10-31T10:01:25.791Z**.

Both cases use the same disposable fixture configuration: static local capture
provider, wildcard allow permission for the shell experiment, default native
plugins enabled, and no provider-policy deny. This is not a comparison against
every out-of-box or operator-specific host configuration, and the fixture's
allow rule is not installed into any user project.

| Observation                                              | Plugin absent           | Passive fixture loaded  |
| -------------------------------------------------------- | ----------------------- | ----------------------- |
| Diagnostic hooks/tools/reviewer/mandates registered      | No                      | No                      |
| Passive setup journal entry                              | 0                       | Exactly 1               |
| Observed native tool schemas                             | 12; equal between cases | 12; equal between cases |
| Model catalogue / variants                               | 9 entries; equal        | 9 entries; equal        |
| Agents / permission definitions                          | 7; equal                | 7; equal                |
| Real native-shell file effect and tool result            | Observed                | Observed                |
| Normal assistant `stop` with expected answer             | Observed                | Observed                |
| Selected `probe/probe#chosen` effective mock wire effort | `high`                  | `high`                  |
| Owned host/provider/root cleanup                         | Completed               | Completed               |

Only the **exact per-case disposable-root path** is replaced for structural
comparison (native plan permissions contain it). Raw paths remain in private
evidence. No permission, model variant or arbitrary external path is discarded.
Native selectable models are not filtered; only the deterministic mock model was
executed. This is not live certification of all catalogue entries.

**SUPPORTED:** this precisely bounded absent/passive fixture comparison.
**NOT_VERIFIED:** installed FlowGuard INACTIVE, setup-failure native parity,
every native command/tool/model, compaction, Desktop and TUI. A passive loader is
not FlowGuard. Consequently **P0-00 as a whole remains NOT_VERIFIED**.

### Failed/superseded attempts retained privately

1. First attempt returned failure on a double setup: `/var/...` and
   `/private/var/...` addressed the same fixture through different spellings.
   Canonical paths and explicit API locations removed that ambiguity. This
   observation is not generalized into a proven host identity defect.
2. Next comparison rejected differing native plan-permission paths in the two
   distinct roots. Inspection found that exact fixture-root difference, not a
   changed permission. The comparator now normalizes only that root; it retains
   schemas, permission effects and external paths and has negative tests.
3. A successful intermediate run was superseded after source cleanup changes;
   final reports above were rerun and checked against current source digests.

Failed observations are not relabelled PASS, and the immutable historical report
directory was not changed.

## P0-01 — concrete command-origin counterexample

Final observation: **2026-10-31T10:01:23.206Z**.

- An SDK call executed the registered plugin command in one receiver session.
- A model response invoked the real native shell in another fixture session.
  That shell used the deliberately accessible fixture password to call the same
  command API in a separate receiver. The shell completed and the command
  callback was observed with the expected text/session in both cases.
- Both callbacks exposed only `delivery`, `prompt`, `sessionID`; neither supplied
  independent human-origin proof. No FlowGuard start, decision or approval ran.

**NOT_SUPPORTED:** inferring human origin from this SDK/command callback alone
under the demonstrated agent-accessible-credential model. This does not show
that every real deployment exposes that exact password or rule out an actual
independent operator channel. Merely moving a reusable bearer token into another
same-user CLI/file does not establish such independence.

**BLOCKED:** P0-01 acceptance and security-critical activation/approval/recovery
implementation pending proof of an independent action/scope/generation-bound,
non-replayable operator channel. Real human TUI/Desktop origin, credential
separation, replay/expiry/concurrent reuse tests remain NOT_VERIFIED.

## Reproduction and remaining gates

Local checks on this checkpoint (Node 22.22.2): `npm run test:scripts`
**19 files / 270 tests PASS**; `npm run test:architecture` **51 files / 538 tests
PASS**; `npm test` **694 files / 12,400 tests PASS, 2 skipped**;
`npm run check`, `npm run lint:strict`, `npm run check:format`,
`npm run check:unused-dependencies`, `git diff --check`, and
`npm run check:doc-drift` (including build and 17 documentation tests) **PASS**.
Source-byte binding tests detect a stale current report; they do not rerun a
host or convert diagnostics into product evidence. Future probe changes need a
new dated observation and an updated current binding test, not rewritten
historical facts. Full local test and pushed-SHA CI outcomes are recorded in the
PR checkpoint report; older green CI does not certify this change.

The first pushed checkpoint (`c124bbac`) failed `scripts-windows`: Git's CRLF
checkout changed the source-byte hash. Reproducing LF→CRLF locally gives exactly
the received Windows hash. Scoped `.gitattributes` now preserves LF for probe
libraries, plugins and probe executables, with an actual autocrlf-enabled Git
checkout regression test. Evidence hashes were not changed or normalized, and
the byte-binding test still runs on Windows. The Unix-only isolation suite is
separate and remains explicitly skipped there. The initial red CI is not counted
as a passing run.
The full local unit/integration run preceded this checkout-only correction;
product and observed probe-source bytes did not change. Final-SHA CI outcomes
are reported separately in the PR.

From the repository root, use Node from `.node-version` and install the separate
probe package using its lockfile as described in the
[runner guide](../../../../scripts/opencode-v2-probe/README.md). Inspect an existing
fresh backup before deciding to repeat it.

```sh
umask 077
npx vitest run --project scripts scripts/opencode-v2-probe/isolation.test.ts scripts/opencode-v2-probe/native-parity.test.ts
FG_PROBE_OUT=scripts/opencode-v2-probe/evidence/phase02/p0-00-final \
  node scripts/opencode-v2-probe/probes/p0-native-parity.mjs
FG_PROBE_OUT=scripts/opencode-v2-probe/evidence/phase02/p0-01-final \
  node scripts/opencode-v2-probe/probes/p0-command-origin.mjs
```

Use a new output directory for new observations. Command-origin exit 0 means
the negative candidate result reproduced, **not operator authorization PASS**.
The historical `run-all.mjs` is not the current acceptance pipeline.

**NOT_VERIFIED in this checkpoint:** P0-02-H session/worktree/child identity,
lifecycle/restart/races; fresh MCP advertised-tool, provider-hosted action,
native shell-interpolation and exact V2 reviewer-provenance probes; product
mutation (`npm run mutation`), G-04/G-05, installed FlowGuard Desktop/CLI E2E and
final acceptance on the actual merge candidate against current `develop`.
Historical observations remain historical, not fresh proof. Next work is bounded
P0-02-H mechanism probing, followed by prevention/reviewer evidence; no production
security implementation may infer missing guarantees.

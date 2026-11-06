# P0-00: packed-installed INACTIVE parity

2026-11-04, PR #1190. **Bounded CLI/server PASS on Linux, macOS and Windows
with OpenCode 2.2.4; not Desktop or whole-PR acceptance.** Windows executed
all 65 cases on the current-build artifact (2 mixed + 28 repo + 28 global +
7 original, 0 failed). R4 remains technically `NOT_SUPPORTED` under the public
host contract; the 2026-11-06 operator decision accepts it as a documented
trusted-plugin limitation. No ACTIVE-V2 release follows from this result.

## Final Windows/CLI-server diagnostic closure on `2f4aa06d`

[Acceptance run 41855491592](https://github.com/koeppben23/governed-runtime/actions/runs/41855491592)
on `2f4aa06d5791dab9cf943c4f19175525f7d21430` passes **65/65 each on Linux,
macOS and Windows**. The Windows reports execute 2 mixed, 28 repo, 28 global
and 7 original cases; their passed-name union contains exactly 65 unique cases,
with no missing or additional case relative to Linux's full report. Filtered
entries in individual shard JSON are not missing acceptance cases.

All platform bootstrap identities match the shared tarball/checksum SHA-256
`5e5480b43aad21f656830a0453c8a54c88a07a9593f5355ee04fef0561375ec3`.
Its embedded merge build is `70fc3e0461c96fa665965d2adc7c1cff7e97560e`,
built `2026-11-04T15:15:27.096Z`. Windows installer calls complete in
**27,133–61,224 ms**. The preceding runner-temp-only correction also passed the
complete matrix in [run 41853631296](https://github.com/koeppben23/governed-runtime/actions/runs/41853631296)
on `2384f282`, package SHA-256
`c1a0b2b9bcdb7e29809974e3c7c9dfec838895f2fbaeb0eefa10fb64119012bc`.

[Required CI 41855408259](https://github.com/koeppben23/governed-runtime/actions/runs/41855408259)
on the same `2f4aa06d` head is **PASS on attempt 2**. All five normal Windows
jobs pass: scripts, critical state/hooks/recovery, architecture, install-verify
and install/doctor. Attempt 1 remains **FAIL**: integration PERF measured
**182.467809 ms against the unchanged <150 ms limit**; macOS install was not
acquired by a hosted runner, with no assigned runner or executed steps. GitHub's
annotations explicitly report macOS ARM64 capacity constraints. One unchanged
failed-job rerun passed PERF, macOS install and the gate. That rerun does not
establish the initial PERF failure's cause or make it a proven flake. An initial
watch reconnect failed with GitHub API HTTP 502; that was not a test result.

**Closed scope:** P0-00's installed CLI/server parity matrix and the Windows
fixture-location correction, including the broader CI preparation. No further
harness optimization is required absent a new counterexample. The release
publishing workflow was not triggered; its Windows-smoke preparation is guarded
by source tests, while CI executes the same install-verify smoke file.
Desktop 2.2.4, untested host boundaries, full ACTIVE workflow, R4 and final
merge-gate enforcement remain separate open acceptance items. The OS-level
cause of slow system-temp unpack and the earlier non-reproduced global
discovery error remain unattributed, not product fixes claimed by this closure.

## Initial 56-case checkpoint: product and installation identity

- Node `22.22.2`; `/opt/homebrew/bin/opencode` reports `opencode v2.2.4` and
  the native fixture enforces that exact version.
- Built product: `c454ed551d46a3aaaf76b665eee00f0b49aebd9b`, version
  `2.0.0-tp.2`, build timestamp `2026-11-04T06:35:08.208Z`.
- Packed artifact: `flowguard-core-2.0.0-tp.2.tgz`, SHA-256
  `fbf1bda3592401ca674e8281869e92c022efe15d3dd0dd0a09f3e7ccb4a852aa`.
  This is the local artifact exercised below, not a published release.
- The test bootstraps the CLI from those packed bytes, invokes its real
  checksum-verified installer and loads the generated canonical plugin wrapper.
  The installed plugin bytes are compared with the packed bootstrap bytes.
  No workspace-`dist` plugin wrapper or replacement product is used in the
  installed arm. `FLOWGUARD_TARBALL` can select a supplied artifact with its
  adjacent `checksums.sha256`; otherwise the test runs `npm pack` after build.

## Compared arms and controls

`src/cli/opencode-inactive-installed.smoke.test.ts` compares separate private
absent and installed hosts for each of four combinations:

| Install scope               | Project |
| --------------------------- | ------- |
| Repo                        | Git     |
| Repo                        | Non-Git |
| Global (isolated test home) | Git     |
| Global (isolated test home) | Non-Git |

Both arms use the same deterministic OpenAI-compatible fixture provider and
customer instructions/configuration. The product is positively observed as one
loaded `flowguard` plugin in the installed arm and absent in the other. No
activation RPC, `/start`, policy/state seed, child enrollment or observer plugin
supplies governance authority. Host plugin load status `active` is not governance
activation. No FlowGuard workspace/hydration is created by these operations.

Provider payload comparisons retain native instructions and tool definitions.
Only the known fixture root paths (including their canonical form) and configured
loopback provider URL are substituted to compare different temporary hosts.
No mandate, timestamp, native option or instruction content is stripped. The
sole catalogue exception is the inert `flowguard_help` definition expressly
allowed by [ADR-010 D2](../../decisions/010-host-neutral-opt-in-governance.md#d2-activation-is-explicitly-opt-in-and-scope-bound);
its successful execution is separately checked to create no workflow or
productive tool publication. This is not a claim of byte-identical entire tool
catalogues including that allowed affordance.

## Executed contracts

The owning suite passes **56/56, 0 failed, 0 skipped** (14 contracts per
scope/project combination; 50.67 seconds):

- Complete native tool definitions and actual provider context compare equal
  after only the substitutions above and removal of the allowed help definition.
  Customer `CUSTOM.md` and root `AGENTS.md` instructions remain present;
  customer config and `AGENTS.md` bytes remain unchanged.
- The complete available model identity/variant catalogue compares equal with
  the same native bundled catalogue input. Full fixture-model settings also
  compare equal. Unset, `chosen`/high and `quiet`/low native effort selections
  preserve the absent host's provider-wire model, effort and token budget.
  This samples selection behavior; it does not certify every remote provider.
- Native `shell` and `edit` actually modify the target and complete normally.
- Native `general` subagent execution completes, its child actually modifies the
  target, and its initial provider context/native tools compare equal.
- A native session permission `deny` still refuses shell before any effect, with
  the same terminal error. `ask` still creates a pending native permission request
  before any effect and executes only after the explicit native `once` reply.
- Native transient generation, compaction and its normal continuation retain
  equivalent provider payloads; a host restart retains INACTIVE context/tools
  without implicit hydration.
- Native `session.shell` still executes its real effect independently of model
  tool calls. A model-supplied `flowguard_hydrate` attempt fails without activation,
  hydration or productive tool exposure. Explicit help remains inert.

No production guard, activation authority, installed mandate, schema, policy or
reviewer path was changed. The existing workspace-loaded seven-case INACTIVE
suite also passed before this work; the new suite supplies the missing packed
installation comparison rather than claiming a new functional repair.

### Catalogue timing and initial test failures

An initial unpinned full-catalogue comparison differed on two remote OpenCode
free-model entries. The pinned host
[`models-dev.ts`](https://github.com/anomalyco/opencode/blob/45898d0f8569225eb1ddb4ee13f8581b34dff311/packages/core/src/models-dev.ts)
populates from its bundled snapshot while starting an asynchronous live refresh;
separate hosts need not have the same catalogue input at observation time.
This did not establish a FlowGuard filter. The final fixture sets
`OPENCODE_DISABLE_MODELS_FETCH=1` in **both private host environments**, retaining
the complete bundled catalogue plus the same fixture model, without adding any
model/provider filter or changing product configuration. The pinned
[`server-process.ts`](https://github.com/anomalyco/opencode/blob/45898d0f8569225eb1ddb4ee13f8581b34dff311/packages/cli/src/server-process.ts)
wires that flag to catalogue refresh. Live remote-discovery parity is not proved
by the resulting deterministic comparison.

Other initial fixture failures were corrected without product changes: distinct
temporary roots/provider ports, the native two-request compaction lifecycle, and
the help tool's required `view` argument. None is reported as a fixed product
defect or silently ignored.

## Counterprobe reconciliation and live publication follow-up

The apparently contradictory results refer to different product implementations:

1. `2a2abe170d24218a296ace7b8cc18103fc55eac7` added the five original
   `opencode-inactive-parity.smoke.test.ts` comparisons. The documented failures
   were real: Git-backed native effects were refused, non-Git prompts failed,
   and productive FlowGuard tools appeared before activation. Those dated results
   are not changed by this follow-up.
2. **The product repair predates this P0-00 test work:**
   `3a274edfc97b894a2389731b3636324de7795c4d` introduced the canonical activation
   resolution before workflow/Git/runtime lookup in `plugin.ts`. Verified INACTIVE
   returns before those gates. The same commit added `createNativeToolCatalogue`
   in `plugin-native-tools.ts`: setup publishes only help, ACTIVE publication is
   explicit, and context/compaction/generate filter productive tools per request.
   It retained the first five assertions and added native-subagent/compaction
   cases. This source diff, not a different permission setting or a claimed new
   product fix in `4182c5de`, explains the changed behavior.
3. The original suite now uses the real packed CLI/installer through the existing
   packed-install helper. Its expected file effects, completed statuses and
   catalogue equality (excluding only permitted help) are unchanged. It positively
   verifies loaded/absent product identity and seeds no workflow or activation.
   To keep the Windows E2E runtime bounded, the suite performs **one real packed
   installation per run** as a template and copies that installed `.opencode`
   tree into each case; the installed comparison suite still runs the real
   installer separately for repo/global and Git/non-Git arms. Both suites were
   rerun together against the **same supplied tarball**, not independently rebuilt
   workspace wrappers.

### Exact executed follow-up artifact and outcomes

- Product build: `4182c5de8a8341d24f150f7a70d532e81c63be37`, version
  `2.0.0-tp.2`, built at `2026-11-04T06:51:53.412Z`.
- Tarball SHA-256:
  `8dbc0de087f1fb4156c107bc47d976a56734c808ee50f2a60e23c7756093c51a`.
  Both suites logged this identical digest and embedded build identity.
- macOS/OpenCode 2.2.4/Node 22.22.2: **65 passed / 0 failed / 0 skipped** across
  two suites (88.81 seconds): seven original-suite cases plus 56 installed matrix
  cases plus two installed mixed-session cases (repo/global).

Each mixed case leaves model fetching enabled. A real native `/start` activates
only A and writes exactly one `governance:activated` audit with `host_command`
source; it is not verified-human provenance. B submits concurrently with Start.
After live productive-tool publication, location reload and server restart,
concurrent A/B requests prove A has the complete canonical productive catalogue
and phase mandates, while B retains its complete baseline definitions **including
help** and identical system messages. B also completes a real shell effect,
transient generation and compaction without productive-tool/mandate leakage.
Its canonical workflow resolution stays absent; A's activation audit stays single.
No product authority, gate, reviewer runtime or writer is replaced or seeded.

These cases exercise live **FlowGuard registry publication/restoration**, not a
deterministically observed remote models.dev refresh event. Full live remote
model-catalogue refresh parity remains NOT_VERIFIED. Shared-resource drift and
every P0-07 race are not established by these bounded mixed-session controls.

### Hosted and Desktop boundaries

CI run [41787499372](https://github.com/koeppben23/governed-runtime/actions/runs/41787499372)
on exact head `4182c5de8a8341d24f150f7a70d532e81c63be37` completed successfully
after one unchanged failed-job rerun. The first attempt failed `integration-perf`
at 153.77 ms against the unchanged <150 ms limit; a rerun PASS does not establish
the initial failure's root cause. Smoke, independent-review E2E and install/verify
on all three operating systems passed. These older jobs are not the new Windows
native-parity matrix.

The dedicated `opencode-parity.yml` acceptance workflow runs **these same two
suites** on Linux/macOS/Windows. It is manually dispatchable, scheduled, or triggered by the
`run-parity-acceptance` PR label, not a required pull-request gate: the full installed matrix is acceptance evidence,
while the PR gate keeps the faster unit/integration/architecture checks. Its
`build` job creates one tarball/checksum artifact shared by all runners, with
exact native executable/version resolution and JSON results. Shell-free npm
invocation uses Node plus `npm_execpath`, rather than assuming a Windows `.cmd`
can be passed to `execFileSync`. Matrix success must be observed; workflow
wiring alone is not platform acceptance.

**First cross-platform run, code head `776053846d2172d22a7d31a12a2691fa935eac12`:**
[CI run 41790845872](https://github.com/koeppben23/governed-runtime/actions/runs/41790845872)
uses one package with independently checked SHA-256
`1ecca9459cfdcffc39399cbbfdb057a3b5ba16ecb1a3e21e34e4fb396450723b`.
Its embedded build SHA is the CI merge tree
`5bbdc3c4a7892e7b1b7cbdc5b20f15e8c68a47ad`, whose parents are base
`03a6a278129f8c1e101276ef992960f0c381116d` and that exact code head; the
build timestamp is `2026-11-04T07:15:12.453Z`. The merge build is not mislabeled
as a directly built branch commit.

Downloaded runner JSON reports establish:

| Runner                            | Executed result                                                                                |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| `ubuntu-latest`                   | 65 passed, 0 failed, 0 skipped                                                                 |
| `macos-latest`                    | 65 passed, 0 failed, 0 skipped                                                                 |
| `windows-latest`, first attempt   | Both bootstrap `beforeAll` hooks time out at 300,000 ms; 0 passed, 65 unexecuted/pending       |
| `windows-latest`, unchanged rerun | Both bootstrap `beforeAll` hooks again time out at 300,000 ms; 0 passed, 65 unexecuted/pending |

The first workflow attempt therefore fails its required gate; all other jobs
pass. The Windows failure occurs before either helper returns a package identity
or any native conformance case executes. Its root cause is **NOT_VERIFIED**;
the available log does not prove npm rejection, infrastructure noise or a product
regression. The unchanged failed-job rerun (attempt 2, Windows job
[`126448686373`](https://github.com/koeppben23/governed-runtime/actions/runs/41790845872/job/126448686373))
fails the same two hooks; its downloaded JSON artifact `13304710164` independently
reports `success: false`, 0 passed, 0 failed assertions and 65 pending cases.
The zero assertion-failure count is not a PASS: both suites fail before executing
any native case. The required `ci-gate` also fails; all other jobs pass.
No hook/test timeout, assertion, dependency selection or coverage/mutation
threshold was changed.

The complete rerun log confirms repository dependency installation and exact
native executable/version resolution completed before the suites ran. During
bootstrap it contains npm deprecation warnings, but no package identity,
stage timing or npm debug log sufficient to determine the stalled operation's
cause. Source inspection places identity logging after the helper's synchronous
`npm install --prefix <bootstrap> --ignore-scripts --no-audit --no-fund <tarball>`;
this narrows the investigation, not the root-cause conclusion. Recovery requires
a diagnostic Windows execution preserving the same artifact, assertions and
budgets, with bootstrap stage/child-process diagnostics and npm debug logs
retained. Another unchanged rerun is not a substitute for those diagnostics.

### Bounded bootstrap diagnostic checkpoint

Only the private packed-test helper is instrumented; no product authority,
governance code or native parity assertion changes. `spawnSync` retains the
original synchronous, shell-free Node/npm invocation, piped stdio and 300,000 ms
timeout, while exposing npm PID, exit status, signal and timeout/error code.
The only added npm options are verbose logging and a per-bootstrap debug-log
directory; the shared npm cache and dependency selection are unchanged.

`FLOWGUARD_BOOTSTRAP_DIAGNOSTICS_DIR` selects a retained diagnostic directory
outside the disposable installation. Each invocation has a distinct subdirectory
containing `phases.jsonl`, `npm.stdout.log`, `npm.stderr.log` and `npm-debug/`.
Tarball copy/readiness, the actual digest, npm begin/end, worker/npm PIDs,
timestamps, elapsed time, result/error and final package identity are recorded.
Phase records are appended synchronously. Partial npm output and debug logs are
retained before rethrowing a timeout/nonzero exit; neither becomes a fallback
success. Error/timeout retention and disjoint concurrent diagnostics have unit
coverage in the existing `opencode-live-host.test.ts` suite.

The diagnostic runs were pinned to the original shared package from run
`41790845872`, SHA-256
`1ecca9459cfdcffc39399cbbfdb057a3b5ba16ecb1a3e21e34e4fb396450723b`.
They must not silently substitute a fresh build if this historical artifact is
missing or expired. Those pinned results are diagnostic evidence, not acceptance
of the then-new head. Current-build sourcing is restored: the matrix now uses the
same run's `build` artifact, so subsequent Windows results certify the tested
commit including the installer fix below.

The first diagnostic execution on `82a490aa` ran the original seven-case suite
alone, then both suites jointly. It established one solo npm completion and two
joint timeouts (below). Based on that result, the test job now executes both
suites **serially** (`--no-file-parallelism`) and reuses one digest-bound
bootstrap through `FLOWGUARD_BOOTSTRAP_PREFIX`. The second suite verifies the
same tarball digest and embedded build identity and skips only the duplicate npm
install. The real installer, plugin-byte comparison and every parity assertion
still execute in both suites. A missing, stale or different-digest prefix triggers
a clean reinstall. The artifact, 65 cases, assertions, dependency selection and
300-second bootstrap budget are unchanged. Serialization/reuse is a
contention-avoidance measure supported by the solo-versus-joint result, not proof
of the joint stall's mechanism.

Both JSON reports and all diagnostic files are uploaded with `always()`,
including failures. The CI-source tests enforce serialization, digest-bound reuse,
artifact pinning and failure semantics.

Local instrumented control on macOS/Node 22.22.2/OpenCode 2.2.4 with the reuse
path passes **65/65**, with exactly one npm install and a logged
`bootstrap-reused` phase for the second suite. Before the correction, a local
solo control passed 7/7 and a joint control 65/65 with two overlapping npm
intervals (about 4.13 seconds solo; about 7.50 seconds each jointly). Those local
timings only show that the diagnostics observe concurrency; they do not explain
the Windows timeout.
Supporting local verification passes 12,902 unit/integration tests (704 files,
2 skipped), 318 script tests and 547 architecture tests; type checks, strict
lint, build/documentation drift (17 tests), formatting, actionlint and action
pinning also pass. A direct packed-installer run in a local `RUNNER~1` path
completes with 27 files and the installed dependency tree. These are not Windows
execution evidence.

### Executed hosted diagnostic on `82a490aa`

[CI run 41797089286](https://github.com/koeppben23/governed-runtime/actions/runs/41797089286)
on `82a490aa7dc814855f9b5ab6b58f1fb9f3dcab0e` fails only Windows parity and
the required `ci-gate`; every other job, including integration PERF, passes.
Downloaded Linux/macOS JSON reports each establish **65 passed, 0 failed,
0 pending**. Their bootstrap phase files and all three Windows phase files
record the original shared tarball digest `1ecca9459cfdcffc39399cbbfdb057a3b5ba16ecb1a3e21e34e4fb396450723b`.
These are new test-run observations of the original CI merge build
`5bbdc3c4a7892e7b1b7cbdc5b20f15e8c68a47ad`, not a newly built product at
`82a490aa`.

The Windows job is
[`126464145222`](https://github.com/koeppben23/governed-runtime/actions/runs/41797089286/job/126464145222).
Downloaded artifacts `13307335143` (phases/npm logs) and `13307490658`
(both JSON reports) independently distinguish:

| Arm     | Worker / npm PID | npm interval, UTC             | Result                                                                         |
| ------- | ---------------- | ----------------------------- | ------------------------------------------------------------------------------ |
| Solo    | `3724` / `1792`  | `08:10:38.425`–`08:15:06.240` | 267,815 ms by recorded elapsed counters; exit 0; final package identity logged |
| Joint 1 | `7972` / `6688`  | `08:15:55.989`–`08:20:56.063` | 300,072 ms; `ETIMEDOUT`, status null, `SIGTERM`                                |
| Joint 2 | `7440` / `5964`  | `08:15:58.161`–`08:20:58.216` | 300,054 ms; `ETIMEDOUT`, status null, `SIGTERM`                                |

All three inherit `C:\npm\cache`; each installation and diagnostic directory is
distinct. The configured process and `beforeAll` limits remain 300,000 ms;
the recorded timeout intervals include termination overhead, not raised limits.
The solo stdout reports 472 packages added and its debug log ends `verbose exit
0` / `info ok`. It also records cache-miss tarball fetch intervals of 187,544 ms
for `hono` and 195,535 ms for `@grpc/grpc-js`, both HTTP 200. Those are npm-reported
fetch intervals, not independent network-only measurements.

Both joint debug logs stop after cached tarball/reification activity and
deprecation warnings, without npm completion. Their recorded metadata requests
return HTTP 200; no explicit cache lock, `EBUSY`, `EPERM`, `EINTEGRITY` or network
error explains the timeout. Thus **the slow solo success and overlapping joint
timeouts are established, but cache/filesystem contention is NOT_VERIFIED**.
Logging affects timing, and the joint arm also inherits a warmed cache. The
subsequent serialization/reuse avoids the observed overlap without claiming to
have identified its internal mechanism; no dependency-selection change or
product fix is made.

**Solo bootstrap completion is not solo conformance PASS.** Its JSON report
records **0 passed, 7 failed, 0 pending**; the joint JSON report records
**0 passed, 0 failed assertions, 65 pending**, with both suites failed in setup.
The solo failures expose separate boundaries previously hidden by bootstrap:

- Both shell-effect cases fail in the **absent** control: the quoted executable
  followed by `-e` is rejected by PowerShell (`Unexpected token '-e'`), and the
  file remains `original`. This fixture command is not valid for the observed
  Windows shell. It is not evidence of an INACTIVE FlowGuard veto. The fixture
  now emits `node -e "require('node:fs').writeFileSync('<forward-slash path>',
'<effect>')"`, which is valid in PowerShell and POSIX sh while preserving the
  same real-file-effect assertion. The original and installed arms use the same
  command; the fixture change is test-only.
- The absent subagent control also leaves the child-effect file `original`.
  Its child used the same invalid command construction and is covered by the same
  cross-shell replacement; the original failure's terminal child details were
  not retained, so that exact cause remains **NOT_VERIFIED**.
- The two edit cases, catalogue case and compaction case reach the packed
  installer, which fails dependency setup with npm `ENOENT` opening a local
  tarball. The retained npm debug log (run `41801596586`) resolves the cause:
  Node 22 `pathToFileURL` serialized the vendored path as
  `file:///C:/Users/RUNNER%7E1/...`; npm 10 then tried to open the literal
  `C:\Users\RUNNER%7E1\...` directory and received `ENOENT`. The project path
  uses the Windows 8.3 short name `RUNNER~1`, so this is a real installer
  portability defect for `~`-containing paths, not a corrupt artifact or a
  governance failure. Upstream commit `0e3568f0` now writes the staging
  dependency as an unencoded `file:../vendor/...` spec relative to the staging
  root, the same form the installed `package.json` template uses. npm resolves
  that raw path directly, so `~`, spaces and `#` need no URL decoding. A
  real-npm test covers a target containing all three. The fix is product code
  and requires Windows re-execution; the previous failure remains historical
  evidence.
- Solo `afterAll` cleanup additionally exceeds its unchanged 10,000 ms hook
  limit. That is distinct from the 300-second bootstrap limit.

The successful `install (windows-latest)` and `install-verify (windows-latest)`
jobs remain separate evidence; they do not negate the specific path failure or
certify these native conformance cases. No product code or parity assertion is
changed in response to this diagnostic result.

The installer `ENOENT` is now attributed and fixed in product code (see above),
and the fix executed successfully on Windows. The bootstrap overlap is avoided
by serialization/reuse; its internal Windows mechanism remains **NOT_VERIFIED**
even though the serialized run passed. The solo cleanup timeout was a
test-cleanup budget issue; bounded cleanup hooks resolved it. P0-00 Windows is
**PASS** for the current-build CLI/server matrix as recorded below.

### Current-build Windows job-budget limits

[CI run 41806050855](https://github.com/koeppben23/governed-runtime/actions/runs/41806050855)
on `151df7edef671888561362b1818e68204aa7f2a4` uses the current build artifact,
SHA-256 `edf0f1079e6fb98cd626a2e4374d8da0fe2630833d826c93614b4b8a57344329`,
with embedded merge-build SHA `4c238535cbf2e58e1c60c8287a5f8ac43cbb868d`
(built `2026-11-04T09:17:02.352Z`). Linux and macOS each pass **65/65** on these
bytes. Windows downloads the same artifact, resolves OpenCode 2.2.4, completes
the digest-bound npm bootstrap in **65.5 seconds**, and performs real installs
(mixed repo/global, then matrix Git/repo and non-Git/repo scopes) with no
installer error.

Its Windows job is cancelled by the then-unchanged **20-minute job limit** at
`09:37:23Z` (started `09:17:15Z`), midway through the second matrix scope. No
assertion failure is reported; Vitest is killed before writing
`inactive-parity-results.json`. The last installer completes at `09:34:16Z`; the
global matrix scopes are never reached. This is an execution-budget finding, not
a product, installer or assertion failure.

[CI run 41809656855](https://github.com/koeppben23/governed-runtime/actions/runs/41809656855)
then repeats on `96448a1c94c02192342120724631444c1080427b` with the current
artifact SHA-256
`77033d0078b6985a4fe1690fa6c6cacba9c1e0ba4b9c80f2459104c48ce72594`, embedded
merge-build SHA `276354911a428c63e9a11b727f917e4f45ac783c` (built
`2026-11-04T09:45:41.682Z`). The bootstrap completes in **70.3 seconds**; the
mixed and all four matrix scopes perform six real installs with no installer or
assertion failure. Vitest then advances to the final original seven-case suite
at `10:19:14Z`, but the **35-minute job limit** cancels at `10:21:00Z` after
`35m08s`. No results JSON is written; the missing file is cancellation, not a
reported failure.

[CI run 41829567943](https://github.com/koeppben23/governed-runtime/actions/runs/41829567943)
on `d5d88a8e2fa77e78928bfe61c4c8858d0d5fbec0` is the successful current-build
run. Its artifact SHA-256 is
`0320b43a7dcdada91326927ddd7ecd1a9ff8509a75ea1e27da8bae07ad1291a6`, with
embedded merge-build SHA `641fbec44cfcc15b67c95c14cc84d9b387c4d211` (built
`2026-11-04T12:29:34.830Z`). Windows is split into four parallel jobs —
`mixed`, `repo`, `global` and `original` — with 25-minute budgets. They execute
**2 + 28 + 28 + 7 = 65 cases, 0 failed**; the additional skipped JSON entries
are the cases filtered out of each job, not unexecuted acceptance cases. The
whole CI run, including unit/coverage and Windows install-verify, is green.

Because the full matrix is acceptance evidence rather than per-PR feedback, it
now lives in the separate `opencode-parity.yml` workflow (`workflow_dispatch`,
nightly schedule, and the `run-parity-acceptance` PR label), not in the required
pull-request gate. Moving the workflow preserves all 65 cases and assertions;
the installed suite still performs its real installer runs for its own arms.
The preceding Windows fixes did change hook budgets: original-template and
mixed-session setup have 600-second hooks, and cleanup hooks have 60-second
ceilings with bounded filesystem retries. Mixed-session installation moved out
of the 300-second test body into setup; original per-case limits remain 180
seconds. These are setup/cleanup changes, not an unchanged total execution
budget or evidence that every earlier timeout had the same cause.

### Acceptance-workflow setup failures on `6e46299b`

[Acceptance run 41836072753](https://github.com/koeppben23/governed-runtime/actions/runs/41836072753)
on `6e46299b34ae9de816472d7f414165c455e9dd7d` is **FAIL**, separately from
the accepted `d5d88a8e` run. Linux/macOS pass 65/65; Windows mixed passes 2/2
and original passes 7/7. Repo/global each execute **0 of their 28 selected
cases** because arm setup fails. Their JSON reports list all 58 installed-file
cases as skipped; 30 are intentionally filtered out and 28 were not executed.

- Package SHA-256:
  `6effe7ab1e075babcf4b43874080ec40b4d15939bc04ca69bc07fe4eb266a212`;
  embedded merge build `8ff9c9b6fd74d9e5b9f48d492ca461a290c875f2`.
  Comparing every regular tar member with the accepted package shows only
  `dist/build-info.json` differs. The arm-setup test helpers are also unchanged.
- Bootstrap succeeds: repo npm completes in 74,987 ms, global in 79,291 ms.
  Both use Node 22.22.2/npm 10.9.7. No bootstrap change is justified by these
  failures.
- Both repo arms and the Git-enabled global arm fail at the outer packed-CLI
  invocation with `ETIMEDOUT`. Each retained dependency-install npm log reaches
  `verbose exit 0` / `info ok`, followed by an error log-location notice. Those
  messages do not establish successful exit of the complete installer process.
  The repo dependency-resolution logs contain the same 472 distinct
  `placeDep` entries as the accepted run; neither a different product package
  nor changed resolved dependency versions explains that comparison.
- The non-Git global arm exits with `Neither bun nor npm found in PATH`.
  Source inspection shows both failed and timed-out 5-second version probes
  collapse to this message. The isolated host environment inherits `PATH`
  unchanged but replaces `HOME`, `USERPROFILE`, XDG and temporary directories.
  No retained log establishes a literally missing npm executable, a changed
  PATH, or the exact failing detection probe. A timeout is a hypothesis, not a
  proven explanation.

The test harness now records each real installer invocation's scope/project,
PID, duration, status/signal/error, stdout and stderr. A test-only Node preload
records allowlisted environment fields (including case-preserved PATH keys),
filesystem npm/bun candidates, actual subprocess command/arguments and timings,
and child process start/exit. It observes the existing calls and rethrows their
errors unchanged; it does not select a package manager, retry installation or
extend deadlines. npm debug logs remain retained beside these records.

Local macOS control with Node 22.22.2/OpenCode 2.2.4 and the same failed-run
package (`6effe7ab…`) executes **65/65, 0 failed, 0 pending** with this
instrumentation. All seven real installer invocations retain command/exit
records; package-manager probes and installations return normally. This verifies
the observer on real processes, not the Windows root cause or Windows acceptance.

#### Executed installer trace on `7edcbd96`

[Acceptance run 41841262945](https://github.com/koeppben23/governed-runtime/actions/runs/41841262945)
is **FAIL**. Linux/macOS each pass 65/65. Windows passes 51 distinct cases:
2 mixed + 7 original + 28 global + 14 repo. The remaining 14 cases are exactly
the non-Git repo arm, unexecuted after its setup fails; there are no failed case
assertions, but this is not a successful suite or a 65/65 acceptance.

All four Windows bootstrap identities match the downloaded package checksum
`098374797abfcd15ea362a836a75cb7fdeb3611d9544d8c82d2aafc8275d5bd0`,
embedded merge build `1f9b0f113cb0c571a8de08bbe29163e01ce67bd6`.

The failed arm's subprocess trace establishes:

1. npm exists in PATH and the actual pinned Node/npm CLI starts. bun returns
   `ENOENT`; `npm --version` succeeds in **619 ms**, not the 5-second timeout.
   This arm is not a package-manager discovery failure.
2. The real npm install starts at `13:56:16.904Z`. At `14:01:15.445Z`, the
   outer harness records **300,016 ms**, `ETIMEDOUT`, status null and SIGTERM
   for the installer. No completion from its synchronous npm call was observed.
3. The npm child later records process exit 0 at `14:02:28.886Z`, about
   **372 seconds** after npm starts and 73 seconds after the installer is killed.
   It outlives the timed-out parent. The first repo arm completes the npm call
   in **233,615 ms** and the complete installer in **234,775 ms**.
4. Both global arms now complete, with installer durations **231,759 ms** and
   **277,977 ms**. The earlier global discovery error was not reproduced;
   passing now does not establish its original cause.

This localizes the reproduced timeout to the npm-install subprocess rather than
bootstrap or native parity assertions. It does not yet identify why that npm
execution took 372 seconds. To distinguish npm resolution, materialization and
finalization, installer diagnostics additionally enable npm's own timing log and
timing JSON via `npm_config_timing=true`. This changes logging only, not npm
arguments, dependency selection, retries or deadlines.

**NOT_VERIFIED:** the cause of slow Windows npm installation, the original
global discovery failure, and a successful full matrix with this diagnostic
harness. Inspect npm timing artifacts on the next candidate before choosing a
fix; require the same run's checksum-verified package and 65/65 on each OS before
reporting fresh acceptance. The older PASS remains bounded evidence, not a PASS
for either failed run.

#### npm timing result on `bc23a18e` and bounded volume control

[Acceptance run 41845002693](https://github.com/koeppben23/governed-runtime/actions/runs/41845002693)
is **FAIL**. Linux/macOS each pass 65/65. Windows repo/global each pass 28/28
and original passes 7/7; both mixed cases remain unexecuted because their real
installer setup times out. Thus Windows has **63/65 passed, 2 unexecuted**, not
a new acceptance PASS. The missing mixed cases cannot be supplied from another
run to certify this package.

The package SHA-256 is
`08b59bcca53084eb7c49765c30fa0188af40719eff7f07308f6059f1a1530d62`,
embedded merge build `254b8508d57e8f8447a34b97f830cfcad2951e44`; all four
Windows bootstrap identities match these bytes. npm discovery succeeds in every
installer trace, including both failed mixed setups (549/748 ms). The original
global discovery error is still not reproduced or attributed.

npm's own timing output identifies **unpacking/materialization** as the slow
phase: successful repo arms spend **252,158 / 217,222 ms** in `reify:unpack`,
successful global arms **218,812 / 249,511 ms**, and the original template
**222,266 ms**. Mixed repo/global time out at **300,010 / 300,015 ms** while
`reifyNode` unpack timers are still completing. This is not a native assertion
failure or a package-manager search failure. Timers establish the npm phase,
not an antivirus, disk, cache or scheduler root cause.

The next diagnostic preserves the ordinary full matrix and adds one **separate**
same-VM mixed-session control after its original step, including when that step
fails. It repeats the unchanged two mixed cases with only `TEMP` and `TMP` set
to GitHub's `runner.temp`, instead of the inherited Windows system temporary
directory on `C:`. It uses the same tarball, npm cache and digest-bound bootstrap
prefix, retains its own result JSON and diagnostics, and keeps the 25-minute job
limit. A green control cannot mask a failed original matrix or certify all 65
cases. This is an experiment, not a proven fixture-volume fix; the comparison
also has an explicit order effect (the runner-temp control runs second).

**NOT_VERIFIED:** the controlled volume comparison, the cause below npm unpack,
the earlier global detection failure and fresh full-matrix acceptance. No
product correction is justified by the current evidence, and no install/test
budget, dependency selection or assertion has been changed.

#### Executed volume control on `e2b25677`

[Acceptance run 41849104623](https://github.com/koeppben23/governed-runtime/actions/runs/41849104623)
is **FAIL**: Linux/macOS each pass 65/65; Windows passes 37 distinct acceptance
cases (14 repo + 14 global + 2 mixed + 7 original), with 28 selected repo/global
cases unexecuted after setup timeouts. The separate two-case control passes but
does not contribute additional acceptance cases.

The original and control mixed steps use package SHA-256
`278a5f324424a4d6589404df25425e9a3f9b1f015afd16e1fe3c0f824a83f22d`,
embedded merge build `85a066989dcd64526a34c1bb2c4e7840a526e2b7`. Both run on
the same Windows VM and use the same npm cache; the control records
`bootstrap-reused` for the identical digest-bound prefix.

| Fixture root                                                   | Repo installer / npm unpack | Global installer / npm unpack | Mixed cases |
| -------------------------------------------------------------- | --------------------------- | ----------------------------- | ----------- |
| Inherited system temp (`C:\Users\RUNNER~1\AppData\Local\Temp`) | 232,048 / 206,460 ms        | 284,294 / 249,094 ms          | 2/2 PASS    |
| Runner temp (`D:\a\_temp`)                                     | 53,456 / 17,345 ms          | 45,568 / 17,368 ms            | 2/2 PASS    |

This supports a bounded CI-harness correction: Windows test preparation exports
`TEMP` and `TMP` as `runner.temp`, inherited by all four parity shards. The
existing Node preparation action owns the shared setting; release smoke uses
the same Windows-only export with its existing Node setup. The full job inventory
and verification limits are in [Testing Strategy](../../testing-strategy.md).
Every arm still performs
its real installation and every existing case/assertion remains; the product,
package-manager choice, npm cache, bootstrap algorithm and timeouts are unchanged.
The now-completed extra control step is removed, not kept as a second acceptance
path. Source tests pin all four original shard selectors and the runner-temp
environment. This change is not a claim that antivirus or a particular disk
mechanism caused the slowdown; the control also ran second, not in randomized
order.

**NOT_VERIFIED:** full Linux/macOS/Windows 65/65 acceptance after this harness
correction, the original global detection error, and the OS-level cause below
the observed unpack/path difference. Re-run the complete installed matrix on one
new checksum-verified artifact; do not combine cases or digests from earlier runs.

### Intervening `a38dd3a7` run, retained separately

[CI run 41793806176](https://github.com/koeppben23/governed-runtime/actions/runs/41793806176)
on docs-only `a38dd3a7e3d2cae9cf4a826738aabcf073a7c314` also fails Windows
bootstrap, macOS parity, integration PERF and the required gate. The downloaded
macOS JSON reports **51 passed, 0 failed assertions, 14 pending**, with the
Git/repo subgroup setup failing `ServiceUnavailableError: Location plugins did
not finish activating`. Both packed helpers had logged digest
`9dde01d22463bbe8ebd41ea433b90a59ca6cb659ef8a476cc4a73eb1e83cd157` and embedded
merge-build SHA `eee6923c5c4c8bbdd2e186cf5e94e1cda95c1eb6`; this is not the
original diagnostic artifact. The PERF measurement is 167.69 ms against <150 ms.
The later diagnostic run's PASS does not establish either failure's root cause
or reclassify it as infrastructure noise/a flake. Upstream `78298e2a` now retries
exactly the transient `ServiceUnavailableError` activation answer within the
existing 60-second deadline and records deferrals; a failed activation still
surfaces as plugin state `failed`. Its macOS re-execution and the PERF
measurement remain open and are not certified by this diagnostic.

### Desktop boundary

**Desktop BLOCKED for local pinned acceptance:** the installed
`/Applications/OpenCode.app` reports bundle version **2.2.5**, not target 2.2.4.
It was neither downgraded nor relabelled as the pinned surface. A separately
installed 2.2.4 Desktop and actual native UI/observer access are required. A private
CLI server or browser page must not be presented as Desktop evidence.

## Reproduction and remaining gates

Build once before running native suites; do not rebuild during a native run:

```sh
npm run build
npm run pack:checksums
FLOWGUARD_TARBALL="$PWD/flowguard-core-$(cat VERSION).tgz" \
  OPENCODE_LIVE=1 OPENCODE_CLI=/opt/homebrew/bin/opencode \
  npx vitest run --project smoke \
  src/cli/opencode-inactive-parity.smoke.test.ts \
  src/cli/opencode-inactive-installed.smoke.test.ts --silent=false
```

The log records the actual tarball digest and embedded build identity. A new
build has a new identity/digest and must not be relabelled as this executed
artifact. The test helper is
`src/cli/opencode-packed-install-test-helpers.ts`; all hosts and installation
targets are isolated and cleaned up.

Additional executed checks: `npm test` passed **703 files / 12,884 tests / 2
skipped**; `npm run test:architecture` passed **547 tests**; build, `check`,
`lint:strict`, `check:format`, `check:doc-drift` (17 documentation tests),
`check:unused-dependencies` and the unused-export check passed. The PR-base
documentation check and its working-tree changelog validation passed separately;
neither alone is a hosted-CI result for the later follow-up.

**Executed CLI/server acceptance:** run
[`41855491592`](https://github.com/koeppben23/governed-runtime/actions/runs/41855491592)
on `2f4aa06d` passes 65/65 on Windows, Linux and macOS using the shared artifact
identified in the final closure above; required CI passes on attempt 2. The
earlier accepted `d5d88a8e` result and intervening failures remain separate
historical evidence, not a fabricated uninterrupted green history.

**NOT_VERIFIED:** installed Desktop 2.2.4 acceptance, live remote catalogue-refresh
parity and all-provider/media execution. Run the owning suites for the untested
surfaces and use the actual Desktop/native UI for that distinct acceptance.
The bounded CLI/server matrix is a completed part of P0-00, not whole-product
acceptance. Its mixed-session results do not close all P0-07 shared-resource
acceptance, the remaining V2 integration, or R4. Default mutation certification
also remains **NOT_VERIFIED** (`npm run mutation`); no selection, threshold or
coverage timeout was changed.

# P0-00: packed-installed INACTIVE parity

2026-11-04, PR #1190. **Bounded CLI/server PASS on Linux/macOS/OpenCode 2.2.4;
not Desktop or whole-PR acceptance.** R4 remains technically `NOT_SUPPORTED`
under the unchanged untrusted-plugin contract and its security requirement
remains BLOCKED. No ACTIVE-V2 release follows from this result.

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
   Both suites were rerun together against the **same supplied tarball**, not
   independently rebuilt workspace wrappers.

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

The added required `inactive-parity` CI matrix runs **these same two suites** on
Linux/macOS/Windows. `build` creates one tarball/checksum artifact shared by all
runners, with exact native executable/version resolution and JSON results.
Shell-free npm invocation uses Node plus `npm_execpath`, rather than assuming a
Windows `.cmd` can be passed to `execFileSync`. Matrix success must be observed;
workflow wiring alone is not platform acceptance.

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

The existing CI matrix is temporarily pinned to the original shared package from
run `41790845872`, SHA-256
`1ecca9459cfdcffc39399cbbfdb057a3b5ba16ecb1a3e21e34e4fb396450723b`.
It must not silently substitute a fresh build if this historical artifact is
missing or expired. This is a bounded diagnostic checkpoint, not acceptance of
the newly built head; restore current-build sourcing after diagnosis.

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
Supporting local verification for this test-only diagnostic/reuse change passes
12,890 unit/integration tests (703 files, 2 skipped), 318 script tests and 547
architecture tests; type checks, strict lint, build/documentation drift (17 tests),
formatting, actionlint and action pinning also pass. These are not Windows
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
  tarball. Its scrubbed output includes a `file:C:` reference with `[path:RUNNER]%7E1`
  path text. This is an observed installed-path failure, not a proven corrupt
  artifact, governance failure or general Windows installer defect. Source
  inspection identifies `install-transaction.ts` staging through
  `pathToFileURL(tx.vendorTarballPath).href`; the failing unredacted staging input
  was not retained. The helper now gives each installer invocation an
  `npm_config_logs_dir` outside the disposable project and keeps the npm debug
  log, so the next execution can attribute the path failure. The precise cause is
  **NOT_VERIFIED**.
- Solo `afterAll` cleanup additionally exceeds its unchanged 10,000 ms hook
  limit. That is distinct from the 300-second bootstrap limit.

The successful `install (windows-latest)` and `install-verify (windows-latest)`
jobs remain separate evidence; they do not negate the specific path failure or
certify these native conformance cases. No product code or parity assertion is
changed in response to this diagnostic result.

Remaining recovery needs concrete attribution of the installer `ENOENT` from the
newly retained npm log, then a separate decision on whether it is a test-path or
product installer defect. The bootstrap overlap is avoided by serialization/reuse;
its internal Windows mechanism remains **NOT_VERIFIED** even if the serialized
run passes. P0-00 Windows remains **BLOCKED** until the 65 cases execute and pass
on Windows, the installer path is understood, and the solo cleanup limit is
resolved without weakening assertions or budgets.

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
or reclassify it as infrastructure noise/a flake. No fix or unchanged rerun is
performed for these separate findings in this Windows diagnostic task.

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

**NOT_VERIFIED:** complete Windows 65-case native-parity execution, live remote catalogue-refresh
parity and all-provider/media execution. Exact-head CI for the extended suites
was executed and failed as recorded above, not left unrun. Run the owning suite
on the unresolved platforms and use the actual Desktop/native UI for that
distinct acceptance. P0-00 as a whole remains
open for its unverified/blocked surfaces. The mixed-session results above do not
close all P0-07 shared-resource acceptance, the remaining V2 integration, or R4.
Full native smoke, coverage and default mutation were not rerun on this test-only
delta (`OPENCODE_LIVE=1 npm run test:smoke`, `npm run test:coverage:ci`,
`npm run mutation`); no selection, threshold or coverage timeout was changed.

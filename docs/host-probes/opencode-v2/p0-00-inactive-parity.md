# P0-00: packed-installed INACTIVE parity

2026-11-04, PR #1190. **Bounded CLI/server PASS on macOS/OpenCode 2.2.4;
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

**NOT_VERIFIED at this local follow-up:** installed Linux/Windows native-parity
matrix results, live remote catalogue-refresh parity, all-provider/media execution
and exact-head CI for the extended suites. Run the owning suite on those platforms and use the
actual Desktop/native UI for that distinct acceptance. P0-00 as a whole remains
open for its unverified/blocked surfaces. The mixed-session results above do not
close all P0-07 shared-resource acceptance, the remaining V2 integration, or R4.
Full native smoke, coverage and default mutation were not rerun on this test-only
delta (`OPENCODE_LIVE=1 npm run test:smoke`, `npm run test:coverage:ci`,
`npm run mutation`); no selection, threshold or coverage timeout was changed.

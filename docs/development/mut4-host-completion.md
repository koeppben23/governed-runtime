# MUT4: Host Mutation Completion Verification

Date: 2026-10-22. Finding: [#1172](https://github.com/koeppben23/governed-runtime/issues/1172).
Host: OpenCode **1.19.3**, pinned by `.sdk-baselines/opencode/host-version.json`.
Upstream commit: `e3c4eb242585dcd77be1a867391b7c25fd47ce52`.
Executed locally on macOS with Node 22.22.2 and a deterministic local capture
provider; no external model credentials are needed.

## Observations

- A real edit with a missing replacement target throws before After. Its
  host-recorded ToolPart has the exact session/call/message identity, an error
  state and completion time, without the cleanup interruption marker.
- Aborting a deliberately unfinished test tool produces `error` with
  `metadata.interrupted: true` and an end timestamp. That timestamp does not
  turn cleanup into a regular completion.
- The real FlowGuard plugin closes the regular edit failure from an event
  wakeup followed by a fresh host history read.
- Suppressing event delivery leaves the episode `dispatch_authorized` and
  `/why` correctly blocked. The next `/implement` performs the synchronous
  host read, closes the episode and records the actual worktree contents.
- A controlled redirected background writer can outlive shell exit 0 and 7
  and write after tool return. Shell result classification is not an OS
  descendant-quiescence attestation. This existing boundary is tracked as
  [MUT5 / #1173](https://github.com/koeppben23/governed-runtime/issues/1173).

The shell probe uses a readiness/release barrier and explicit process cleanup;
its correctness does not depend on a guessed delay. The nonzero-exit case also
exercises a controlled SIGTERM-resistant writer. These Unix probes are skipped
on Windows; they establish no Windows process-termination claim.

## Runtime Contract

Automatic error reconciliation is admitted only for `edit`. Events are wakeups,
not authoritative payloads. A fresh SDK message-history read must contain exactly
one matching regular error part, bound to the host session, message and call.
Cleanup, provider-executed, malformed, stale or ambiguous parts are ineligible.

All channels use `commitMutationCompletion`. Under the session write lock it
rechecks the workspace binding, FlowGuard session identity, immutable dispatch
identity, current episode decision and lease authority. A live foreign lease
cannot be superseded. A dead-holder takeover uses the existing canonical lease
acquisition and persists its generation atomically with completion. A resolution
or any already completed outcome wins over delayed observations.

Completion records the observed failure, not absence of file changes. Evidence
remains unbound/ineligible until the ordinary implementation recorder captures
the worktree. Host queries occur outside the write lock and have a bounded
deadline; the implement tool still performs both its preflight and transactional
prerequisite checks against fresh state. Query or persistence failure cannot
acknowledge an outcome.

The schema and unknown-outcome resolution contract are unchanged. A later lease
generation proves supersession of the original runtime epoch, not absence of
surviving OS descendants. Do not use a runtime restart as a shell-quiescence proof.

## Reproduction

```sh
npm ci
npm run build
OPENCODE_LIVE=1 npx vitest run --project smoke src/cli/opencode-mutation-lifecycle-live.smoke.test.ts
npx vitest run --project integration src/integration/host-mutation-observation.test.ts src/integration/plugin-mutation-reconciliation.test.ts src/integration/mutation-episode-e2e.test.ts src/integration/status/status-mutation-recovery.test.ts
```

The live test uses the exact baseline binary (or verifies `OPENCODE_CLI` against
that baseline), isolated host/config/data directories and the compiled plugin.
The integration suites additionally exercise partial real filesystem mutations,
lease changes, concurrent event/query completion, stale dispatch identity,
append-only resolution, persistence failure and blocker-priority parity.

## Remaining Verification Limits

Targeted mutation diagnostics on the three completion/observation modules killed
230 mutants and timed out 2, with **0 survivors and 0 uncovered mutants** (100 %
valid-mutant score; 118 TypeScript-checker rejections). The independently scoped
machine/episode diagnostic reached 91.84 %. These are targeted diagnostics, not
full-profile admission evidence. The two new modules remain explicit base-profile
admission candidates under the repository's existing freeze-commit policy.

```sh
npm run mutation -- --mutate src/integration/host-mutation-observation.ts,src/integration/plugin-mutation-episodes.ts,src/integration/plugin-mutation-reconciliation.ts --testFiles src/integration/host-mutation-observation.test.ts,src/integration/plugin-mutation-episodes.test.ts,src/integration/plugin-mutation-reconciliation.test.ts --concurrency 4
npm run mutation -- --mutate src/machine/workflow-directive.ts,src/state/evidence-mutation-episode.ts --testFiles src/machine/workflow-directive.test.ts,src/state/evidence-mutation-episode.test.ts,src/integration/status/status-mutation-recovery.test.ts --reporters clear-text --concurrency 4
```

- `NOT_VERIFIED`: the original `development-05-implement` raw artifacts were not
  available. The new reproduction is independent evidence of the same failure
  mechanism, not a claimed replay of that historical run.
- `NOT_VERIFIED`: OpenCode 1.19.4 has not been accepted as equivalent. Run the
  relevant host experiment separately before upgrading the exact baseline.
- MUT5 remains open. The edit fix makes no universal shell/process-quiescence
  claim and does not introduce a shell command-string classifier.
- `NOT_VERIFIED`: full base-profile mutation admission has not been established
  by these targeted diagnostics. Recovery: a clean freeze commit, `npm run mutation`,
  then the documented full-profile admission verifier.

For a release requiring full admission of the two new authorities, this remains
an outstanding release condition until the existing verifier accepts a full
base-profile report and its freeze-commit manifest. A green PR CI or the targeted
100 % score does not satisfy that condition. On the clean freeze commit run:

```sh
npm run mutation
node scripts/verify-mutation-admission.mjs --profile base --require-admitted --require-selectors src/integration/host-mutation-observation.ts,src/integration/plugin-mutation-reconciliation.ts --write-profile-manifest
node scripts/verify-mutation-admission.mjs --profile base --require-admitted --require-selectors src/integration/host-mutation-observation.ts,src/integration/plugin-mutation-reconciliation.ts --verify-profile-manifest --emit-admission
```

Only verified admission output may be added to the immutable admission records;
until then the inventory entries remain admission candidates. This is the
repository's existing admission rule, not a replacement or relaxed gate.

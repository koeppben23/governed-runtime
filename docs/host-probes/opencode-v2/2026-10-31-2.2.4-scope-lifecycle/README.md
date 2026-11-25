# Phase 02 follow-up: scope and lifecycle — OpenCode 2.2.4

**NO-GO. P0-02-H remains NOT_VERIFIED as a whole.** This checkpoint records
bounded host mechanisms and counterexamples, not FlowGuard activation,
authorization, independent review evidence or full Phase-02 completion.
P0-01 remains BLOCKED. Product implementation and merge remain prohibited.

## Authority, artifacts and method

- [ADR-010](../../../decisions/010-host-neutral-opt-in-governance.md),
  [gate matrix](../phase0-contract-gates.md),
  [probe threat model](../../../trust-boundaries.md#opencode-v2-phase-02-probe-threat-model-1169).
- Final run **2026-10-31T10:45:53.603Z**, Node **22.22.2**, installed CLI/server,
  client and plugin **2.2.4**, macOS; not Desktop or an interactive human TUI.
- Binary SHA-256:
  `03fc30769f28dd346d2279baae77ef71308175cd49eb7a5be339d3860ee99ec1`.
  [Sanitized facts](./facts.json) bind exact source and private raw-report bytes.
  Digests identify observations, not signed host honesty or supply-chain integrity.
- Official living docs inspected **2026-10-31**:
  [client/events](https://opencode.ai/v2/docs/build/client),
  [API](https://opencode.ai/v2/docs/api),
  [plugin context/sessions](https://opencode.ai/v2/docs/build/plugins/server),
  [tools](https://opencode.ai/v2/docs/tools),
  [agents](https://opencode.ai/v2/docs/agents).
  Installed 2.2.4 client types and real observations delimit the tested contract;
  living documentation alone is not pinned evidence.

The existing isolated harness and its probe sources are unchanged. The new probe
creates its own Git worktree, nested directory, symlink, sessions, instruction
sentinel and local capture-provider traffic. It restarts **only its owned private
server**, retaining that fixture's DB/HOME/provider. The SIGKILL case waits until
the local provider actually receives the deliberately held request. No operator
service is restarted; no live session/configuration or backup is restored.

The provider and wildcard permission baseline are test instruments, not a model
allowlist, authentication channel or security sandbox. Raw paths/session IDs and
request bodies remain private. Earlier dated reports/facts are unchanged.

## Findings

| Tested property                | Exact observation                                                                                                                                                                                                         | Interpretation                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session / Git worktree mapping | Root and second Git worktree have distinct session/location directories but the same project ID and canonical checkout                                                                                                    | A project ID alone is **NOT_SUPPORTED** as an exact worktree binding; not a host defect                                                              |
| Nested directory and symlink   | Host location preserves nested/alias spelling; project root is separately reported; alias session subpath can contain `..`                                                                                                | Raw host location is not canonical filesystem authority; reuse the existing canonical session authority in the later adapter                         |
| Native child visibility        | One completed native `subagent` tool metadata reference identifies the exact child; parent assistant ID, tool-call ID, child `parentID`/location and durable creation/tool-success event aggregate IDs/versions correlate | Visible correlation is available in this fixture; not independent operator provenance or complete V2 reviewer attestation                            |
| Caller-asserted parentage      | SDK `session.create({ parentID, agent })` creates a child of an existing parent without native subagent dispatch                                                                                                          | `parentID` alone is **NOT_SUPPORTED** as proof that a native dispatch occurred                                                                       |
| Deleted-parent negative        | Creation against the ID of a removed fixture parent rejects with `SessionNotFoundError`                                                                                                                                   | Relevant negative control, not proof against every foreign-parent or reuse path                                                                      |
| Existing ID collision          | A request with existing ID but conflicting parent/location/title returns the original session; subsequent read is unchanged                                                                                               | No overwrite observed; acceptance of the API call is not acceptance of its proposed replacement scope                                                |
| Overlapping creates            | Two client requests for one new ID propose different parent/location values; both return the same persisted session in the final trial                                                                                    | One overlapping-request observation; no host-internal interleaving barrier, stress proof or product exactly-once transaction guarantee               |
| Session move                   | Explicit move changes one session's directory to the second worktree and adds a location-switch record; unrelated sibling remains at root                                                                                 | Session ID does not freeze worktree location; move handling must be explicit in the later governed-scope contract                                    |
| Instruction entry              | Root sentinel is readable on root, absent from native child entries and its one captured model request                                                                                                                    | Automatic propagation of this root entry is **NOT_SUPPORTED** in the tested child path; not a claim about every instruction source                   |
| Graceful restart               | Six idle sessions retain exact ID/parent/project/location bindings plus full API-context and instruction-entry digests                                                                                                    | Bounded readback preservation, not a FlowGuard activation transaction/recovery PASS                                                                  |
| Crash restart                  | The same six idle snapshots remain equal after killing the server during another session's held model request                                                                                                             | Idle-session persistence under this crash is observed; not universal durability or storage-corruption handling                                       |
| Crashed in-flight request      | Same session binding survives; `wait()` returns, but `outcome` remains absent, Busy timestamp remains and no normal/late answer is observed in the post-wait snapshot                                                     | `wait()` returning alone is **NOT_SUPPORTED** as proof of normal completion. This is an unknown/incomplete outcome, never equivalent review evidence |
| Event-stream continuity        | First two streams retain transport-termination failures. A known persisted session is created during each disconnected gap; neither creation is replayed after resubscription                                             | Live-only delivery is not durable replay. Reconnection/readback works, but missing events must not be synthesized                                    |
| Post-restart control           | Unrelated sibling completes a new normal mock request                                                                                                                                                                     | The restarted fixture is functional; this does not resolve the crashed request                                                                       |

The native child lookup uses **exact tool metadata**, never a latest timestamp,
answer text or the first item of a session listing. Creation-event and
tool-success correlation does not certify completeness of every event sequence,
freshness against all reuse attacks, frozen subject binding, or the exact
reviewer request→terminal-response chain required by P0-05.

Both the native tool part and its tool-success event report `executed: false`
despite completed metadata and the separately observed child model request.
That value is preserved, not rewritten to `true`; its assurance meaning is
NOT_VERIFIED here. The diagnostic correlation does not treat that flag as proof
of execution or review completion.

The root/child parent APIs and mutable locations are expected host capabilities,
not newly discovered independent authority. The SDK caller already possesses
fixture API authority. No human decision, ACTIVE record, approval or new product
evidence generation was created. A FlowGuard adapter must not relabel an
unknown formerly ACTIVE scope as INACTIVE after a restart/read/event failure.

## Restart evidence limits

Snapshots compare exact session/project/parent/location bindings and diagnostic
SHA-256 digests of the complete returned context and instruction arrays. These
are byte-level API observations, **not FlowGuard canonical content digests**,
signatures or evidence admission. Mutable timing/cost/session projections outside
those comparisons are retained in raw data, not silently presented as identical.

The crash observation is bounded by the recorded post-restart reads and wait;
it does not prove that every later action could never resume the session. No
automatic recovery/approval was attempted. A Busy timestamp alone is also not
proof that a worker remains alive. Exactly-once authorization consumption,
capacity recovery, audit coupling and real activation persistence belong to
G-04/P0-02-P, not to these unimplemented product transactions.

Cleanup returned without errors; an independent filesystem/process check found
the owned root absent and all **three** observed owned server PIDs absent.
No general all-grandchild or hostile same-user containment guarantee follows.

## Failed and superseded attempts

Private timestamped run directories retain all attempts. Initial exploratory
runs completed with narrower measurements. A subsequent strict pagination guard
failed with `PROBE_SESSION_LIST_INCOMPLETE`; it had assumed that the presence of
a cursor was impossible in this fixture. The failed run and cleanup result were
preserved, not reclassified as a host failure or PASS.

The final probe removes session-list discovery entirely: it reads the exact
child named in native tool metadata and verifies the corresponding live events.
This eliminates the unverified pagination assumption rather than weakening the
lineage requirement. Final source-bound measurements were then rerun.

## Reproduction and remaining work

From the repository root with Node from `.node-version` and the pinned separate
probe dependencies installed:

```sh
umask 077
npx vitest run --project scripts scripts/opencode-v2-probe/scope-evidence.test.ts scripts/opencode-v2-probe/evidence-binding.test.ts
node scripts/opencode-v2-probe/probes/p0-scope-lifecycle.mjs
```

Each invocation creates a new timestamped private output directory. Exit 0 means
the observation program completed and cleaned up; it is **not a P0-02-H PASS**.
Source-byte regression checks bind this dated measurement and preserve the prior
checkpoint's hashes; source changes require a fresh observation/reassessment.

Local verification (Node 22.22.2): `npm run test:scripts` **20 files / 282 tests
PASS**; `npm test` **694 files / 12,400 tests PASS, 2 skipped**;
`npm run test:architecture` **51 files / 538 tests PASS**; repository link checks
**4 tests PASS**. `npm run check`, `npm run lint:strict`,
`npm run check:format`, `npm run check:unused-dependencies` and
`npm run check:doc-drift` (including build and 17 doc tests) passed. Raw/source
digests and published facts were compared locally. Final committed-head PR/CI
verification is reported separately in PR #1190, not inferred from older green
commits. No fresh local coverage or product mutation result is claimed.

**NOT_VERIFIED:** complete P0-02-H on all intended surfaces; cross-parent/worktree
child reuse, parent/child moves, host-internal race interleavings, corruption and
broader lifecycle failures; exact V2 reviewer assurance/new evidence generation;
independent operator authorization; installed FlowGuard INACTIVE/ACTIVE and
G-04/G-05; fresh MCP/hosted/native-interpolation prevention; Desktop/TUI and
Windows isolation; product mutation (`npm run mutation`) and final acceptance
against current `develop`. Production simplification remains a later porting
obligation, not satisfied by this probe code. PR #1190 remains Draft.

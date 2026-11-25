# Published installer checkpoint: source, CI and packed artifact

**Decision: NO-GO for ACTIVE V2 and merge.** This is a publication/provenance
correction and bounded installed CLI test, not reviewer or operator acceptance.
It does not include #1191 or #1192. PR #1190 remains Draft.

## Exact publication and CI identity

- Published branch head:
  [`1750b6b1e31d08a979a4e12932d9d0d5f3c2fd23`](https://github.com/koeppben23/governed-runtime/commit/1750b6b1e31d08a979a4e12932d9d0d5f3c2fd23).
  GitHub's PR API confirms this head and Draft status. The local repository was
  clean at that head before this follow-up; all 57 installer-checkpoint files
  were committed, not just the documentation.
- [CI run 41282275657](https://github.com/koeppben23/governed-runtime/actions/runs/41282275657)
  is associated with that head and built the PR merge commit
  `31e6b320a3071d5767e4594b1bbe049af312fce5`. Its parents are
  `bd05351f3d04f592c3d865895e7c4283d74f623c` and the published head.
- GitHub's Git commit API reports **the same complete source tree** for head and
  merge: `e553a41233973a409edb6200c5e36ede73b61298`. This establishes source
  equality for this candidate, not for future changes to `develop`.
- The CI build's unmodified `dist/build-info.json` names the merge commit,
  version `2.0.0-tp.2`, and build time `2026-11-01T06:49:07.364Z`. It is not
  rewritten to make it name the branch head.

### Observed remote results

| Check                                                                 | Result and exact limitation                                                                                                                                                                                                                           |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build, typecheck, lint, format, doc drift, SDK baseline, architecture | PASS for this CI candidate                                                                                                                                                                                                                            |
| Install and packed install verification on Linux, macOS and Windows   | PASS; not the full native V2 acceptance suite                                                                                                                                                                                                         |
| Security workflow                                                     | PASS                                                                                                                                                                                                                                                  |
| Coverage                                                              | FAIL: `production-build-boundary.test.ts` timed out at its existing 15,000 ms limit; 12,503 passed, 11 skipped. No remote coverage PASS is claimed from the local percentages.                                                                        |
| Smoke                                                                 | FAIL: 11 failed, 91 passed, three skipped. The job still installs host 1.19.5; the new native test explicitly rejects it instead of passing without V2 load. Other V1 hook/API/budget assumptions and the doctor exit-code fixture remain unresolved. |
| Independent review                                                    | FAIL: the two required positive release/same-child contracts remain missing/pending; no replacement with negative/domain fixtures.                                                                                                                    |
| Deterministic agent-instruction evals                                 | FAIL: two process-runner cases still expect the removed OpenCode config-merge path; 101 passed.                                                                                                                                                       |
| Aggregate CI gate                                                     | FAIL; this is not a green release candidate.                                                                                                                                                                                                          |

Coverage's timeout needs diagnosis under the unchanged budget; it is not
retroactively called an infrastructure PASS. Evals and live harness contracts
must be brought into agreement with the native product without test exclusions
or removal of positive acceptance obligations.

## Artifact chain and new installed run

1. Downloaded CI artifact `dist`, ID **13074340309**, from the run above. Its ZIP
   SHA-256 is
   `4a88ad0df66be9ce4c2c5acf0cb112a35f0b154ae0a0f92e7715980bb30a7979`.
   The downloaded bytes match GitHub's artifact digest. This identifies the ZIP,
   **not** an npm tarball. CI's current artifact retention is one day.
2. Copied `package.json`, `VERSION`, README/license metadata and the prepare-hook
   script from the published head into a private staging directory. Unpacked the
   verified CI ZIP into its `dist/`; no product rebuild or build-stamp edit.
   An initial pack attempt lacked the prepare-hook script and failed; the actual
   script was then copied from that same commit, not replaced with a stub.
3. Packed the staged package as `flowguard-core-2.0.0-tp.2.tgz`. Its SHA-256 is
   **`20a189ac2eb869137cc8dc761ed4bff000b6f8bb4728d376f5b78ba03e7d9f85`**.
   Compared all **2,889** packaged `dist` files byte-for-byte with the CI ZIP;
   every file matches, including the merge-commit build stamp. Wrote a checksum
   sidecar for these measured bytes. This is a locally packed CI build, not a
   release uploaded by CI or a signed artifact attestation.
4. Ran the native installed smoke with that exact supplied tarball. The runner
   now supports the existing `FLOWGUARD_TARBALL` test convention and uses the
   supplied checksum sidecar without replacing it. Both the bootstrap installer
   and final uninstall CLI execute from installed copies of the packed package,
   not workspace `dist`. Runtime dependencies are actually installed.
5. **PASS: one test**, local macOS, Node 22.22.2, private OpenCode CLI/server
   **2.2.4**. Exactly one active FlowGuard plugin, reload/reactivation, reviewer
   definition lookup, installed CLI uninstall and rediscovery to absence;
   customer configuration remains byte-identical. This still proves no native
   mutation/model parity, operator action, reviewer completion or joint recovery.

The original pre-commit smoke's disposable tarball was not retained; no digest
is invented for it. The new tarball, ZIP, checksum and raw logs are retained
locally under the session's approved temporary directory, not uploaded as a
release. [Sanitized facts](./facts.json) record their digests. These identify
observations, not signatures or governance approval evidence.

Reproduction uses a verified copy of the named CI ZIP, exact head metadata and
the current smoke runner (whose source digest is recorded separately because
the runner follow-up is not part of `1750b6b1`):

```sh
OPENCODE_LIVE=1 FLOWGUARD_TARBALL=/path/to/flowguard-core-2.0.0-tp.2.tgz \
  npx vitest run --project smoke src/cli/opencode-native-install.smoke.test.ts
```

Keep `checksums.sha256` beside the supplied tarball. Do not substitute a later
rebuild while retaining this run's digest or result.

### Follow-up verification

The supplied-artifact native smoke passed once, and
`FLOWGUARD_TARBALL=... npm run test:install-verify` passed all 11 packed-package
tests against the same retained tarball. The updated smoke's default local-pack
path also passed separately; that separate build is not assigned the CI-derived
tarball's digest.

`npm test` passed 12,513 tests with two existing skips. Typecheck, strict lint,
format, build/doc drift and 538 architecture tests passed. The committed-head
PR-documentation command passed for `1750b6b1`; its canonical validator also
accepted the working-tree changelog. These follow-up checks were performed
locally before the commit/push step, not by a subsequent CI run. The runner's
source digest identifies the tested harness independently of its publication
commit. CI for a later commit remains NOT_VERIFIED until its results are
inspected; re-run the commit-based documentation check against that head.
No full-port mutation or new remote coverage PASS is asserted, and the remote
failures above are not relabelled.

## Next trust-boundary work, not a new feature stream

The canonical owners remain `plugin.ts` for registrations,
`opencode-host-adapter.ts` for host mechanics, the existing review dispatch and
capture owners for evidence binding, and canonical actor/policy/state authorities
for decisions. This record introduces no runtime authority or proof generation.

### Independent reviewer

Pinned 2.2.4 types expose the admitted prompt's inbox/message ID, tool-before and
tool-after call IDs, assistant step IDs and effective model references. However,
an assistant history record has no native `parentID` request link, and an
execution-succeeded notification names the session, not the exact request. The
historical simple probe joins controlled prompt text to adjacent history; it
must not be promoted into production request-correlation proof.

The next bounded proof must join the **authorized parent call → actual visible
child → admitted exact request → actual model/variant/wire effort → exact
terminal → uncontaminated same-child serialization**. It must reject concurrent
or ambiguous requests, child reuse, denied/late tool attempts, length/forced-step
termination and lost event/history/restart mappings. Only then may the canonical
adapter/capture implementation and the two real positive tests be completed.
`wait()`, last-assistant selection and caller-supplied IDs remain inadmissible.

### Operator UI

The pinned TUI `KeymapCommand.run` can receive a keyboard event, while
programmatic `dispatch` does not supply it. That is a candidate to test, **not**
an accepted human-origin proof: palette/slash/programmatic/server-triggered paths
and the UI-to-server handoff still need actual host validation. In the pinned
server RPC API, handlers receive cancellation/error helpers but no trusted
caller-UI principal. Adding a public RPC and an `origin: ui` argument would not
close that gap. Desktop main/window IPC is a separate candidate, not certified
by CLI types or living documentation.

Keep `/start`, approvals and overrides blocked until a real UI action is
distinguishable from model/SDK/API calls and is bound to action, scope, policy and
generation with canonical validation, replay protection and durable audit.
No new registry, external identity service or speculative approval mechanism is
implemented here. Full INACTIVE parity, recovery, Desktop and Java/ProofGraph
acceptance remain independent merge gates after these boundaries are resolved.

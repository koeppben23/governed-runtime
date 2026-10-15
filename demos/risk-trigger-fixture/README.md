# Risk-trigger coverage fixture

Isolated minimal Maven repository used by `run-live-risk-trigger-controls.mjs`.
The governed artifact is a Java ownership-enforcing state store under
`src/main/java/fixture/state/`. The repository's `.opencode/flowguard.json`
explicitly maps that authority surface to HIGH-RISK with `state_integrity`, so the
ProofGraph gate requires explicit certificate-authorized coverage for the
current implementation revision.

The Maven wrapper is copied from the Java demo seed at setup time; this fixture
holds only the project files, the JUnit assertions and the ticket.

## Evidence contract

- `StateNoteTest#storesValidOwnership` observes the accept path (valid owner is
  stored and read back). `StateNoteFalsificationProbeTest#rejectsMissingOrBlankOwnership`
  observes rejection of null, empty, and whitespace-only owners — removing the
  guard or weakening `isBlank()` to `isEmpty()` makes this probe fail.
- Neither JUnit probe observes the invariant sentence or the review comment.
  Those are documentation evidence, confirmed by content/diff inspection.
- The falsification probe is guarded by `FLOWGUARD_LIVE_SKIP_ASSERTION` as an
  intentional negative-case control hook. A skipped probe is not sufficient
  adversarial evidence: FlowGuard binds skipped assertions as not_verified and
  the demo oracle requires the bound assertion to be passed.
- `build` (`./mvnw verify`) and `test` (`./mvnw test`) overlap in Maven's test
  phase; admissible evidence requires distinct attempt identities and evidence
  roles, not disjoint command implementations.
- `.opencode/flowguard.json` is applied after install and frozen into the
  persisted policy snapshot; it is not part of the seed commit.

The live runner accepts `--evidence-out <file>` and emits build/pin/model identity,
per-turn durations, denial counts and the machine-readable denial baseline from
`expected-denials.json`. Required negative-control denials must be observed;
allowed recoverable codes still need the existing occurrence-bound recovery proof.
The manually dispatched `ProofGraph live controls` workflow retains this result
and transcripts as an artifact. A local toolchain check is not live evidence.

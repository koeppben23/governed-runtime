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

- `StateNoteTest#rejectsMissingOwnership` is the retained claim's bound positive
  evidence and covers the FULL claimed property: null, empty, and
  whitespace-only owners are rejected.
- `StateNoteFalsificationProbeTest#rejectsMissingOrBlankOwnership` is the
  independent adversarial counterexample over the same rejection property.
  Overlapping test inputs are intentional: admissible evidence requires
  distinct check attempts and evidence roles, not disjoint test inputs.
  Removing the guard makes BOTH rejection assertions fail; weakening
  `isBlank()` to `isEmpty()` makes them fail on the whitespace-only inputs.
- `StateNoteTest#storesValidOwnership` is a supplementary accept-path
  observation (valid owner is stored and read back); it is not bound as claim
  evidence.
- None of the JUnit probes observes the invariant sentence or the review
  comment. Those are documentation evidence, confirmed by actual content/diff
  evidence.
- The falsification probe is guarded by `FLOWGUARD_LIVE_SKIP_ASSERTION` as an
  intentional negative-case control hook. A skipped probe is not sufficient
  adversarial evidence: FlowGuard binds skipped assertions as not_verified and
  the demo oracle requires the bound assertion to be passed.
- `build` (`./mvnw verify`) and `test` (`./mvnw test`) both run the Maven test
  phase, so the same JUnit assertions execute under both checks. The required
  independence is the bound attempt identity and evidence role, not disjoint
  test sets; use the detected commands exactly as configured.
- The authoritative risk configuration is the persisted policy snapshot. The
  repository configuration in `.opencode/flowguard.json` is applied after
  install; it is not part of the seed commit and is not the check authority.
  Surefire reports under `target/` are execution outputs, not configuration
  authority.
- Repository observation is scoped to each review obligation. The plan review
  obligation offers only the `head` revision (no base-vs-head comparison during
  plan review); the implementation review carries its own frozen `base`/`head`
  candidate pair for the diff evidence.

The live runner accepts `--evidence-out <file>` and emits build/pin/model identity,
per-turn durations, denial counts and the machine-readable denial baseline from
`expected-denials.json`. Required negative-control denials must be observed;
allowed recoverable codes still need the existing occurrence-bound recovery proof.
The manually dispatched `ProofGraph live controls` workflow retains this result
and transcripts as an artifact. A local toolchain check is not live evidence.

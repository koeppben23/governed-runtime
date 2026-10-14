# Risk-trigger coverage fixture

Isolated minimal Maven repository used by `run-live-risk-trigger-controls.mjs`.
The governed artifact is a Java ownership-enforcing state store under
`src/main/java/fixture/state/`. The repository's `.opencode/flowguard.json`
explicitly maps that authority surface to HIGH-RISK with `state_integrity`, so the
ProofGraph gate requires explicit certificate-authorized coverage for the
current implementation revision.

The Maven wrapper is copied from the Java demo seed at setup time; this fixture
holds only the project files, the JUnit assertions and the ticket.

The live runner accepts `--evidence-out <file>` and emits build/pin/model identity,
per-turn durations, denial counts and the machine-readable denial baseline from
`expected-denials.json`. Required negative-control denials must be observed;
allowed recoverable codes still need the existing occurrence-bound recovery proof.
The manually dispatched `ProofGraph live controls` workflow retains this result
and transcripts as an artifact. A local toolchain check is not live evidence.

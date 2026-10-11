# Risk-trigger coverage fixture

Isolated minimal Maven repository used by `run-live-risk-trigger-controls.mjs`.
The governed artifact lives under `src/state/`, which the canonical risk-path
classifier treats as HIGH-RISK with the `state_integrity` trigger, so the
ProofGraph gate requires explicit certificate-authorized coverage for the
current implementation revision.

The Maven wrapper is copied from the Java demo seed at setup time; this fixture
holds only the project files, the JUnit assertions and the ticket.

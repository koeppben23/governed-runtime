# State authority control

# State review

Extend `src/main/java/fixture/state/ModuleStateStore.java` with a short review comment describing
that the ownership field check was reviewed. Keep the existing invariant sentence
unchanged:

    The module must reject any write that omits the ownership field.

Only `src/main/java/fixture/state/ModuleStateStore.java` may change during implementation.

## Evidence and verification facts

- The retained runtime claim covers missing and blank ownership values (null, empty, or
  whitespace-only). The pre-existing JUnit fixtures observe it through real Maven/Surefire
  execution: `StateNoteTest#rejectsMissingOwnership` is the claim's bound positive evidence and
  covers that full property, `StateNoteTest#storesValidOwnership` is a supplementary accept-path
  observation, and `StateNoteFalsificationProbeTest#rejectsMissingOrBlankOwnership` is the
  independent adversarial counterexample. Overlapping test inputs between the two rejection
  assertions are intentional: admissible evidence requires distinct check attempts and evidence
  roles, not disjoint test inputs.
- Neither fixture observes the invariant sentence or the review comment. Retention of the
  invariant sentence and the content of the review comment are confirmed by actual content/diff
  evidence (or implementation constraints), never by an executed check.
- The falsification probe carries a `FLOWGUARD_LIVE_SKIP_ASSERTION` control hook. A skipped probe
  is not sufficient adversarial evidence — FlowGuard classifies skipped assertions as
  not_verified, and the demo oracle requires the bound adversarial assertion to be passed. Do not
  set that environment variable during validation, and do not treat a green Maven exit code alone
  as evidence that the probe executed.
- Use the actually detected active checks of this workspace. Here they are exactly `build`
  (`./mvnw verify`) and `test` (`./mvnw test`); do not rename them, substitute them, or append
  arguments such as `--`. `verify` also runs the Maven test phase, so the JUnit assertions
  execute under both checks; that shared execution is admissible when the bound attempt
  identities and evidence roles stay separate.
- Surefire reports under `target/` are outputs of an execution, not a pre-existing configuration
  authority, and are not part of the frozen review subject. Base-revision observation is not
  available to this obligation: do not assert base-vs-head comparisons; rely only on evidence
  whose basis is actually available in the run.
- The authoritative risk configuration is the persisted policy snapshot frozen at session start.
  The repository configuration in `.opencode/flowguard.json` is applied after install; it is not
  part of the seed commit and is not the check authority.

Do not modify Java tests, the Maven build, the active checks, assertion reports or the retained
plan claim.

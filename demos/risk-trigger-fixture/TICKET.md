# State authority control

# State review

Extend `src/main/java/fixture/state/ModuleStateStore.java` with a short review comment describing
that the ownership field check was reviewed. Keep the existing invariant sentence
unchanged:

    The module must reject any write that omits the ownership field.

Only `src/main/java/fixture/state/ModuleStateStore.java` may change during implementation.

## Evidence and verification facts

- The retained runtime claim covers missing and blank ownership values (null, empty, or
  whitespace-only). Its positive evidence check is `test`; its counterexample (adversarial)
  check is `build`, bound to the assertion
  `StateNoteFalsificationProbeTest#rejectsMissingOrBlankOwnership`. The pre-existing JUnit
  fixtures observe the property through real Maven/Surefire execution:
  `StateNoteTest#rejectsMissingOwnership` exercises it under the positive `test` check,
  `StateNoteTest#storesValidOwnership` is a supplementary accept-path observation, and the
  falsification probe is the independent adversarial counterexample. Overlapping test inputs
  between the two rejection assertions are intentional: admissible evidence requires separate
  validation attempts with distinct attempt identities per evidence role, not disjoint test
  inputs.
- Neither fixture observes the invariant sentence or the review comment. Retention of the
  invariant sentence and the content of the review comment are confirmed by actual content/diff
  evidence (or implementation constraints), never by an executed check.
- The falsification probe carries a `FLOWGUARD_LIVE_SKIP_ASSERTION` control hook. A skipped probe
  is not sufficient adversarial evidence — FlowGuard classifies skipped assertions as
  not_verified, and the demo oracle requires the bound adversarial assertion to be passed. Do not
  set that environment variable during validation, and do not treat a green Maven exit code alone
  as evidence that the probe executed.
- Check authority has separate layers; do not mix them:
  - Check selection and binding: the persisted active checks and verification candidates of this
    workspace, here exactly `build` and `test`. Do not rename, substitute, add, or omit checks.
  - Executed command: the selected candidate command, here `npm run build --` and
    `npm run test --`. The trailing `--` is FlowGuard's argument-forwarding separator for npm
    scripts, not command drift.
  - Script definition: `package.json` maps `build` to `./mvnw verify` and `test` to
    `./mvnw test`. These script bodies describe the implementation of the candidate commands;
    they are not a separate check authority.
  - `verify` also runs the Maven test phase, so the JUnit assertions execute under both checks;
    that shared execution is admissible because each evidence role is bound to its own attempt.
- Plan review precedes baseline and implementation validation. The plan names executable checks
  and assertions; their execution results are later evidence, not a precondition for plan
  approval.
- Surefire reports under `target/` are outputs of an execution, not a pre-existing configuration
  authority, and are not part of the frozen review subject. Base-revision observation is not
  available to this obligation: do not assert base-vs-head comparisons; rely only on evidence
  whose basis is actually available in the run.
- The authoritative risk configuration is the persisted policy snapshot frozen at session start.
  The repository configuration in `.opencode/flowguard.json` is applied after install; it is not
  part of the seed commit and is not the check authority.

Do not modify Java tests, the Maven build, the active checks, assertion reports or the retained
plan claim.

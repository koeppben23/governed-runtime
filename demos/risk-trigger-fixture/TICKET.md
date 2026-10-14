# State authority control

# State review

Extend `src/main/java/fixture/state/ModuleStateStore.java` with a short review comment describing
that the ownership field check was reviewed. Keep the existing invariant sentence
unchanged:

    The module must reject any write that omits the ownership field.

Only `src/main/java/fixture/state/ModuleStateStore.java` may change during implementation. The
pre-existing `StateNoteTest` and `StateNoteFalsificationProbeTest` verify the
invariant through real Maven/Surefire execution; do not modify Java tests, the
Maven build, the active checks, assertion reports or the retained plan claim.

# Historical V5 export fixture

Fixed archive bytes generated once by the V5-capable commit `33efb381` with
`archiveCompletionExport`. The test does not transform the archive at runtime.

- archive: `historical-v5-export.tar.gz`
- external audit/state snapshot: `historical-v5-session/`
- session: `550e8400-e29b-41d4-a716-4466554400af`
- fingerprint: `700575aea7fc40041c56a1d3`
- archive manifest: `archive-manifest.v4`
- state schema: `v11`
- reviewer transport: `native_task_message_json`, generation 5

This is a deterministic test fixture produced by historical source, not a
released customer archive. The test installs the fixed session/audit snapshot
and archive under an isolated workspace, verifies the unchanged bytes, and
then tampers with the archive while recomputing its sidecar.

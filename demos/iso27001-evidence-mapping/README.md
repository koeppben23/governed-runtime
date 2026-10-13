# ISO/IEC 27001:2022 Evidence-to-Control Demo (offline)

A single, self-checking demonstration of the read-only ISO/IEC 27001:2022
evidence-to-control projection. It runs entirely against a built checkout —
no host, no model, no network — and exits non-zero if any expected outcome
changes.

```bash
npm run build
node demos/iso27001-evidence-mapping/run-demo.mjs
```

Options: `--root <dir>` (must not exist; default: fresh temp dir),
`--keep` (keep the run root for inspection).

## What this demo proves — and what it does not

- It creates a **temporary, standalone foreign git repository** (fixed test
  remote `https://github.com/flowguard-test/iso27001-demo.git`) and seeds it
  with a **synthetic** secure-development session fixture. It never touches
  FlowGuard's own repository.
- It demonstrates the product chain: canonical raw completion export,
  canonical verification, and the `flowguard inspect --iso27001-mapping`
  projection over the verified snapshot.
- The session evidence is **synthetic**. The demo therefore does **not** prove
  the authenticity of a production agent run, does **not** prove production
  state security, and is **not** an ISO/IEC 27001 conformity assessment or
  certification. A verified association is evidence toward a control, never a
  conformity verdict.

## Scenarios

| Scenario | Mapping                      | Expected outcome                                                                                                                                                                                                                                                          |
| -------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Positive | `seed/mapping.positive.json` | Exit 0. A.8.29 `EVIDENCE_LINKED_VERIFIED` (attempt-bound assertion), A.8.32 `EVIDENCE_LINKED_VERIFIED` (plan approval, implementation revision, human decision), organization rule `export.completion` verified through the live binding. Companion report equals stdout. |
| Negative | `seed/mapping.negative.json` | Exit 0 with a valid report. Skipped assertion → `EVIDENCE_MISSING` / `ASSERTION_SKIPPED`; aggregate report → `NOT_VERIFIED` / `ASSERTION_BINDING_NOT_ATTESTED`; the affected control aggregates to `NOT_VERIFIED`.                                                        |
| Tampered | positive mapping             | Exit 2, no report, `PACKAGE_UNVERIFIABLE`. Only the tamper copy is modified; the original package is restored byte-for-byte and re-verifies.                                                                                                                              |

Additional checks in every run: the canonical verifier accepts the published
package, the report package digest matches the verified package digest, no
`ISO_COMPLIANT`/`CONTROL_SATISFIED`/`CERTIFIED`/`AUDIT_PASSED` conclusion
appears, and session state and package bytes are unchanged by the projection.

## How it works

1. **Foreign repository:** `git init` plus the fixed test remote, so the
   workspace fingerprint is deterministic.
2. **Synthetic seed:** `seed/session-state.template.json` and
   `seed/audit.jsonl` are copied into an isolated `OPENCODE_CONFIG_DIR`
   workspace. The variable binding fields are patched and the plan approval
   certificate is re-minted with the canonical primitives
   (`hashText`, `canonicalJsonStringify`, `planApprovalCertificateIdentity`);
   the audit trail is a real, chained `audit-chain.v3` trail.
3. **Canonical export:** `archiveCompletionExport` publishes
   `export-<sessionId>.tar.gz` with its `.sha256` sidecar while the archived
   snapshot still shows the documented pre-completion `EXPORT_READY` boundary;
   afterwards the live session records `COMPLETE` with
   `exportCompletionEvidence` and the `EXPORT_MATERIALIZED` transition through
   the product append adapter.
4. **Canonical verification:** `verifyCompletionExport` must pass before any
   report is produced.
5. **Projection:** the built CLI runs the three scenarios above and the demo
   asserts every status, finding code, and exit code itself.

## Files

- `run-demo.mjs` — orchestration and expectations (the demo entry point).
- `seed/session-state.template.json` — synthetic `EXPORT_READY` session state.
- `seed/audit.jsonl` — chained audit trail with both gate decisions.
- `seed/mapping.positive.json` / `seed/mapping.negative.json` — organization
  mappings.

## Exit codes

- `0` — all scenarios and expectations passed.
- `1` — at least one expectation failed (details on stderr).
- `2` — setup error (missing `dist/`, existing run root, git/tar failure).

## Independent verification

The report records `evidencePackage.packageSha256`. The same package can be
re-verified offline with the existing verifier in a checkout where the
matching FlowGuard version is installed:

```bash
node demos/java-task-manager/verify-evidence-package.mjs \
  <run-root>/opencode-config/workspaces/<fingerprint>/sessions/archive/export-ses_iso27001_demo_session_0001.tar.gz \
  --expect-session ses_iso27001_demo_session_0001
```

Unlike the live demos, this demo is not part of `demos/run-all-demos.sh`: it
needs no model gate or run lease and is executed directly.

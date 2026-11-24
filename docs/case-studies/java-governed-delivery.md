# Governed Java Delivery: Reference Evidence

This case study records a real FlowGuard run against the synthetic Java Task
Manager demo. It is intentionally explicit about what was observed and what was
not.

## Status

| Control                                        | Observed result            | Final acceptance                                       | Evidence                                                                             |
| ---------------------------------------------- | -------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Red-green bug reproduction                     | **PASS**                   | Existing evidence                                      | [red-green.txt](./java-governed-delivery/evidence/red-green.txt)                     |
| Positive control — governed delivery           | **PASS**                   | **Repeat required** on the separately accepted harness | [reference-evidence.json](./java-governed-delivery/evidence/reference-evidence.json) |
| Negative control — missing evidence            | **BLOCKED / NOT_VERIFIED** | Open                                                   | Live plan did not finish; no exact denial was observed                               |
| Integrity control A — package checksum         | **PASS**                   | Historical package; repeat on any new export           | [integrity-controls.json](./java-governed-delivery/evidence/integrity-controls.json) |
| Integrity control B — internal artifact digest | **PASS**                   | Historical package; repeat on any new export           | [integrity-controls.json](./java-governed-delivery/evidence/integrity-controls.json) |
| Original package re-verification               | **PASS**                   | Historical package; repeat on any new export           | `exit 0`, `verified: true`                                                           |

**Overall: PARTIAL.** The positive and integrity controls are demonstrated. The
negative control remains `NOT_VERIFIED` and the case study must not be presented
as a completed three-control reference until it is closed.

## Red-green reproduction

The seed starts with 16 tests, 15 passing and one `@Disabled` regression test.
In a separate copy of the unmodified seed, removing only `@Disabled` makes the
test fail with `NullPointerException: existing is null`. An actual
`PUT /tasks/non-existent-id` request against that copy returns HTTP 500.

After the governed fix, the bound build and test checks report 16 passed, 0
failed, 0 errored, 0 skipped. The active test asserts both HTTP 404 and
`$.taskId == "non-existent-id"`.

## Positive control

The development flow completed through the real host command boundary:

- `/start`, `/task --file TICKET.md`, `/plan`, host approval, `/implement`,
  host approval, `/finish`, `/export`, `/archive`.
- Live session phase: `COMPLETE`.
- Archived package state: `EXPORT_READY`, as specified by the export contract.
- Export package: `2b52c7690f7591e8cf39dbce38c3a88a8b29a843f1a5cc61669d00aceae9d259`.
- Offline verifier: `exit 0`, `verified: true`, no findings.

The two independent implementation reviews are recorded in the host-session
metadata and the package's review artifacts.

## Negative control

The required negative control was attempted with the existing
claim-control scenario. The live `claim-negative` plan did not finish within
40 minutes and the run was stopped. No `PROOFGRAPH_CRITICAL_FACTS_UNPROVEN`
denial was observed for this reference run.

This is **not** a pass. The prior [ProofGraph live controls](../../demos/java-task-manager/PROOFGRAPH_LIVE_CONTROLS.md)
document the intended denial contract, but that prior evidence is not a
substitute for a new observed run. The negative control must be rerun on a
fresh isolated host before this case study can be marked complete.

## Integrity controls

The original package verifies with exit code 0. Two independent copies were
then tested:

- **A:** package bytes changed while the original sidecar digest was retained.
  The verifier exits 1 with `archive_checksum_mismatch`.
- **B:** `state/session-state.json` changed, the package was repacked, and only
  the outer checksum sidecar was recomputed. The verifier exits 1 with
  `file_digest_mismatch`.

The original package is unchanged and still verifies with exit code 0
afterwards. This demonstrates detection of the two specified manipulations. It
does not demonstrate protection against an attacker who can consistently
rewrite the package, manifest, and every checksum, nor does it prove origin
authenticity.

## Environment and identity

| Item                      | Value                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| Product commit            | `7a01f4c209b6875aad3fc65947ac6b7b78a7dc9d`                                                       |
| Version                   | `2.0.0-tp.2`                                                                                     |
| Tarball SHA-256           | `49c178ed7e84f2f4e7a9c4bcbbe8d07e67d754438fef4d9b4b75495ad44fa77f`                               |
| Host                      | OpenCode CLI `2.2.5`                                                                             |
| Model                     | `deepseek/deepseek-flash`, thinking disabled, reasoning effort `none`                            |
| Node / npm                | `22.22.2` / `10.9.11`                                                                            |
| Java / Maven              | `21.0.13.1` / `3.9.5`                                                                            |
| Policy                    | `team`, `human_gated`; digest `ebe10c074fe6b1d359e76bb63b8ed08a501fc40426f04b6bc664660953b8a4ce` |
| Parent host session       | `ses_df179688dffektuwvOOVINJBIc`                                                                 |
| FlowGuard session         | `a6cbcf1d-864c-4061-968e-f6aa94be5983`                                                           |
| Reviewer sessions         | `ses_df1769946ffeIgZPp6JLKs1fax`, `ses_df1745c41ffeYlNCsZzy3FYweP`                               |
| Plan approval certificate | `d29e4453-7630-4571-8d29-1744ea9ff4e8`                                                           |
| Implementation digest     | `0e4dfcfa62c5cb695715082e1974a3072d437c386e209577d543f3e4c2417663`                               |

### Harness identity

The product tarball and host are pinned, but the positive run used a **modified
local demo harness worktree**. Its base commit is
`7a01f4c209b6875aad3fc65947ac6b7b78a7dc9d`; the exact local patch was not
preserved as a commit, so `patchDigest` is `null` and the harness identity is
`NOT_VERIFIED`. Later harness-hardening commits (`51d0674a`, `8c6ffce4`,
`ca07e127`) were removed from this documentation PR and require separate
acceptance.

The red-green and integrity controls used the base-commit Maven wrapper and
verifier. The positive control must be repeated on the separately accepted
harness before this reference is considered complete.

## Evidence files

- [reference-evidence.json](./java-governed-delivery/evidence/reference-evidence.json)
- [red-green.txt](./java-governed-delivery/evidence/red-green.txt)
- [integrity-controls.json](./java-governed-delivery/evidence/integrity-controls.json)
- [package-manifest.json](./java-governed-delivery/evidence/package-manifest.json)

The synthetic raw package is **withheld from the current draft tree** pending
explicit owner approval after a recorded sensitivity review. The manifest
records its SHA-256
(`2b52c7690f7591e8cf39dbce38c3a88a8b29a843f1a5cc61669d00aceae9d259`), the
sidecar hash, and the earlier public draft commit that contained it. Withholding
now is not a confidentiality guarantee for that earlier commit. The integrity
controls were executed against a local copy; publication is a separate approval
decision. Offline verification proves internal consistency, not origin or a
trusted external anchor.

## Reproduction

The evidence was produced with an isolated `HOME`, state directory, config
directory, and service port so the demo did not restart or collide with the
running desktop host. A locally hardened demo harness was used for the live
run; those harness changes are deliberately **not part of this documentation
change** and require separate technical acceptance before the run is
reproducible from `develop`.

A complete reference run requires a host with the pinned OpenCode 2.2.5 CLI and
enough time for the live plan and review steps. All unobserved controls remain
`NOT_VERIFIED`.

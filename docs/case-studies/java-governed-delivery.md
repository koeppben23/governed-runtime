# Governed Java Delivery: Reference Evidence

This case study records real FlowGuard runs against the synthetic Java Task
Manager demo. It is intentionally explicit about what was observed and what was
not.

## Status

| Control                                        | Observed result | Final acceptance | Evidence                                                                             |
| ---------------------------------------------- | --------------- | ---------------- | ------------------------------------------------------------------------------------ |
| Red-green bug reproduction                     | **PASS**        | **PASS**         | [red-green.txt](./java-governed-delivery/evidence/red-green.txt)                     |
| Positive control — governed delivery           | **PASS**        | **PASS**         | [reference-evidence.json](./java-governed-delivery/evidence/reference-evidence.json) |
| Negative control — missing evidence            | **PASS**        | **PASS**         | [reference-evidence.json](./java-governed-delivery/evidence/reference-evidence.json) |
| Integrity control A — package checksum         | **PASS**        | **PASS**         | [integrity-controls.json](./java-governed-delivery/evidence/integrity-controls.json) |
| Integrity control B — internal artifact digest | **PASS**        | **PASS**         | [integrity-controls.json](./java-governed-delivery/evidence/integrity-controls.json) |
| Original package re-verification               | **PASS**        | **PASS**         | `exit 0`, `verified: true`                                                           |

**Overall: COMPLETE.** Both live controls and both integrity checks passed on the
same integrated harness and the same checksummed product tarball. The synthetic
raw package remains withheld from this tree pending explicit owner approval; its
manifest and hashes are published.

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

- `/start`, `/task --file TICKET_CLAIM_CONTROL.md`, `/plan`, host approval,
  `/implement`, host approval, `/finish`, `/export`.
- Live session phase: `COMPLETE`.
- Archived package state: `EXPORT_READY`, as specified by the export contract.
- Export package: `ddce83743a4747152644c2d368e9b5799014338a34127d523113a5df8a3e41dc`.
- Offline verifier: `exit 0`, `verified: true`, no findings.

Both controls submitted the same initial plan candidate through the normal
`/plan` command. The persisted plan version 1 normalised to the candidate digest
`0e572224d6c7e0b47e4f2f4a3dd4a037ed67708a8499c09f509873cde32ac33e` in both
runs, and both used the same verification-candidate identities
`vc_753d3155…` (build) and `vc_3f19a45c…` (test). The independent reviewer
returned `changes_requested` for the initial plan; the subsequent reviewed
revisions were accepted with plan approval certificate
`7102d028-2d0f-448f-8f92-29089c6afec2` and plan digest
`6e8a432e98650f1f096dfd38a522d445de79bc206d2faa9eed11c4482c651dde`.
The two plan-review sessions and the implementation-review session are recorded
in the host-session metadata and the package's review artifacts.

## Negative control

The negative control used a separate fresh workspace and session with the same
ticket, the same initial plan candidate and the same retained critical claim.
The independent review and normal revisions completed, the implementation ran,
and the real evidence gate refused the approval with exactly
`PROOFGRAPH_CRITICAL_FACTS_UNPROVEN` at unchanged `EVIDENCE_REVIEW`. No package
was produced.

The refusal is grounded in a genuine skipped adversarial assertion at otherwise
green checks: the JUnit `FLOWGUARD_LIVE_SKIP_ASSERTION` execution control skips
the probe, and the product records `NOT_VERIFIED` rather than treating the green
aggregate check as proof. The plan's hypothetical `-DskipTests` faulty variant is
design reasoning only; it is not executed and is not added to the delivered
documentation. The approval gate, not a fabricated reviewer verdict or a state
edit, produced the denial.

The initial plan digest in the negative run is the same
`0e572224d6c7e0b47e4f2f4a3dd4a037ed67708a8499c09f509873cde32ac33e`; its
reviewed revision reached plan certificate
`a36c1d59-d099-442c-8822-236c8cd54704` and plan digest
`5934ddcc2af15dd627014b6e0c842096d54847a7fc956139977bcca0f7f9abb3`.
Later reviewed revisions are allowed and are not required to be byte-identical
to the positive run's revisions.

## Integrity controls

The original package verifies with exit code 0. Two independent copies were then
tested:

- **A:** package bytes changed while the original sidecar digest was retained.
  The verifier exits 1 with `archive_checksum_mismatch`.
- **B:** `state/session-state.json` changed, the package was repacked with only
  regular files, and only the outer checksum sidecar was recomputed; the
  manifest was left unchanged. The verifier exits 1 with `file_digest_mismatch`.

The original package is unchanged and still verifies with exit code 0
afterwards. This demonstrates detection of the two specified manipulations. It
does not demonstrate protection against an attacker who can consistently
rewrite the package, manifest, and every checksum, nor does it prove origin
authenticity.

## Environment and identity

| Item                       | Value                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| Product commit             | `ede07f02df05ebee7a4e01751429a4df2e508f66`                                                           |
| Version                    | `2.0.0-tp.2`                                                                                         |
| Tarball SHA-256            | `bafe4c57e97ce31bd7700092c4aab8d721b0017371c1868172dba6692a1d3486`                                   |
| Harness                    | `demo-harness.v6`, integrated `develop@ede07f02`; no local patch                                     |
| Host                       | OpenCode CLI `2.2.5`                                                                                 |
| Model                      | `deepseek/deepseek-flash`, thinking disabled, reasoning effort `none`                                |
| Node / npm                 | `22.22.2` / `10.9.7`                                                                                 |
| Java / Maven               | `21.0.13.1` / `3.9.5`                                                                                |
| Policy                     | `team`, `human_gated`; digest `4ed5e5858689c7345205ffb5b74178eddbe98246e3ef68d8ae3fd2db4b1b5a34`     |
| Positive parent session    | `ses_dedafedf2ffeRyFyTwVJod0xwc`                                                                     |
| Positive FlowGuard session | `97c1fd5e-82bc-4a24-a171-275452714507`                                                               |
| Positive reviewer sessions | `ses_dedaf6f4affe0VN4Rj149vWg0K`, `ses_dedad7ef6ffeX1AAUinDP4SYTE`, `ses_dedae24fcffezaza1GtapgKgKg` |
| Plan approval certificate  | `7102d028-2d0f-448f-8f92-29089c6afec2`                                                               |
| Implementation digest      | `c461946a9de0e2b0c142a4b971a362057ee926624b9f7031d91c37fc1ae5aa31`                                   |
| Negative parent session    | `ses_dedac4888ffetYRaWRpekeRXDu`                                                                     |
| Negative FlowGuard session | `88ab9405-9a91-4e84-917e-fcead6773e51`                                                               |
| Negative reviewer sessions | `ses_dedabd8ffffe2LmJbX41KMQsl5`, `ses_dedaad04fffeOHKVekqRvzp7kN`                                   |
| Negative plan certificate  | `a36c1d59-d099-442c-8822-236c8cd54704`                                                               |
| Negative implementation    | `a74336cc5f220ec54197e919bfe6d23f219bde247e0b8e9aeb8a4197ba47fc7c`                                   |

### Harness identity

The product tarball, host, model and harness are pinned. The runs used the
integrated `develop` checkout at `ede07f02df05ebee7a4e01751429a4df2e508f66`
with no local harness patch. The exact tarball is identified by its SHA-256
above, and both controls installed it with the same `--product-sha` value.

## Evidence files

- [reference-evidence.json](./java-governed-delivery/evidence/reference-evidence.json)
- [red-green.txt](./java-governed-delivery/evidence/red-green.txt)
- [integrity-controls.json](./java-governed-delivery/evidence/integrity-controls.json)
- [package-manifest.json](./java-governed-delivery/evidence/package-manifest.json)

The synthetic raw package is **withheld from the current draft tree** pending
explicit owner approval after a recorded sensitivity review. The manifest
records its SHA-256
(`ddce83743a4747152644c2d368e9b5799014338a34127d523113a5df8a3e41dc`), the
sidecar hash, and the earlier public draft commit that contained a prior
package. Withholding now is not a confidentiality guarantee for that earlier
commit. The integrity controls were executed against a local copy; publication
is a separate approval decision. Offline verification proves internal
consistency, not origin or a trusted external anchor.

## Reproduction

The evidence was produced with an isolated `HOME`, state directory, config
directory, and service port so the demo did not restart or collide with the
running desktop host. The same checksummed tarball was supplied to both
controls, each in a separate fresh root:

```bash
FLOWGUARD_CLAIM_CASES=claim-positive \
  node demos/java-task-manager/run-live-claim-controls.mjs \
  --root <fresh-positive-root> --tarball <flowguard-core-2.0.0-tp.2.tgz> \
  --product-sha ede07f02df05ebee7a4e01751429a4df2e508f66 \
  --model deepseek/deepseek-flash

FLOWGUARD_CLAIM_CASES=claim-negative \
  node demos/java-task-manager/run-live-claim-controls.mjs \
  --root <fresh-negative-root> --tarball <flowguard-core-2.0.0-tp.2.tgz> \
  --product-sha ede07f02df05ebee7a4e01751429a4df2e508f66 \
  --model deepseek/deepseek-flash
```

A complete reference run requires a host with the pinned OpenCode 2.2.5 CLI and
provider credentials. All observed controls are recorded above. The synthetic
package remains withheld; no unresolved control is represented as a pass.

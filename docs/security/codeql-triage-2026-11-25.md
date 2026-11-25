# CodeQL release-diff triage — v2.0.0-tp.3

Date: 2026-11-25. Scope: the 46 baseline alerts on `refs/pull/1274/merge`
and the five follow-up alerts raised while reviewing PR #1276.

The initial release PR [CodeQL check](https://github.com/koeppben23/governed-runtime/runs/139355402808)
on head `43c3fa10ddce904750724dc00951319666fff542` had 38 annotations
(28 high, 10 medium). Matching path and start line, with counts checked at
shared locations, accounts for 38 of the 46 branch alerts in
analysis `2249651388` on merge SHA `c2c1c32292871b7a1a8b139167d648e5775384b6`.
The eight branch alerts without an annotation in that check are
#64, #74, #75, #96, #97, #103, #112 and #113. Both sets are in scope.

No alert is bulk-dismissed. Fixed findings have code changes and regression
evidence; false positives are dismissed individually with the rule-scoped
reason recorded here; the five accepted risks are dismissed under the
owner decisions below.
The historical inventory records the five then-pending risks; their
subsequent [owner decisions](#individual-owner-decisions) are separate from
CodeQL status and release authorization.

## Summary

At independent review (history):

| Disposition                         | Release baseline | Baseline + still-open follow-ups | All reviewed IDs |
| ----------------------------------- | ---------------: | -------------------------------: | ---------------: |
| Fixed                               |               26 |                               26 |               30 |
| False positive                      |               15 |                               16 |               16 |
| Accepted risk (TP.3 owner decision) |                5 |                                5 |                5 |
| **Total**                           |           **46** |                           **47** |           **51** |

After the release scan and the six follow-up corrections:

| Final disposition                      |  Count |
| -------------------------------------- | -----: |
| Fixed                                  |     36 |
| False positive, individually dismissed |     10 |
| Accepted risk (TP.3 owner decision)    |      5 |
| Open                                   |      0 |
| **Total**                              | **51** |

CodeQL's state on the release ref is 33 fixed and 14 dismissed (nine
rule-scoped false positives, four owner-accepted harness risks, and #142),
with zero open. The difference from the substantive table is #103: CodeQL
marks it fixed while its owner-accepted residual remains documented.
#138–#141 are fixed on the triage ref and absent from the release inventory.

The historical inventory rows below keep the disposition from the reviewed
scan; the release review comment follow-up records the six corrections that
were subsequently verified.

## Release baseline inventory

|                                                                             Alert | Rule                                          | Severity | Location                                                            | Class               | Disposition at review               | Evidence                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------: | --------------------------------------------- | -------- | ------------------------------------------------------------------- | ------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   [#64](https://github.com/koeppben23/governed-runtime/security/code-scanning/64) | `js/redos`                                    | high     | `src/discovery/collectors/code-surface-semantic-extractors.ts:218`  | Runtime discovery   | Fixed                               | The scanner walks backward over the method name using constant-size character checks, without an unanchored suffix regex. The code-surface suite covers control flow, generic methods and return types, and a long non-matching prefix with an opening parenthesis that reaches the name check.                     |
|   [#73](https://github.com/koeppben23/governed-runtime/security/code-scanning/73) | `js/bad-tag-filter`                           | high     | `src/audit/iso27001/render-markdown.test.ts:87`                     | Test                | Fixed                               | Case-insensitive hostile-tag assertion; render-markdown suite passed.                                                                                                                                                                                                                                               |
|   [#74](https://github.com/koeppben23/governed-runtime/security/code-scanning/74) | `js/incomplete-sanitization`                  | high     | `scripts/check-legacy-ratchet.mjs:87`                               | Build/CI tooling    | Fixed                               | replaceAll in the diagnostic formatting path.                                                                                                                                                                                                                                                                       |
|   [#75](https://github.com/koeppben23/governed-runtime/security/code-scanning/75) | `js/incomplete-sanitization`                  | high     | `scripts/check-legacy-ratchet.mjs:160`                              | Build/CI tooling    | Fixed                               | replaceAll in the ratchet-growth diagnostic.                                                                                                                                                                                                                                                                        |
|   [#76](https://github.com/koeppben23/governed-runtime/security/code-scanning/76) | `js/incomplete-sanitization`                  | high     | `src/audit/iso27001/render-markdown.ts:46`                          | Runtime audit       | Fixed                               | Single-pass escape map; no chained escape can leave an unescaped backslash.                                                                                                                                                                                                                                         |
|   [#77](https://github.com/koeppben23/governed-runtime/security/code-scanning/77) | `js/incomplete-sanitization`                  | high     | `src/audit/iso27001/render-markdown.ts:51`                          | Runtime audit       | Fixed                               | Inline code escaping merged into one pass.                                                                                                                                                                                                                                                                          |
|   [#78](https://github.com/koeppben23/governed-runtime/security/code-scanning/78) | `js/incomplete-sanitization`                  | high     | `src/audit/iso27001/render-markdown.ts:51`                          | Runtime audit       | Fixed                               | Inline code escaping merged into one pass.                                                                                                                                                                                                                                                                          |
|   [#79](https://github.com/koeppben23/governed-runtime/security/code-scanning/79) | `js/incomplete-sanitization`                  | high     | `src/audit/iso27001/render-markdown.ts:51`                          | Runtime audit       | Fixed                               | Inline code escaping merged into one pass.                                                                                                                                                                                                                                                                          |
|   [#80](https://github.com/koeppben23/governed-runtime/security/code-scanning/80) | `js/incomplete-sanitization`                  | high     | `src/audit/iso27001/render-markdown.ts:51`                          | Runtime audit       | Fixed                               | Inline code escaping merged into one pass.                                                                                                                                                                                                                                                                          |
|   [#81](https://github.com/koeppben23/governed-runtime/security/code-scanning/81) | `js/incomplete-sanitization`                  | high     | `src/audit/iso27001/render-markdown.ts:51`                          | Runtime audit       | Fixed                               | Inline code escaping merged into one pass.                                                                                                                                                                                                                                                                          |
|   [#82](https://github.com/koeppben23/governed-runtime/security/code-scanning/82) | `js/incomplete-sanitization`                  | high     | `src/integration/diagnostics/render.ts:35`                          | Runtime integration | Fixed                               | Single-pass table-cell escape covers backslash, pipe and line breaks.                                                                                                                                                                                                                                               |
|   [#83](https://github.com/koeppben23/governed-runtime/security/code-scanning/83) | `js/incomplete-multi-character-sanitization`  | high     | `scripts/check-pr-documentation.mjs:18`                             | Build/CI tooling    | Fixed                               | Comment removal repeats to a fixed point and rejects unterminated comments.                                                                                                                                                                                                                                         |
|   [#84](https://github.com/koeppben23/governed-runtime/security/code-scanning/84) | `js/incomplete-multi-character-sanitization`  | high     | `src/documentation/__tests__/development-lifecycle.test.ts:72`      | Test                | Fixed                               | Test helper strips nested HTML comments to a fixed point before assertions.                                                                                                                                                                                                                                         |
|   [#87](https://github.com/koeppben23/governed-runtime/security/code-scanning/87) | `js/file-system-race`                         | high     | `demos/lib/host-config.mjs:94`                                      | Demo harness        | Accepted risk (TP.3 owner decision) | The helper reads and rewrites the caller-selected host config; exclusive access is not enforced.                                                                                                                                                                                                                    |
|   [#92](https://github.com/koeppben23/governed-runtime/security/code-scanning/92) | `js/file-system-race`                         | high     | `demos/risk-trigger-fixture/run-live-risk-trigger-controls.mjs:385` | Demo harness        | Accepted risk (TP.3 owner decision) | The fixture merge writes installed workspace config; absence of concurrent writers is an operator assumption.                                                                                                                                                                                                       |
|   [#93](https://github.com/koeppben23/governed-runtime/security/code-scanning/93) | `js/file-system-race`                         | high     | `demos/reviewer-reference-suite/run-live.mjs:342`                   | Demo harness        | Accepted risk (TP.3 owner decision) | The runner edits its installed reviewer agent under an operator-selected root; the root is not pinned.                                                                                                                                                                                                              |
|   [#94](https://github.com/koeppben23/governed-runtime/security/code-scanning/94) | `js/file-system-race`                         | high     | `demos/reviewer-reference-suite/run-live.mjs:361`                   | Demo harness        | Accepted risk (TP.3 owner decision) | The runner rewrites installed reviewer config after reading it, subject to the same operating assumptions.                                                                                                                                                                                                          |
|   [#95](https://github.com/koeppben23/governed-runtime/security/code-scanning/95) | `js/file-system-race`                         | high     | `evals/agent-instructions/runners/process-runner.ts:136`            | Eval tooling        | Fixed                               | Snapshots use the canonical bounded `O_NOFOLLOW` handle reader with a 1 MB cap; disappeared files become observation errors instead of silent omissions. Ancestor-directory replacement remains an operator-controlled fixture-root assumption documented in code. Symlink and oversized-read tests cover the path. |
|   [#96](https://github.com/koeppben23/governed-runtime/security/code-scanning/96) | `js/file-system-race`                         | high     | `scripts/__tests__/agent-instruction-linter.test.ts:517`            | Test                | Fixed                               | Recursive fixture conversion uses Dirent type instead of a path stat.                                                                                                                                                                                                                                               |
|   [#97](https://github.com/koeppben23/governed-runtime/security/code-scanning/97) | `js/file-system-race`                         | high     | `scripts/__tests__/agent-instruction-linter.test.ts:517`            | Test                | Fixed                               | Same file conversion, second alert instance.                                                                                                                                                                                                                                                                        |
|   [#98](https://github.com/koeppben23/governed-runtime/security/code-scanning/98) | `js/file-system-race`                         | high     | `src/adapters/persistence-audit-cache.test.ts:64`                   | Test                | False positive                      | The test deliberately stat+reads a temporary audit file to preserve mtime while tampering; the race is the test subject in an isolated mkdtemp directory.                                                                                                                                                           |
|   [#99](https://github.com/koeppben23/governed-runtime/security/code-scanning/99) | `js/file-system-race`                         | high     | `src/adapters/persistence-audit-cache.test.ts:68`                   | Test                | False positive                      | Second operation of the same tamper test; same isolated fixture.                                                                                                                                                                                                                                                    |
| [#100](https://github.com/koeppben23/governed-runtime/security/code-scanning/100) | `js/file-system-race`                         | high     | `src/adapters/persistence-lock-exclusivity.test.ts:316`             | Test                | False positive                      | The lock test stat+reads its own lock file to assert inode and bytes are unchanged; no path is attacker-controlled.                                                                                                                                                                                                 |
| [#101](https://github.com/koeppben23/governed-runtime/security/code-scanning/101) | `js/file-system-race`                         | high     | `src/adapters/persistence-lock-exclusivity.test.ts:323`             | Test                | False positive                      | Second read in the same unchanged-lock assertion.                                                                                                                                                                                                                                                                   |
| [#102](https://github.com/koeppben23/governed-runtime/security/code-scanning/102) | `js/file-system-race`                         | high     | `src/cli/inspect-iso27001.ts:81`                                    | Product CLI         | Fixed                               | Mapping read uses an O_NOFOLLOW handle and fstat; inspect-iso suite passed.                                                                                                                                                                                                                                         |
| [#103](https://github.com/koeppben23/governed-runtime/security/code-scanning/103) | `js/file-system-race`                         | high     | `src/cli/platform-uninstall.ts:105`                                 | Product CLI         | Accepted risk (TP.3 owner decision) | The pre-unlink identity check mitigates but does not eliminate the pathname race. Containment depends on trusted ancestor directories; see the [production residual](#residual-production-risk--103).                                                                                                               |
| [#104](https://github.com/koeppben23/governed-runtime/security/code-scanning/104) | `js/file-system-race`                         | high     | `src/documentation/__tests__/live-host-export.test.ts:83`           | Test                | Fixed                               | Single read replaces stat+read in the export-size assertion.                                                                                                                                                                                                                                                        |
| [#105](https://github.com/koeppben23/governed-runtime/security/code-scanning/105) | `js/file-system-race`                         | high     | `src/documentation/__tests__/live-host-export.test.ts:84`           | Test                | Fixed                               | Second read of the same exported file removed.                                                                                                                                                                                                                                                                      |
| [#106](https://github.com/koeppben23/governed-runtime/security/code-scanning/106) | `js/file-system-race`                         | high     | `src/integration/diagnostics/review-subject.ts:214`                 | Runtime integration | Fixed                               | Implementation diff uses an O_NOFOLLOW handle and fstat; diagnostics views passed.                                                                                                                                                                                                                                  |
| [#107](https://github.com/koeppben23/governed-runtime/security/code-scanning/107) | `js/insecure-temporary-file`                  | high     | `demos/lib/run-lease.mjs:60`                                        | Demo harness        | False positive                      | Demo lease uses writeFileSync(...,{flag:"wx"}) (atomic exclusive create) with a random token; existing files are never overwritten.                                                                                                                                                                                 |
| [#108](https://github.com/koeppben23/governed-runtime/security/code-scanning/108) | `js/insecure-temporary-file`                  | high     | `src/adapters/persistence-lock-guard.ts:129`                        | Runtime adapter     | False positive                      | Guard entry is written with flag "wx" inside a directory acquired by atomic mkdir; a pre-existing entry is never overwritten.                                                                                                                                                                                       |
| [#109](https://github.com/koeppben23/governed-runtime/security/code-scanning/109) | `js/insecure-temporary-file`                  | high     | `src/cli/demo-evidence-verify.smoke.test.ts:721`                    | Test                | Fixed                               | Exclusive wx creation for the hostile archive fixture.                                                                                                                                                                                                                                                              |
| [#110](https://github.com/koeppben23/governed-runtime/security/code-scanning/110) | `js/insecure-temporary-file`                  | high     | `src/cli/demo-evidence-verify.smoke.test.ts:749`                    | Test                | Fixed                               | Exclusive wx creation for the duplicate-member archive.                                                                                                                                                                                                                                                             |
| [#111](https://github.com/koeppben23/governed-runtime/security/code-scanning/111) | `js/insecure-temporary-file`                  | high     | `src/cli/demo-evidence-verify.smoke.test.ts:751`                    | Test                | Fixed                               | Exclusive wx creation for its checksum sidecar.                                                                                                                                                                                                                                                                     |
| [#112](https://github.com/koeppben23/governed-runtime/security/code-scanning/112) | `js/insecure-temporary-file`                  | high     | `src/logging/file-sink.test.ts:203`                                 | Test                | Fixed                               | Exclusive wx creation for the path-anomaly fixture.                                                                                                                                                                                                                                                                 |
| [#113](https://github.com/koeppben23/governed-runtime/security/code-scanning/113) | `js/insecure-temporary-file`                  | high     | `src/logging/file-sink.test.ts:218`                                 | Test                | Fixed                               | Exclusive wx creation for the non-directory root fixture.                                                                                                                                                                                                                                                           |
|   [#65](https://github.com/koeppben23/governed-runtime/security/code-scanning/65) | `js/bad-code-sanitization`                    | medium   | `src/cli/opencode-native-test-helpers.ts:85`                        | Product CLI         | False positive                      | Test helper encodes a test-authored script as base64 for the pinned host fixture; no product or external input reaches the command.                                                                                                                                                                                 |
|   [#66](https://github.com/koeppben23/governed-runtime/security/code-scanning/66) | `js/bad-code-sanitization`                    | medium   | `src/cli/opencode-reviewer-capture-test-helpers.ts:70`              | Product CLI         | False positive                      | The injected setup is a test-owned TypeScript string passed only by the reviewer capture suite; it is not a runtime input.                                                                                                                                                                                          |
|   [#67](https://github.com/koeppben23/governed-runtime/security/code-scanning/67) | `js/bad-code-sanitization`                    | medium   | `src/cli/opencode-reviewer-capture-test-helpers.ts:71`              | Product CLI         | False positive                      | Second interpolation site of the same test-owned setup string.                                                                                                                                                                                                                                                      |
|   [#68](https://github.com/koeppben23/governed-runtime/security/code-scanning/68) | `js/stack-trace-exposure`                     | medium   | `scripts/opencode-v2-probe/lib/provider.mjs:5`                      | Build/CI tooling    | False positive                      | `String(error)` is `Error.prototype.toString()` and contains no stack frames; this test-only provider never serializes `error.stack`. The source is unchanged because its byte digest is bound into Phase-02 observation evidence.                                                                                  |
|   [#69](https://github.com/koeppben23/governed-runtime/security/code-scanning/69) | `js/stack-trace-exposure`                     | medium   | `src/hooks/shared/http-transport.ts:130`                            | Runtime hook        | Fixed                               | Transport DENY reason is static; no error message/stack reaches the response body. http-server.transport tests passed.                                                                                                                                                                                              |
|   [#70](https://github.com/koeppben23/governed-runtime/security/code-scanning/70) | `js/shell-command-injection-from-environment` | medium   | `scripts/opencode-v2-probe/lib/isolation.mjs:126`                   | Build/CI tooling    | False positive                      | Constant /bin/sh script with the binary passed as a quoted positional argument; no shell interpolation of environment data.                                                                                                                                                                                         |
|   [#71](https://github.com/koeppben23/governed-runtime/security/code-scanning/71) | `js/shell-command-injection-from-environment` | medium   | `src/cli/java-demo-install.smoke.test.ts:80`                        | Test                | False positive                      | Constant bash -c script; tarball, library and scope are positional arguments quoted as "$1"..."$3", never interpolated.                                                                                                                                                                                             |
|   [#72](https://github.com/koeppben23/governed-runtime/security/code-scanning/72) | `js/shell-command-injection-from-environment` | medium   | `src/cli/java-demo-install.test.ts:24`                              | Test                | False positive                      | Constant bash -c script with positional arguments and a test-local fake PATH; no external value is interpolated.                                                                                                                                                                                                    |
| [#114](https://github.com/koeppben23/governed-runtime/security/code-scanning/114) | `js/indirect-command-line-injection`          | medium   | `scripts/opencode-v2-probe/lib/isolation.mjs:126`                   | Build/CI tooling    | False positive                      | Second rule at the same constant shell invocation; same positional-argument evidence.                                                                                                                                                                                                                               |
| [#115](https://github.com/koeppben23/governed-runtime/security/code-scanning/115) | `js/indirect-command-line-injection`          | medium   | `src/cli/java-demo-install.smoke.test.ts:80`                        | Test                | False positive                      | Second rule at the same Java-demo verification helper; same positional-argument evidence.                                                                                                                                                                                                                           |

## Triage follow-up inventory

| Alert                                                                             | Rule                         | Location                                       | Disposition                 | Evidence                                                                                                                                                                                              |
| --------------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#138](https://github.com/koeppben23/governed-runtime/security/code-scanning/138) | `js/insecure-temporary-file` | `src/cli/demo-evidence-verify.smoke.test.ts`   | Fixed                       | Duplicate-member archive uses exclusive `wx` creation inside a fresh `mkdtemp` directory.                                                                                                             |
| [#139](https://github.com/koeppben23/governed-runtime/security/code-scanning/139) | `js/insecure-temporary-file` | `src/logging/file-sink.test.ts`                | Fixed                       | The `.opencode` file fixture uses exclusive `wx` creation under a fresh `mkdtemp` directory.                                                                                                          |
| [#140](https://github.com/koeppben23/governed-runtime/security/code-scanning/140) | `js/insecure-temporary-file` | `src/logging/file-sink.test.ts`                | Fixed                       | The non-directory root fixture uses exclusive `wx` creation inside a fresh `mkdtemp` directory.                                                                                                       |
| [#141](https://github.com/koeppben23/governed-runtime/security/code-scanning/141) | `js/file-system-race`        | `src/cli/platform-uninstall-ownership.test.ts` | Fixed                       | The test asserts that the mismatched identity was skipped and the file still exists, without a post-check content read.                                                                               |
| [#142](https://github.com/koeppben23/governed-runtime/security/code-scanning/142) | `js/insecure-temporary-file` | `src/shared/safe-file-read.ts`                 | False positive; GitHub open | The opener uses `O_RDONLY` plus optional `O_NOFOLLOW` and `O_NONBLOCK`. It does not pass `O_CREAT` and cannot create a temporary file. This reasoning is limited to the temporary-file creation rule. |

## Candidate reconciliation

- **Triage PR #1276:** Head `bbe2f696ee62867d4bc2f9ce67c1b24d453fee0f`,
  merge SHA `b00b082afa0924a7541e530cfcd105f784c86e56`, analysis
  `2250816693`. The alert API marked #138–#141 fixed and listed only #142 as
  open. The `codeql-sast` workflow job succeeded, but the separate
  [CodeQL alert check](https://github.com/koeppben23/governed-runtime/runs/139449073996)
  failed on #142.
- **Triage follow-up #1276:** Head `9f54c7c9ece610bc0acfeed9cd6141db9a7ab41d`,
  merge SHA `c5ac515874f983b56181df0e7f198af285ba7aef`, analysis
  `2251048579`. The workflow passed and the
  [CodeQL alert check](https://github.com/koeppben23/governed-runtime/runs/139468242267)
  failed only on #142. The six follow-up corrections generated no new
  CodeQL findings on the triage ref. Their baseline alert IDs still need
  verification on the updated release ref.
- **Release PR #1274:** Head `42b301ce0102cf1a60dd9e00cf9b72628c0ff57a`,
  merge SHA `2cea04c700c3df19e67e9843ab4c3aa98ad429d2`, analysis
  `2251154566`. The scan produced 14 results: the six follow-up corrections
  are fixed, and the nine rule-scoped false positives plus four
  owner-accepted harness risks were individually dismissed. #142 remains
  dismissed as a rule-scoped false positive. Final state on the release ref:
  33 fixed, 14 dismissed, zero open; the
  [CodeQL alert check](https://github.com/koeppben23/governed-runtime/runs/139476973107)
  passes. #103 remains a documented production residual even though the
  scanner marks it fixed. #138–#141 are triage-only results.
- **Mutation:** [Run 45690515859](https://github.com/koeppben23/governed-runtime/actions/runs/45690515859)
  on release head `42b301ce0` failed in Stryker's initial test run for the
  same reason: the instrumented PERF test measured 184.15 ms against a
  150 ms limit. The Stryker vitest config now sets `FLOWGUARD_PERF=0`,
  matching the documented coverage-instrumentation boundary; the dedicated
  `integration-perf` gate still enforces the real budgets. A new mutation
  run is required before publication.

## Release review comment follow-up

The Triage follow-up scan detected no new findings. The table tracks
the baseline IDs that still need verification on the updated release ref.

| Alert IDs  | Result in release scan `2251154566`                                                                                                                                        |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #98, #99   | Fixed. The audit-cache fixture stats, reads, overwrites, and restores timestamps through one handle to the same file; unchanged size and tamper rejection remain asserted. |
| #100, #101 | Fixed. Each lock snapshot reads file identity and bytes through one handle, and the final pathname is reopened and compared after the contender times out.                 |
| #107       | Fixed. The demo lease adds explicit `0600` to the existing exclusive create so group/other access cannot depend on umask on POSIX.                                         |
| #108       | Fixed. The reclamation guard keeps exclusive creation and specifies `0600` for each fresh owner entry on POSIX; the ownership protocol is unchanged.                       |

## Fixed findings — verification

- `npm run check`, `npm run lint:strict`, `npm run check:format`.
- Targeted suites: `render-markdown`, diagnostics views, code-surface extractors, `http-server.transport`, `platform-uninstall-ownership`, `inspect-iso27001`, `file-sink`, `live-host-export`, `demo-evidence-verify` smoke, `agent-instruction-linter`, `safe-file-read`, and the eval process-runner/forensic regressions.
- The local `npm test` integration phase reported 4,720 passing tests.
  Final release CI, cross-platform checks, and mutation are separate gates.

## Isolation evidence for #87, #92, #93 and #94

- **#87:** `writeIsolatedHostConfig` trusts its caller-provided config
  directory. The risk-trigger runner places it below `--root`; the helper
  accepts existing config and does not establish exclusive access to it.
- **#92:** The risk-trigger runner creates an `evidence` subdirectory with
  mode `0700`, but uses recursive `mkdir` for the root and config directory.
  A new evidence directory does not prove the root or workspace is fresh.
  The merge targets installer-created config inside the fixture workspace.
- **#93 and #94:** The reviewer reference runner rejects an existing root
  at startup, derives its workspace below that root and edits the installed
  agent or config file. The initial existence check does not lock the root
  or pin its ancestors.

For each decision, the operator must confirm a fresh, exclusively controlled
root, trusted ancestors, and no concurrent writer. These are operating
assumptions, not permissions or isolation that the harnesses enforce.

## Residual production risk — #103

Uninstall checks the owned content through an open handle, then compares
the recorded device and inode against the pathname immediately before
`unlink`. Node has no portable unlink-by-fd. The comparison does not make
deletion atomic or pin any directory along the path.

Confinement to the plugin tree assumes that all ancestor directories used
to resolve the target, including the plugin root and its parent chain,
cannot be replaced or redirected by an untrusted writer. With stable
directories, a writer can still swap the final entry between the check and
`unlink`. If an ancestor can be changed, `unlink` can resolve outside the
original plugin tree, subject to the uninstall process's permissions. An
individual decision on #103 must explicitly cover both the trusted-ancestor
assumption and the remaining check-to-unlink window.

## Individual owner decisions

On 2026-11-25, repository owner `@koeppben23` individually accepted #87,
#92, #93, #94, and #103 for `v2.0.0-tp.3` only, subject to the conditions
documented above. The signed-in owner's review comments record the decision
and conditions for each alert:

- [Triage PR #1276](https://github.com/koeppben23/governed-runtime/pull/1276#pullrequestreview-6063973385)
  at head `9f54c7c9ece610bc0acfeed9cd6141db9a7ab41d`.
- [Release PR #1274](https://github.com/koeppben23/governed-runtime/pull/1274#pullrequestreview-6063973415)
  at head `93e01e5d6b47f306d55985c71e3b1ef1ff566532`.

These decisions did not by themselves change CodeQL alert state. The four
harness alerts were subsequently dismissed as `won't fix` under these
conditions; #103 is marked fixed by CodeQL but remains a documented residual.
The decisions waive no required check and do not authorize a merge, tag, or
publication. The release remains blocked on the final candidate's verification.

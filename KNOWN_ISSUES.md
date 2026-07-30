# Known Issues

This file tracks the sanitized known-issues inventory derived from the
2026-06-08 static analysis. The full triage umbrella is tracked in
[#487](https://github.com/koeppben23/governed-runtime/issues/487).

The source analysis was read-only and static. Findings that have not been
confirmed by a reproducer, targeted test, or implementation review remain
`NOT_VERIFIED` until triaged. Security-sensitive implementation details are
intentionally summarized here; use the linked issues for implementation scope.

A 2026-06-24 re-verification against `develop` (post-#570) confirmed that four
findings previously marked `Open` were already satisfied in code at the analysis
baseline (I1, I2, I3, G9 — see "Re-Triaged" below) and added three new findings
from a mutation-scope and file-size audit (MUT1, SZ1, SZ2). A 2026-07-10
re-triage confirmed two additional pre-existing fixes (G3, C7), one merged fix
(G7), two additional fixes (H2, C3), and one partial fix (I4). A 2026-07-23
re-triage confirmed the NTP corrections AC4/AC5 (merged via #728), the
flow-aware completeness fix AC7 (merged via #678), and two new assurance
findings: MUT2 (coverage exclusion of production plugin helpers) and MUT3
(release tags do not run mutation testing).

## Status Legend

| Status                 | Meaning                                                   |
| ---------------------- | --------------------------------------------------------- |
| `Fixed`                | Code merged or PR merged for the scoped finding.          |
| `Fixed (pre-existing)` | Finding already satisfied in code before the analysis.    |
| `Partially Fixed`      | Some findings in the group are fixed; others remain open. |
| `Tracked`              | Covered by an open issue or package, not fixed yet.       |
| `Open`                 | Known item without a dedicated child issue yet.           |
| `Not Verified`         | Static-analysis claim still needs confirmation.           |
| `Non-Regression Note`  | Positive finding or behavior to preserve.                 |
| `SEE ALSO`             | Cross-reference note, not a fixable finding.              |

## Fixed

| ID   | Severity    | Status | Tracking   | Summary                                                                                                            |
| ---- | ----------- | ------ | ---------- | ------------------------------------------------------------------------------------------------------------------ |
| G1   | HIGH        | Fixed  | #486, #488 | Regulated four-eyes approval now fails closed for uncomparable identities.                                         |
| G2   | MEDIUM      | Fixed  | #486, #488 | Audit/completeness four-eyes reporting now uses canonical identity comparison.                                     |
| G24  | MEDIUM      | Fixed  | #486, #488 | Actor ID comparison now applies deterministic Unicode canonical normalization.                                     |
| G25  | MEDIUM      | Fixed  | #486, #488 | Dotted-I/casing behavior is pinned by tests without adding confusable policy.                                      |
| AC1  | HIGH        | Fixed  | #416       | Audit chain hashing uses recursive canonical JSON serializer; nested content bound to chainHash.                   |
| H4   | HIGH        | Fixed  | #129       | Hook audit-write failures surfaced via `recordAssuranceWithAudit()` instead of silent downgrade.                   |
| AR1  | HIGH        | Fixed  | #420       | Archive manifest v2 folds `auditChainHead`, `auditEventCount`, and metadata into `contentDigest`.                  |
| G10  | LOW         | Fixed  | #428       | Auto-advance overflow now fail-closed (`AutoAdvanceResult` discriminated union).                                   |
| G5   | LOW         | Fixed  | #418       | Policy mode is a closed enum; near-miss strings can no longer silently disable enforcement.                        |
| C14  | MEDIUM      | Fixed  | #497       | Repo-local tarball install flow must generate checksum evidence required by default-on verification.               |
| R3   | HIGH        | Fixed  | #585       | Central sink-layer redaction applies to all log extras; unknown identity metadata in logs is sanitized by default. |
| R5   | MEDIUM      | Fixed  | #585       | Windows + UNC path redaction implemented in the central log redactor.                                              |
| R6   | MEDIUM      | Fixed  | #585       | Central `redactExtra` deep-walks nested objects/arrays in the logging pipeline.                                    |
| R7   | MEDIUM      | Fixed  | #585       | Central redactors are null/undefined-safe; covered by tests.                                                       |
| R8   | MEDIUM      | Fixed  | #585       | Conservative secret-value scanning (bearer/JWT/sk-/key=value) added to the central log redactor.                   |
| D1   | LOW         | Fixed  | #585       | Central sink-layer redaction sanitizes diagnostic strings regardless of call site.                                 |
| MUT1 | MEDIUM-HIGH | Fixed  | (direct)   | Mutation scope restored: 5 orchestrator/multi-mode files added to stryker scope with unit tests.                   |
| G7   | MEDIUM      | Fixed  | #421       | Abort is a no-op at all terminal phases and no longer overwrites architecture or review terminal state.            |
| AC4  | HIGH        | Fixed  | #728       | NTP requests timestamp T1 at send and use RFC 5905 four-timestamp offset and delay calculations.                   |
| AC5  | HIGH        | Fixed  | #728       | NTP responses require a bound origin timestamp, valid protocol fields, and a non-null transmit timestamp.          |
| AC7  | MEDIUM      | Fixed  | #678       | Completeness selects ticket, architecture, or review slots before calculating summary totals.                      |

## Re-Triaged (2026-06-24, 2026-07-10, 2026-07-23)

Findings the static analysis marked `Open` that a `develop` re-verification found
already satisfied in code. Git history shows the relevant logic predates the
analysis baseline, so these were false-positive `Open` statuses rather than
regressions. Re-triaged per the maintenance rule "If a static finding is
disproven, update the status and link the evidence."

| ID  | Severity    | Status               | Evidence                                                                                                                                                                              |
| --- | ----------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | MEDIUM-HIGH | Fixed (pre-existing) | `tools/index.ts` `attachGovernanceFooter` returns a new object via spread; the string path parses a fresh record. Caller arg is not mutated.                                          |
| I2  | MEDIUM      | Fixed (pre-existing) | `enforcement.ts` verdict path only reads `args.reviewVerdict`/`reviewFindings`; the unified mode classifier is pure. No caller-arg mutation.                                          |
| I3  | MEDIUM      | Fixed (pre-existing) | `enforcement.ts` returns `REVIEW_ASSURANCE_STATE_UNAVAILABLE` when session state is absent under strict enforcement; orchestrator fails closed with `PLUGIN_ENFORCEMENT_UNAVAILABLE`. |
| G9  | MEDIUM      | Fixed (pre-existing) | `machine/guards.ts` `isConverged` returns false for `unable_to_review`; tool layer blocks with `SUBAGENT_UNABLE_TO_REVIEW` and routes to a recoverable blocked obligation.            |
| G3  | HIGH        | Fixed (pre-existing) | Reject, changes-requested, and hydrate recovery paths clear `reducedCeremony`; regression tests cover the review-decision paths.                                                      |
| C7  | MEDIUM      | Fixed (pre-existing) | OpenCode configuration is parsed as JSONC and structurally merged before serialization; tests cover comments and existing fields.                                                     |

## Priority Work Packages

| Package | Priority | Status          | Findings                                       | Summary                                                                                                                                                             |
| ------- | -------- | --------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A       | P1       | Partially Fixed | G1, G2, G24, G25, G26                          | Four-eyes and identity normalization/reporting. G1/G2/G24/G25 fixed; G26 remains open.                                                                              |
| B       | P1       | Partially Fixed | AC1, AC2, AC3, AC4, AC5, TSA1, TSA2            | Hash-chain, canonical digest, TSA, and NTP hardening. AC1, AC3, AC4, and AC5 fixed; AC2 and TSA1–TSA2 remain open.                                                  |
| C       | P1       | Partially Fixed | AR1, AR2, AUD2                                 | Archive integrity and audit write-lock recovery. AR1 and AUD2 fixed (#670); AR2 remains open.                                                                       |
| D       | P1       | Fixed           | R1, R2, R3, R4, R5, AC3                        | Secret-leak, redaction, logging, telemetry boundaries. R3, R5 fixed (#585); R1, R2, R4, AC3 fixed (redaction fail-closed).                                          |
| E       | P1       | Partially Fixed | H1, H2, H4, C1, C2, C3, C4, C5, M1, M2, M3, I4 | Hook, CLI, MCP, installer, and integration fail-closed hardening. H1, H2, H4, M1, M3 and C2–C5 fixed (#645, #646, #667); I4 partially fixed; C1 and M2 remain open. |
| F       | P2       | Partially Fixed | G3, G7, G9, G15, AC6, AC7, G12, G13            | State-machine correctness and audit completeness. G3 and G9 are fixed pre-existing; G7 is fixed by #421 and AC7 by #678; G15, AC6, and G12–G13 remain open.         |

## High-Priority Findings

| ID   | Severity | Status                     | Summary                                                                                                                                                                   |
| ---- | -------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC2  | HIGH     | Open                       | Timestamp verification must not trust downgraded status when stronger evidence is present.                                                                                |
| AC3  | HIGH     | Fixed                      | Audit argument summarization can expose scalar secrets and needs redaction hardening.                                                                                     |
| AC4  | HIGH     | Fixed                      | NTP offset/delay calculation is RFC-aligned and captures T1 immediately before send (#728).                                                                               |
| AC5  | HIGH     | Fixed                      | NTP responses validate protocol fields, peer-bound origin timestamp, and non-null transmit timestamp (#728).                                                              |
| H1   | HIGH     | Fixed                      | HTTP governance routes require bearer authentication; non-loopback binds need explicit opt-in and token auth.                                                             |
| H2   | HIGH     | Fixed                      | HTTP and command hooks both block mutating tools while review obligations remain unresolved.                                                                              |
| H3   | HIGH     | Open                       | Session ID validation needs Windows/reserved-name hardening.                                                                                                              |
| M1   | HIGH     | Fixed                      | MCP tool execution uses server-scoped response deadlines and admission limits (#645).                                                                                     |
| M2   | HIGH     | Open                       | MCP session/project directory environment inputs need validation.                                                                                                         |
| M3   | HIGH     | Fixed                      | MCP errors use trusted boundary codes and do not reflect arbitrary executor messages (#645).                                                                              |
| C1   | HIGH     | Open                       | Non-OpenCode config install skip/error handling needs explicit surfacing.                                                                                                 |
| C2   | HIGH     | Fixed                      | Exclusive install lock, preflight, and existing-install protection implemented by #667.                                                                                   |
| C3   | HIGH     | Fixed                      | Install mutations use top-level rollback plus crash-recoverable dependency transactions in #667.                                                                          |
| C4   | HIGH     | Fixed                      | Codex marketplace install and uninstall use locked atomic read-modify-write in #667.                                                                                      |
| C5   | HIGH     | Fixed                      | Snapshot and rollback paths reject symlinks and use TOCTOU-hardened operations in #667.                                                                                   |
| I4   | HIGH     | Partially Fixed            | Strict state-read failures block enforcement; missing session-directory mapping still needs fail-closed handling.                                                         |
| R1   | HIGH     | Fixed (code + integration) | Export redaction uses default-deny deep walk. Wired into archive pipeline.                                                                                                |
| R2   | HIGH     | Fixed (code + integration) | Archive pipeline produces redacted files alongside raw, controlled by mandatory tool parameters.                                                                          |
| R4   | HIGH     | Fixed                      | Telemetry error/status export needs scrubbing.                                                                                                                            |
| AUD2 | HIGH     | Fixed                      | Audit write lock safely recovers dead-process stale locks while failing closed for unsafe lock states (#670).                                                             |
| LK1  | LOW      | Mitigated                  | Stale-lock recovery re-verifies content before unlink to avoid deleting a foreign fresh lock; a residual sub-`unlink` OS race remains without an atomic primitive (#673). |

## Medium-Priority Findings

| ID   | Severity | Status          | Summary                                                                                                                                                       |
| ---- | -------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC6  | MEDIUM   | Open            | Review-flow completeness can report complete mid-flow. `TESTED_BUG_BEHAVIOR`.                                                                                 |
| AC7  | MEDIUM   | Fixed           | Completeness summary totals are computed from flow-specific ticket, architecture, or review slots (#678).                                                     |
| AC8  | MEDIUM   | Partially Fixed | Four-eyes reporting now uses structured identity; history handling remains open.                                                                              |
| AC9  | MEDIUM   | Open            | Timestamp imprint comparison and missing-cache behavior need tightening.                                                                                      |
| AC10 | MEDIUM   | Not Verified    | Timestamp token verification should distinguish legacy format from tampering.                                                                                 |
| AC11 | MEDIUM   | Open            | Timestamp comparisons should parse time values instead of relying on lexical order.                                                                           |
| G4   | MEDIUM   | Open            | `team-ci` degradation snapshot mode can remain inconsistent. `TESTED_BUG_BEHAVIOR`.                                                                           |
| G6   | MEDIUM   | Open            | Command policy and terminal handling diverge for HYDRATE/ABORT. `TESTED_BUG_BEHAVIOR`.                                                                        |
| G12  | MEDIUM   | Open            | ADR rejection is not represented in architecture state.                                                                                                       |
| G13  | MEDIUM   | Open            | ADR section validation should use line-anchored matching.                                                                                                     |
| G15  | MEDIUM   | Open            | Transition records lack actor identity.                                                                                                                       |
| G22  | MEDIUM   | Open            | Hydrate risk-class recovery behavior and documentation diverge.                                                                                               |
| G26  | MEDIUM   | Open            | IdP token subject/email persistence normalization remains open.                                                                                               |
| G27  | MEDIUM   | Not Verified    | JWKS fetch needs body-size and redirect-boundary review.                                                                                                      |
| H5   | MEDIUM   | Open            | Stop hook should flush logger sinks before process exit.                                                                                                      |
| H6   | MEDIUM   | Open            | Pre-tool fatal path exit-code behavior needs fail-closed coverage. `TESTED_BUG_BEHAVIOR`.                                                                     |
| H7   | MEDIUM   | Open            | Command hook stdin needs a byte cap.                                                                                                                          |
| H8   | MEDIUM   | Open            | Hook payload working-directory trust boundary needs validation.                                                                                               |
| M4   | MEDIUM   | Open            | MCP schema conversion should not silently become free-form on missing args.                                                                                   |
| M5   | MEDIUM   | Open            | MCP stdout guard JSON-RPC detection needs stricter framing.                                                                                                   |
| C6   | MEDIUM   | Open            | Installer config-dir environment inputs need validation.                                                                                                      |
| C8   | MEDIUM   | Open            | Claude Code plugin install hint should respect force/overwrite semantics.                                                                                     |
| C11  | MEDIUM   | Open            | Serve port allocation has a TOCTOU gap.                                                                                                                       |
| T1   | MEDIUM   | Open            | Mandate section extraction should tolerate heading drift or fail with clearer contract. `TESTED_BUG_BEHAVIOR`.                                                |
| AR2  | MEDIUM   | Open            | Archive timestamp severity should derive from trusted policy state.                                                                                           |
| AR3  | MEDIUM   | Open            | Archive strict-mode escalation diagnostics need consistency.                                                                                                  |
| AR4  | MEDIUM   | Open            | Unexpected-file checks should surface inconclusive directory reads.                                                                                           |
| AR5  | MEDIUM   | Not Verified    | Archive binding event ordering should avoid phantom evidence.                                                                                                 |
| TSA1 | MEDIUM   | Open            | RFC3161 verifier should enforce timestamping EKU.                                                                                                             |
| TSA2 | MEDIUM   | Not Verified    | TSA signature hash algorithm handling needs review.                                                                                                           |
| S1   | MEDIUM   | Open            | State schema versioning needs forward-migration strategy.                                                                                                     |
| S2   | MEDIUM   | Open            | Policy snapshot parse transforms can rewrite historical state.                                                                                                |
| MUT2 | MEDIUM   | Open            | Coverage excludes the production `src/integration/plugin-helpers.ts` by wildcard; its enforcement paths do not count toward the 80% gate or mutation scope.   |
| MUT3 | MEDIUM   | Open            | Release tags can publish without mutation testing because the mutation workflow runs on schedules, manual dispatch, and `release/**` branches, not `v*` tags. |

## Low-Priority And Hardening Findings

| ID   | Severity   | Status       | Summary                                                                                                                                                                                            |
| ---- | ---------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC12 | LOW        | Open         | Audit integrity break reporting behavior should be documented precisely.                                                                                                                           |
| AC13 | LOW        | Open         | Empty audit query combinator semantics need documentation/tests.                                                                                                                                   |
| AC14 | LOW        | Open         | Audit summary should not count non-approve exits as honored review.                                                                                                                                |
| AC15 | LOW        | Open         | Hex parsing can be hardened defensively.                                                                                                                                                           |
| G8   | LOW        | Open         | ABORT topology representation needs consistency review.                                                                                                                                            |
| G11  | LOW        | Open         | Transition application clears error diagnostics unconditionally.                                                                                                                                   |
| G14  | LOW        | Open         | ADR status transition invariants need hardening.                                                                                                                                                   |
| G16  | LOW        | Open         | Implement entry should defensively re-check validation evidence.                                                                                                                                   |
| G17  | LOW        | Open         | Implementation digest path should avoid mutating changed-file order.                                                                                                                               |
| G18  | LOW        | Open         | Profile registry duplicate handling should be explicit.                                                                                                                                            |
| G19  | LOW        | Open         | Profile detection tie-breaking should be documented/deterministic.                                                                                                                                 |
| G20  | LOW        | Open         | Unknown blocked-reason formatting should preserve analytics classification.                                                                                                                        |
| G21  | LOW        | Open         | Archive status invariant should be enforced or tested.                                                                                                                                             |
| G23  | LOW        | Open         | Legacy initiated-by fallback behavior should be documented or tightened.                                                                                                                           |
| G28  | LOW        | Open         | Remote JWKS cache should have bounded eviction.                                                                                                                                                    |
| G29  | LOW        | Open         | Temporal validation tolerance should align with JWT verifier behavior.                                                                                                                             |
| G30  | LOW        | Open         | Token header algorithm validation can fail earlier with clearer diagnostics.                                                                                                                       |
| G31  | LOW        | Open         | Trust-anchor PEM parsing can be stricter.                                                                                                                                                          |
| H9   | LOW        | Open         | Subagent-stop fatal exit behavior needs review.                                                                                                                                                    |
| H10  | LOW        | Open         | HTTP audit append failure logs need better tenant/host context.                                                                                                                                    |
| M6   | LOW        | Open         | MCP error-code mapping should handle digits.                                                                                                                                                       |
| C9   | LOW-MEDIUM | Open         | Windows chmod assumptions should be documented or avoided.                                                                                                                                         |
| C10  | LOW        | Open         | Tarball checksum verification can avoid sync I/O and casing assumptions.                                                                                                                           |
| C12  | LOW        | Open         | Inspect command output should guard terminal-control characters.                                                                                                                                   |
| C13  | LOW        | Open         | Run command cwd validation can be tightened.                                                                                                                                                       |
| I5   | LOW        | Open         | Tool-result parsing fallback should handle CRLF.                                                                                                                                                   |
| T2   | LOW        | Open         | Mandate digest should include enough metadata to detect header drift.                                                                                                                              |
| T3   | LOW        | Open         | Mandate section-count pinning is intentional but should be maintained.                                                                                                                             |
| T4   | LOW        | Open         | Concise mandate mirrors need stronger structural drift checks.                                                                                                                                     |
| R9   | LOW        | Open         | Redaction `none` mode returns original references.                                                                                                                                                 |
| R10  | LOW        | Open         | Redaction tags can retain sensitive basenames.                                                                                                                                                     |
| R11  | LOW        | Open         | File sink rotation depends on local clock.                                                                                                                                                         |
| R12  | LOW        | Open         | Logger sink rejection swallowing is documented; preserve awareness.                                                                                                                                |
| R13  | LOW        | Open         | Telemetry initialization should not permanently disable after transient failure.                                                                                                                   |
| AR6  | LOW        | Open         | Archive finding severity sorting should not rely on lexicographic order.                                                                                                                           |
| AR7  | LOW        | Open         | Archive manifest classification metadata should be considered for digest binding.                                                                                                                  |
| AR8  | LOW        | Not Verified | Decision receipt raw-include defaults need verification.                                                                                                                                           |
| TSA3 | LOW        | Open         | RFC5280 critical-extension handling should be reviewed.                                                                                                                                            |
| TSA4 | LOW        | Open         | TSA imprint comparison can use constant-time comparison.                                                                                                                                           |
| AUD1 | LOW        | Open         | Audit skipped-line count should be surfaced by archive readers.                                                                                                                                    |
| AUD3 | LOW        | Open         | Audit append rename can reuse Windows retry behavior.                                                                                                                                              |
| AUD4 | LOW        | Open         | Sparse-array canonical JSON behavior should be documented/tested.                                                                                                                                  |
| P2   | LOW        | Open         | Session lock EPERM liveness behavior should be reviewed.                                                                                                                                           |
| P3   | LOW        | Open         | Lockfile cleanup behavior after process exit should be documented/hardened.                                                                                                                        |
| S3   | LOW        | Open         | Policy snapshot hash is not detached; documented design.                                                                                                                                           |
| V1   | LOW        | Open         | Verification output digest should separate stdout and stderr.                                                                                                                                      |
| V2   | LOW        | Open         | Verification subprocess environment inheritance should be reviewed.                                                                                                                                |
| V3   | LOW        | Open         | Repair-guidance regex risk remains bounded by sanitization.                                                                                                                                        |
| EA1  | LOW        | Open         | Artifact-type validation should match declared artifact union.                                                                                                                                     |
| EA2  | LOW        | Open         | Review-card metadata needs schema coverage.                                                                                                                                                        |
| SZ1  | LOW-MEDIUM | Open         | Prod files near the 750-LOC blocker: `src/adapters/workspace/evidence-artifacts.ts` (678), `src/config/policy-snapshot-normalize.ts` (692). `src/integration/plugin-audit.ts` relieved 706 -> 603. |
| SZ2  | LOW        | Open         | `dependency-rules.test.ts` (1656 LOC) exceeds the 1500 advisory; split without breaking the cycle-detection logic when it next grows.                                                              |
| CMP1 | SEE ALSO   | Open         | Compliance mapping overlaps AC6, AC7, AC8, and G2.                                                                                                                                                 |

## Cross-Cutting Risks

| Theme                                | Status | Summary                                                                                                    |
| ------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------- |
| Command-hook vs HTTP-hook drift      | Open   | Transport paths must preserve equivalent enforcement semantics.                                            |
| Silent success after caught failures | Open   | Error handling should surface audit/install/workspace failures explicitly.                                 |
| Environment-variable trust boundary  | Open   | Runtime and installer environment inputs need validation/sandboxing review.                                |
| Fail-open behavior                   | Open   | Hooks, MCP, plugin initialization, and audit persistence need fail-closed review.                          |
| Assurance gate drift                 | Open   | MUT2/MUT3 leave production enforcement code outside coverage and formal releases outside mutation testing. |

## Test-Pinned Bug Behaviors

The following fixes require test updates because existing tests pin current
behavior:

| ID  | Status | Test Area                              |
| --- | ------ | -------------------------------------- |
| G4  | Open   | `src/config/policy.test.ts`            |
| AC6 | Open   | `src/audit/audit-completeness.test.ts` |
| AC7 | Open   | `src/audit/audit-completeness.test.ts` |
| G6  | Open   | `src/machine/commands.test.ts`         |
| M2  | Open   | `src/mcp-server/mcp-server.test.ts`    |
| H6  | Open   | `src/hooks/pre-tool-use-fatal.test.ts` |
| T1  | Open   | `src/templates/mandate-drift.test.ts`  |

## Mutation Coverage (MUT1)

The orchestrator split moved review-gate logic into leaf modules that
`orchestrator.ts` only re-exports. Because Stryker mutates files by path, the
re-exported symbols left the mutation scope. Two further security-relevant
modules were never scoped: the single multi-mode classification authority and
the audit-digest canonical serializer — a gap against the documented "mutation
testing on security-critical paths" claim.

Resolved (merged directly to `develop`): unit tests added for the two previously
untested modules and all five files added to `stryker.conf.json` +
`vitest.stryker.config.ts`. A 2026-07-23 full mutation run re-confirmed the
scope at 80.02% overall: `agent-resolution.ts` 100, `orchestrator-output.ts` 100,
`canonical-json.ts` 90.91, `review-validation-mode.ts` 95, and
`orchestrator-detection.ts` 90.38.

## Logging Redaction

The structured-logging series (#578–#584) shipped a path/URL scrubber that was
opt-in per call site and POSIX-only. The logging-hardening work added central,
sink-layer redaction so every log message and `extra` is sanitized before
reaching any sink (console, file, OTLP) — defense-in-depth that no call site can
bypass. The redactor now also strips Windows drive paths, UNC paths, and
high-confidence secret values (bearer tokens, JWTs, sk-/sk*live* keys, and
`password=`/`token=`/`secret=`/`api_key=` assignments). Secret detection is
deliberately conservative to avoid mangling diagnostics. This closes the logging
portion of R3, R5, R6, R7, R8, and D1; the export/archive redaction pipelines are
tracked separately. (Merged via #585.)

## Non-Regression Notes

| ID   | Status              | Summary                                                                                                                                      |
| ---- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| P1   | Non-Regression Note | Atomic and durable write contracts currently use safe temp/write/rename patterns.                                                            |
| NR1  | Non-Regression Note | `safeHashEqual` uses length-aware constant-time comparison pattern.                                                                          |
| NR2  | Non-Regression Note | Chain hash recomputation destructures and recomputes consistently.                                                                           |
| NR3  | Non-Regression Note | Topology gap detection fails closed.                                                                                                         |
| NR4  | Non-Regression Note | Auto-advance self-loop break avoids duplicate ERROR-loop transition writes.                                                                  |
| NR5  | Non-Regression Note | Blocked reason duplicate registration rejects duplicates.                                                                                    |
| NR6  | Non-Regression Note | Next-action resolution remains compile-time exhaustive over phases.                                                                          |
| NR7  | Non-Regression Note | Acyclic module dependencies are test-enforced (`architecture/__tests__/dependency-rules.test.ts` Rule 8) over the real import graph (#563).  |
| NR8  | Non-Regression Note | Adapters/audit/hooks/review use typed errors, not bare `throw new Error` (#534, #539, #542).                                                 |
| NR9  | Non-Regression Note | Diagnostic logs are centrally redacted at the sink layer (message + extra); console/file/OTLP sinks cannot emit unredacted secrets or paths. |
| NR10 | Non-Regression Note | `logging/` owns its `LogLevel` type and must not import `config/`; enforced by the `logging-no-config` rule in `dependency-rules.test.ts`.   |

## Maintenance Rules

- Keep this file aligned with #487 and child issues.
- Mark items `Fixed` only after the relevant PR is merged.
- Preserve finding IDs in child issue titles or descriptions.
- Do not add exploit procedures or sensitive operational detail to this file.
- If a static finding is disproven, update the status and link the evidence.

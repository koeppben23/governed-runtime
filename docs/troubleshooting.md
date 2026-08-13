# Troubleshooting

## Common Issues

### MCP Tool Limits

MCP calls use a response deadline (`FLOWGUARD_MCP_TOOL_TIMEOUT_MS`, default 30000 ms),
a shared concurrency limit (`FLOWGUARD_MCP_MAX_CONCURRENT`, default 10), and a rolling
per-second limit (`FLOWGUARD_MCP_MAX_PER_SECOND`, default 50). Invalid values prevent
the MCP server from starting. `MCP_TOOL_TIMEOUT` means the host response deadline elapsed;
the underlying operation is not cancelled and continues to occupy its concurrency slot.
Because a timed-out executor keeps its slot until it actually settles, enough
simultaneously hung tool calls can permanently exhaust `FLOWGUARD_MCP_MAX_CONCURRENT`.
After that point every further call returns `MCP_RATE_LIMITED` and the server does
not self-heal, because MCP hosts provide no reliable cancellation contract. Restart
the MCP server to clear stuck slots.
`MCP_RATE_LIMITED` means retry after active work completes or the rolling one-second
start window advances.

### Tools Not Discovered

**Symptom:** FlowGuard commands not available in OpenCode.

**Solution:**

```bash
# Reinstall tools (--core-tarball is required)
flowguard install --core-tarball ./flowguard-core-{version}.tgz --force

# Verify installation
flowguard doctor
```

### Session Not Found

**Symptom:** `NO_SESSION` error when running commands.

**Solution:**

```bash
# Create or restore a session
/start

# Or check if session exists
ls ~/.config/opencode/workspaces/*/sessions/
```

### Phase Not Advancing

**Symptom:** Session stuck at a phase.

**Common causes:**

1. Missing required evidence
2. Validation checks failing
3. Required human approval not given
4. Pending independent-review obligation (see `docs/independent-review.md`)

**Solution:**

```bash
# Check current state (read-only — does NOT mutate state)
/status

# Diagnostic explanation of why a tool is blocked
/why

# Try to advance
/continue
```

`/review` is **not** a status command — it is the entry point of the standalone
compliance-report flow (READY only). Use `/status` or `/why` instead.

### External Reviewer Evidence Not Accepted

**Symptom:** Claude Code or Codex produced a reviewer response, but FlowGuard remains pending or blocked.

**Important invariant:** Native Claude/Codex reviewer agents are transport/isolation artifacts only. Review completion still requires validated, obligation-bound `ReviewFindings`.

Each submitted finding must include its required structured `relation` with
non-empty `subjectAnchors`; `evidenceLocations` is required but may be empty.
Legacy `location` text is not accepted.

**Common causes:**

1. The reviewer output is not a complete `ReviewFindings` object.
2. `attestation.toolObligationId`, `iteration`, or `planVersion` does not match the active obligation.
3. A file exists under `.flowguard/sessions/<session-id>/review-evidence/`, but its JSON is invalid or not bindable.
4. The platform is ambiguous and FlowGuard selected `unsupported_blocked`.
5. A `flowguard_decision` was submitted instead of independent ReviewFindings.

**Solution:**

1. Re-run the `flowguard-reviewer` native agent/subagent with the exact Binding Envelope from the FlowGuard tool response.
2. Ensure the reviewer submits via `flowguard_review` or returns a complete `ReviewFindings` object.
3. Run `/continue` to let FlowGuard parse, validate, and bind transport evidence.
4. If the host cannot provide reliable reviewer context, use only a policy-gated `manual_attested` ReviewFindings path; do not use `flowguard_decision` as review evidence.

### Archive Verification Failed

**Symptom:** `verifyArchive()` returns findings.

**Common causes:**

1. File was modified after archiving
2. Archive is corrupted
3. Missing files in archive

**Solution:**

```bash
# Re-archive the session
# (Original session must still exist)
/archive
```

### Policy Mode Not Applied

**Symptom:** Four-eyes not enforced in regulated mode.

**Solution:**

1. Verify config has correct mode:
   ```bash
   cat ~/.config/opencode/flowguard.json
   ```
2. Recreate session with correct mode:
   ```bash
   /hydrate policyMode=regulated
   ```

## Error Codes

All BLOCKED responses carry a `code`, a `reason`, and a `recovery` array. The
canonical registry is in `src/config/reasons.ts`. Every code listed below is a
real, registered reason.

### Session & State

| Code                                      | Description                                                                                 | Solution                                                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NO_SESSION`                              | No session exists for the current workspace                                                 | Run `/hydrate` first                                                                                                                                                 |
| `MISSING_SESSION_ID`                      | Tool call missing session id                                                                | Re-invoke via OpenCode (the runtime injects sessionId)                                                                                                               |
| `MISSING_WORKTREE`                        | Workspace fingerprint cannot be resolved                                                    | Run from inside a git worktree                                                                                                                                       |
| `INVALID_FINGERPRINT`                     | Workspace fingerprint mismatch                                                              | Run `flowguard doctor`                                                                                                                                               |
| `CONFIG_MISSING`                          | Config file is absent                                                                       | Re-run `flowguard install` for this workspace                                                                                                                        |
| `CONFIG_INVALID`                          | Config file failed schema validation                                                        | Restore from a trusted backup or re-install                                                                                                                          |
| `OPENCODE_INSTRUCTION_SOURCE_UNSUPPORTED` | Runtime is on the FlowGuard deny-list of runtimes known not to resolve `instructions[]`     | Switch to an OpenCode runtime not on the deny-list; verify the mandate path is in `instructions[]`; FlowGuard cannot verify activation automatically                 |
| `SCHEMA_VALIDATION_FAILED`                | Persisted session state failed schema check                                                 | Restore from archive — pre-1.0 sessions are not supported                                                                                                            |
| `SESSION_ERROR`                           | Session error received from host runtime                                                    | Check OpenCode logs for root cause; start a new session                                                                                                              |
| `SESSION_LOCK_CONTENDED`                  | Session write lock could not be acquired (a concurrent operation held it past the timeout)  | Wait for the concurrent FlowGuard operation to finish and re-run `/hydrate`; remove a stale `session-state.json.lock` only after confirming no live process holds it |
| `LOCK_TIMEOUT_EXHAUSTED`                  | Session write lock retries exhausted after all attempts                                     | Retry `/check` for the same check kind; run `/status --why-blocked` to inspect session state; if persistent, check session directory for stale lock diagnostics      |
| `STATE_UNAVAILABLE_FOR_REVIEWER_TASK`     | Session state unreadable when reviewer Task requires verifiable state (pre-execution block) | Check filesystem permissions on session state directory; run `flowguard doctor`; restart session and re-run `/hydrate` if state is corrupt                           |
| `REVIEWER_INVOCATION_EXHAUSTED`           | All reviewer subagent retry attempts failed                                                 | Re-run the tool command to create a fresh obligation; check that the reviewer model supports structured output                                                       |
| `TSA_TIMESTAMP_ASSURANCE_FAILED`          | Timestamp authority assurance failed                                                        | Check TSA endpoint availability, trust anchors, and timestamp policy configuration                                                                                   |

### Command & Phase

| Code                       | Description                                                              | Solution                                                                       |
| -------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `COMMAND_BLOCKED`          | Command input or required dependency was blocked before execution        | Fix the blocked input or dependency and retry the command                      |
| `COMMAND_NOT_ALLOWED`      | Command is not in the allowed-phase set for current phase                | Check `docs/commands.md` "Allowed in" for the command                          |
| `COMMAND_SCOPE_DENIED`     | Tool was invoked outside the active explicit command's permitted scope   | Report the command result and wait for the user to invoke the next command     |
| `WRONG_PHASE`              | Tool requires a specific phase precondition                              | Run `/status` to see the current phase, then `/continue`                       |
| `HOST_TOOL_PHASE_DENIED`   | Mutating host tool (bash/write/edit) blocked in investigation-only phase | Use read-only tools (read, glob, grep) during TICKET/PLAN/ARCHITECTURE phases  |
| `HOST_TOOL_UNKNOWN_DENIED` | Unknown host tool denied by default                                      | Use an explicitly supported host tool or extend the canonical allow-list first |
| `INVALID_VERDICT`          | `/review-decision` verdict is not approve/changes_requested/reject       | Pass a valid verdict literal                                                   |
| `INVALID_TRANSITION`       | Topology event not valid for current phase                               | Run `/status` and `/why` for diagnostic explanation                            |

### Validation Evidence

| Code                                    | Description                                                                                                                           | Solution                                                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `VALIDATION_EVIDENCE_REQUIRED`          | Policy requires validation evidence but no Discovery-derived verification commands are active                                         | Re-run discovery and `/hydrate` to detect repo-native checks, or set `validationEvidence.allowNoCommands=true` (governance approval) |
| `VALIDATION_EVIDENCE_UNVERIFIED`        | Policy requires validation evidence but Discovery is not trustworthy (NOT_VERIFIED)                                                   | Run `/hydrate` to restore healthy Discovery and clear any blocked discovery health gate before retrying VALIDATION                   |
| `VALIDATION_EVIDENCE_STACK_NO_COMMANDS` | Discovery detected a technology stack but derived no verification commands; VALIDATION will not pass vacuously (mis-detection hazard) | Re-run `/hydrate` so repo-native checks are detected, or set `validationEvidence.allowNoCommands=true` (governance approval)         |

### Evidence Integrity

| Code                                | Description                                                     | Solution                                                                                       |
| ----------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `EVIDENCE_ARTIFACT_MISSING`         | Required derived ticket/plan artifact missing                   | Restore session directory from trusted archive before continuing                               |
| `EVIDENCE_ARTIFACT_MISMATCH`        | Derived artifact hash inconsistent with current ticket/plan     | Restore artifacts from trusted archive or regenerate from trusted state                        |
| `EVIDENCE_ARTIFACT_IMMUTABLE`       | Attempt to overwrite an already-versioned append-only artifact  | Do not retry the same submission with different content; re-run the tool                       |
| `REVIEW_CARD_ARTIFACT_WRITE_FAILED` | Review card materialization failed (presentation artifact only) | Check filesystem permissions/disk space; runtime transition not affected                       |
| `REVIEW_CARD_ARTIFACT_IMMUTABLE`    | Review card artifact already exists with different content      | Expected — cards are immutable per content digest; a revised card uses a new digest-based path |
| `EMPTY_TICKET`                      | `/ticket` text is empty after trim                              | Provide a substantive ticket description                                                       |
| `EMPTY_PLAN`                        | `/plan` text is empty after trim                                | Provide a substantive plan                                                                     |

### Independent Review (subagent)

| Code                                          | Description                                                                                                                 | Solution                                                                                                                                             |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUBAGENT_REVIEW_NOT_INVOKED`                 | L1 — primary agent submitted a verdict without invoking the reviewer subagent                                               | Read the previous tool response and follow the `next` action                                                                                         |
| `SUBAGENT_REVIEW_REQUIRED`                    | Content-aware review requires reviewFindings from flowguard-reviewer subagent                                               | Call Task tool with subagent_type: "flowguard-reviewer" and pass output as reviewFindings                                                            |
| `SUBAGENT_SESSION_MISMATCH`                   | L2 — `reviewedBy.sessionId` does not match actual subagent session                                                          | Do not edit `reviewedBy.sessionId`; the runtime authoritatively sets it                                                                              |
| `SUBAGENT_PROMPT_EMPTY`                       | L3 — subagent prompt < 200 chars                                                                                            | Use the runtime-built review prompt (do not hand-craft)                                                                                              |
| `SUBAGENT_PROMPT_MISSING_CONTEXT`             | L3 — prompt missing iteration or planVersion context                                                                        | Use the runtime-built prompt                                                                                                                         |
| `SUBAGENT_PROMPT_ARTIFACT_MISSING`            | L3 - prompt ends at the canonical instruction block with nothing appended                                                   | Append the content to review below the final line of `reviewerTaskPrompt`                                                                            |
| `SUBAGENT_FINDINGS_VERDICT_MISMATCH`          | L4 — submitted overallVerdict differs from actual subagent verdict                                                          | Submit the findings exactly as returned by the orchestrator                                                                                          |
| `SUBAGENT_FINDINGS_ISSUES_MISMATCH`           | L4 — submitted blockingIssues count differs from actual count                                                               | Submit the findings exactly as returned                                                                                                              |
| `SUBAGENT_VERDICT_FINDINGS_INCOHERENT`        | Captured review is self-contradictory: `accept` verdict with blocking issues                                                | Return a non-accept verdict, or reclassify/resolve the blocking issues, then re-review                                                               |
| `SUBAGENT_EVIDENCE_REUSED`                    | One-shot review evidence reused for a second obligation                                                                     | Submit a substantively-new artifact for a fresh review obligation                                                                                    |
| `MAX_REVIEW_ITERATIONS_REACHED`               | Retained; no longer emitted — loop force-converges to the review gate                                                       | Use `/review-decision` (approve / request-changes / reject) at the gate                                                                              |
| `SUBAGENT_UNABLE_TO_REVIEW`                   | Reviewer declared the artifact unreviewable; obligation consumed                                                            | Address the reviewer's reason or substantially revise; do not retry the same artifact                                                                |
| `SUBAGENT_TYPE_UNAUTHORIZED`                  | Non-reviewer subagent type blocked by FlowGuard governance (defense-in-depth)                                               | Only `flowguard-reviewer` subagent type is authorized; do not spawn other subagents                                                                  |
| `REVIEWER_TASK_REQUIRES_PENDING_OBLIGATION`   | Reviewer Task started before pending review obligation (pre-execution block)                                                | Run `flowguard_plan` or `flowguard_review` first to create a pending review obligation, then start the reviewer Task                                 |
| `SUBAGENT_CONTEXT_UNVERIFIABLE`               | Strict enforcement cannot validate obligation context from tool output                                                      | Re-run the tool that produced the review obligation                                                                                                  |
| `REVIEW_FINDINGS_REQUIRED`                    | Mode B verdict submitted without `reviewFindings`                                                                           | Include the structured `reviewFindings` object                                                                                                       |
| `REVIEW_FINDINGS_SESSION_MISMATCH`            | Findings came from a different session than the current FlowGuard session                                                   | Use findings produced for the current session                                                                                                        |
| `REVIEW_FINDINGS_HASH_MISMATCH`               | Findings hash does not match the review obligation                                                                          | Re-run the review for the current obligation                                                                                                         |
| `REVIEW_FINDING_SUBJECT_ANCHOR_REQUIRED`      | Reviewer finding has no valid structured subject anchor                                                                     | Anchor the finding to the reviewed change or artifact section                                                                                        |
| `REVIEW_EVIDENCE_LOCATION_ESCAPES_REPOSITORY` | Finding evidence path escapes the repository                                                                                | Remove parent-directory traversal that would leave the repository                                                                                    |
| `REVIEW_EVIDENCE_LOCATION_INVALID`            | Finding evidence location is not a valid repository location                                                                | Use repository-relative evidence paths at the frozen base or head revision                                                                           |
| `REVIEW_FINDING_SUBJECT_ANCHOR_OUT_OF_SCOPE`  | Reviewer finding does not intersect the frozen reviewed subject                                                             | Anchor the finding to the reviewed change or artifact section                                                                                        |
| `REVIEW_REPOSITORY_REVISION_UNAVAILABLE`      | Finding cites a repository revision unavailable to the reviewed subject                                                     | Use only the frozen base or head revision                                                                                                            |
| `REVIEW_IMPLEMENTATION_BASE_FREEZE_FAILED`    | Pre-mutation implementation base could not be frozen before IMPLEMENTATION entry                                            | Ensure a git repository with a resolvable identity and at least one commit                                                                           |
| `REVIEW_OBSERVATION_CAPABILITY_UNKNOWN`       | Observation capability is unknown or its attempt is not usable                                                              | Use exactly the observationCapability from the canonical reviewer prompt for this attempt                                                            |
| `REVIEW_OBSERVATION_AUTHORITY_UNAVAILABLE`    | Revision has no frozen repository authority for this obligation                                                             | Repository evidence is unavailable; do not substitute worktree reads                                                                                 |
| `REVIEW_OBSERVATION_INVALID_ARGS`             | flowguard_observe_repository arguments are invalid                                                                          | Provide capability, revision ("base"                                                                                                                 | "head"), and a repository-relative path |
| `REVIEW_OBSERVATION_PATH_INVALID`             | Observation path is not repository-relative                                                                                 | Use a repository-relative POSIX path                                                                                                                 |
| `REVIEW_OBSERVATION_UNAVAILABLE`              | Frozen repository object cannot be acquired for observation                                                                 | Immutable acquisition has no mutable fallback; the location cannot become evidence                                                                   |
| `REVIEW_OBSERVATION_OVERSIZED`                | Observed blob exceeds the repository observation size bound                                                                 | Oversized content is unavailable as evidence; never truncated                                                                                        |
| `REVIEW_OBSERVATION_UNSUPPORTED_ENTRY`        | Observed path is not materializable at the frozen revision                                                                  | Submodule gitlink entries are not materialized as observations                                                                                       |
| `REVIEW_REPOSITORY_IDENTITY_MISSING`          | Branch source carries no remote or local repository identity                                                                | Re-run the review from its original content input so the identity is resolved again                                                                  |
| `REVIEW_SUBJECT_DIGEST_MISMATCH`              | Re-derived review subject differs from the frozen obligation subject                                                        | Start a new review for the changed content; a frozen subject is immutable                                                                            |
| `REVIEW_SUBJECT_NOT_MATERIALIZED`             | Standalone review source could not be frozen into immutable material                                                        | Resolve exactly one review source before creating or continuing the obligation                                                                       |
| `REVIEW_SUBJECT_SCOPE_UNAVAILABLE`            | Review obligation has no verifiable frozen subject scope                                                                    | Re-run the review after subject scope resolution succeeds                                                                                            |
| `REVIEW_OBLIGATION_NOT_FOUND`                 | Review continuation ID is missing, consumed, blocked, or mismatched                                                         | Use the ID from the original `CONTENT_ANALYSIS_REQUIRED` response; otherwise start a fresh `/review`                                                 |
| `REVIEW_OBLIGATION_ID_REQUIRED`               | Host-task review verdict was submitted without its obligation ID                                                            | Submit the original content, `reviewObligationId`, and the captured reviewer verdict together                                                        |
| `REVIEW_OBLIGATION_AMBIGUOUS`                 | More than one active review obligation could receive the submitted verdict                                                  | Select the exact ID from the original `CONTENT_ANALYSIS_REQUIRED` response                                                                           |
| `REVIEW_OBLIGATION_INPUT_MISMATCH`            | Review continuation ID does not match the supplied immutable review input                                                   | Reuse the exact branch, PR, URL, text, input origin, and references from the original review                                                         |
| `REVIEW_CONTENT_SOURCE_INCOMPLETE`            | `inputOrigin` or `references` declared but no concrete content field provided                                               | Provide `branch=<ref>`, `prNumber=<n>`, `url=<url>`, or non-empty `text`                                                                             |
| `REVIEW_SELF_APPROVAL_DENIED`                 | Manual-attested findings came from the governed parent session                                                              | Invoke `flowguard-reviewer` in a distinct session                                                                                                    |
| `REVIEW_TRANSPORT_EVIDENCE_INVALID`           | External review-evidence transport JSON is malformed or unbindable                                                          | Regenerate evidence with valid obligation-bound `ReviewFindings`                                                                                     |
| `REVIEW_URL_CONTENT_ENCODING_INVALID`         | URL review content is malformed or not strict UTF-8                                                                         | Serve valid UTF-8 content or provide the review content directly                                                                                     |
| `REVIEW_VERDICT_EVIDENCE_MISSING`             | reviewVerdict submitted without matching bound ReviewInvocationEvidence                                                     | Run flowguard-reviewer subagent before submitting verdict                                                                                            |
| `REVIEW_VERDICT_MISMATCH`                     | Submitted verdict does not match captured reviewer overallVerdict                                                           | Use verdict exactly matching reviewer output; do not override                                                                                        |
| `REVIEWER_OUTPUT_RETRY_EXHAUSTED`             | Reviewer output could not be bound after the canonical output-repair retry budget was exhausted                             | Operator intervention required; do not rewrite prompt or fabricate findings                                                                          |
| `REVIEWER_OUTPUT_REPAIR_STALLED`              | Targeted repair reproduced the identical schema error set                                                                   | Inspect or correct the reviewer output mechanism first; after operator intervention, start a fresh `/review` if a new independent attempt is desired |
| `REVIEW_EVIDENCE_NOT_OBSERVED`                | evidenceLocations have no matching authoritative repository observation for this reviewer attempt                           | Cite only locations obtained via flowguard_observe_repository during the attempt; start a fresh review otherwise                                     |
| `REVIEW_REPAIR_UNAVAILABLE`                   | No output-repair reissue is authorized for this rejection (governance, scope, integrity, consistency, or execution failure) | Operator intervention required; the obligation is blocked terminally — do not fabricate findings or bypass the frozen subject                        |
| `REPAIR_PROMPT_REQUIRED`                      | Fresh canonical repair prompt required before re-running reviewer Task                                                      | Call flowguard_review to obtain a new reviewerTaskPrompt with validation errors; never reuse stale prompt                                            |
| `REVIEWER_OUTPUT_SCHEMA_INVALID`              | Reviewer output failed to validate against the canonical ReviewFindings schema                                              | Re-invoke with exact same frozen subject; ensure output matches grammar in prompt                                                                    |
| `REVIEWER_CONTEXT_UNAVAILABLE`                | Canonical reviewer context could not be materialized; no review attempt was created                                         | Restore the persisted Discovery basis or workspace fingerprint, then re-run the review                                                               |
| `INVALID_REVIEW_TOOL_SEQUENCE`                | Review tool call sequence is invalid (e.g. reviewerUnavailable after spawn)                                                 | Follow invocation sequence; do not submit reviewerUnavailable when reviewer spawned                                                                  |
| `REVIEW_ASSURANCE_STATE_UNAVAILABLE`          | Strict review assurance state cannot be read                                                                                | Re-hydrate; if persistent, restore from archive                                                                                                      |
| `REVIEW_ATTEMPT_ID_MISSING`                   | Invocation lacks a persisted attemptId (legacy data)                                                                        | Re-invoke the reviewer subagent for a fresh attempt                                                                                                  |
| `REVIEW_ATTEMPT_LINEAGE_UNAVAILABLE`          | Invocation has no attempt lineage; cannot determine which attempt to reject                                                 | Re-invoke the reviewer; the stale invocation is retained for audit                                                                                   |
| `REVIEW_ATTEMPT_NOT_FOUND`                    | Attempt referenced by invocation was not found in assurance state                                                           | Verify the attempt exists with flowguard_status; re-invoke reviewer if corrupt                                                                       |
| `REVIEW_ASSURANCE_UNAVAILABLE`                | Review assurance state missing; cannot reject an incoherent attempt                                                         | Ensure the session has an active review obligation with an attempt                                                                                   |
| `REVIEW_ATTEMPT_UNAVAILABLE`                  | No attempt can currently bind reviewer evidence; the frozen material is intact                                              | Re-run `flowguard_review` with the original content and `reviewObligationId` to reissue an attempt, then pass the new `reviewerTaskPrompt` verbatim  |

### Review Envelope Validation

| Code                                  | Description                                       | Solution                                                                                |
| ------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `ENVELOPE_CAPTURE_FAILED`             | Reviewer Task tool produced no bindable output    | Re-invoke the reviewer subagent; verify it is reachable                                 |
| `ENVELOPE_PAYLOAD_NOT_FOUND`          | Reviewer output contained no extractable JSON     | Re-invoke the reviewer and ensure it returns ONLY the ReviewFindings JSON               |
| `ENVELOPE_PAYLOAD_AMBIGUOUS`          | Multiple JSON candidates in reviewer output       | Re-invoke the reviewer and ensure exactly one JSON object is returned                   |
| `ENVELOPE_SCHEMA_INVALID`             | Reviewer output failed schema validation          | Re-invoke the reviewer with the canonical prompt; check all required fields are present |
| `ENVELOPE_CLIENT_REFERENCE_INVALID`   | Challenge clientReference is invalid or duplicate | Re-invoke the reviewer with unique, valid clientReference values per challenge          |
| `ENVELOPE_DUPLICATE_CLIENT_REFERENCE` | Duplicate clientReference across challenges       | Re-invoke the reviewer with unique clientReference values per challenge                 |
| `ENVELOPE_SUBJECT_MISMATCH`           | Reviewer evidence bound to wrong artifact digest  | Re-invoke the reviewer for the correct artifact version                                 |
| `ENVELOPE_OBLIGATION_NOT_OPEN`        | Review obligation is not in pending state         | Verify obligation status; start a fresh review cycle if consumed                        |
| `ENVELOPE_STALE_ATTEMPT`              | Review attempt superseded by a newer attempt      | Use the latest attempt; re-invoke if needed                                             |
| `ENVELOPE_RETRY_BUDGET_EXHAUSTED`     | Reviewer capture retries exhausted                | Inspect diagnostics for each failed attempt; run `flowguard doctor`                     |

### Identity & Approvals

| Code                           | Description                                                             | Solution                                                                                                              |
| ------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `ACTOR_ASSURANCE_INSUFFICIENT` | Approver assurance below `policy.minimumActorAssuranceForApproval`      | Set `FLOWGUARD_ACTOR_CLAIMS_PATH` to a valid claim file or configure an identity provider (see `docs/policies.md`)    |
| `ACTOR_IDP_MODE_REQUIRED`      | `policy.identityProviderMode=required` but actor cannot be IdP-verified | Provide a valid `FLOWGUARD_ACTOR_TOKEN_PATH`                                                                          |
| `FOUR_EYES_ACTOR_MATCH`        | Same actor initiated and approved (regulated mode forbids this)         | A different verified actor must approve                                                                               |
| `HUMAN_DECISION_REQUIRED`      | Human-gated policies require an explicit host-command user decision     | Present the review card verbatim and ask the user to run `/review-decision approve`, `/request-changes`, or `/reject` |

### Configuration & Central Policy

| Code                                  | Description                                                            | Solution                                   |
| ------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------ |
| `CENTRAL_POLICY_PATH_EMPTY`           | `FLOWGUARD_POLICY_PATH` set but empty                                  | Unset or point to a valid policy file      |
| `CENTRAL_POLICY_MISSING`              | Central policy file does not exist                                     | Verify the path                            |
| `CENTRAL_POLICY_UNREADABLE`           | Central policy file cannot be read                                     | Check file permissions                     |
| `CENTRAL_POLICY_INVALID_JSON`         | Central policy is not valid JSON                                       | Validate JSON                              |
| `CENTRAL_POLICY_INVALID_SCHEMA`       | Central policy schema check failed                                     | Validate against the policy schema         |
| `CENTRAL_POLICY_INVALID_MODE`         | Central policy `minimumMode` is not one of solo/team/team-ci/regulated | Use a valid mode literal                   |
| `EXPLICIT_WEAKER_THAN_CENTRAL`        | Explicit `--policy-mode` weaker than central minimum                   | Use a mode at or above the central minimum |
| `EXISTING_POLICY_WEAKER_THAN_CENTRAL` | Persisted session policy weaker than current central minimum           | Re-hydrate the session                     |

### Archive

Archive **runtime** errors are surfaced via tool BLOCKED responses; archive
**verification** findings are reported by `verifyArchive()` per
[`docs/archive.md`](./archive.md#verification-finding-codes). The canonical
enum of finding codes lives in `src/archive/types.ts` and covers manifest,
hash chain, content/file digest, archive checksum sidecar, TSA timestamp,
and per-artifact evidence binding integrity.

## Complete Registered Code Index

This index is intentionally compact. The canonical messages, categories, recovery
steps, and quick fixes remain in `src/config/reasons.ts`.

```text
ABORTED
ACTOR_ASSURANCE_INSUFFICIENT
ACTOR_CLAIM_EXPIRED
ACTOR_CLAIM_INVALID
ACTOR_CLAIM_MISSING
ACTOR_CLAIM_PATH_EMPTY
ACTOR_CLAIM_UNREADABLE
ACTOR_IDP_CONFIG_REQUIRED
ACTOR_IDP_MODE_REQUIRED
ADR_APPROVE_WITH_TEXT
ADR_FINDINGS_WITHOUT_VERDICT
ADR_REVIEW_IN_PROGRESS
ADR_SUBMISSION_MIXED_INPUTS
ARCHITECTURE_REVIEW_COMPLETION_REQUIRED
ARCHITECTURE_REVIEW_LOOP_REQUIRED
ARTIFACT_SCHEMA_VALIDATION_FAILED
AUDIT_PERSISTENCE_FAILED
AUTO_ADVANCE_OVERFLOW
CENTRAL_POLICY_INVALID_JSON
CENTRAL_POLICY_INVALID_MODE
CENTRAL_POLICY_INVALID_SCHEMA
CENTRAL_POLICY_MISSING
CENTRAL_POLICY_PATH_EMPTY
CENTRAL_POLICY_UNREADABLE
CHECK_KIND_NOT_AVAILABLE
CHECK_NOT_ACTIVE
COMMAND_BLOCKED
COMMAND_NOT_ALLOWED
COMMAND_SCOPE_DENIED
CONTENT_ANALYSIS_REQUIRED
CONTINUE_AMBIGUOUS
CONTINUE_UNKNOWN_PHASE
DECISION_IDENTITY_REQUIRED
DECISION_RECEIPT_ACTOR_MISSING
DISCOVERY_DRIFT_BLOCKED
DISCOVERY_HEALTH_DEGRADED
DISCOVERY_HEALTH_UNAVAILABLE
DISCOVERY_PERSIST_FAILED
DISCOVERY_RESULT_MISSING
EMPTY_ADR_TEXT
EMPTY_ADR_TITLE
EMPTY_PLAN
EMPTY_TICKET
ENVELOPE_CAPTURE_FAILED
ENVELOPE_CLIENT_REFERENCE_INVALID
ENVELOPE_DUPLICATE_CLIENT_REFERENCE
ENVELOPE_OBLIGATION_NOT_OPEN
ENVELOPE_PAYLOAD_AMBIGUOUS
ENVELOPE_PAYLOAD_NOT_FOUND
ENVELOPE_RETRY_BUDGET_EXHAUSTED
ENVELOPE_SCHEMA_INVALID
ENVELOPE_STALE_ATTEMPT
ENVELOPE_SUBJECT_MISMATCH
EVIDENCE_ARTIFACT_IMMUTABLE
EVIDENCE_ARTIFACT_MISMATCH
EVIDENCE_ARTIFACT_MISSING
EXISTING_POLICY_WEAKER_THAN_CENTRAL
EXPLICIT_WEAKER_THAN_CENTRAL
FINGERPRINT_FAILED
FOUR_EYES_ACTOR_MATCH
GIT_COMMAND_FAILED
GIT_NOT_FOUND
HELP_ARGUMENTS_INVALID
HOST_SUBAGENT_TASK_REQUIRED
HOST_TASK_FINDINGS_UNPARSEABLE
HOST_REVIEW_CONTEXT_UNAVAILABLE
HOST_TOOL_PHASE_DENIED
HOST_TOOL_UNKNOWN_DENIED
HUMAN_DECISION_REQUIRED
HYDRATE_DISCOVERY_CONTRACT_FAILED
IMPLEMENTATION_CHALLENGE_ALREADY_RESOLVED
IMPLEMENTATION_CHALLENGE_NOT_FAILED
IMPLEMENTATION_CHALLENGE_UNKNOWN
IMPLEMENTATION_EVIDENCE_EMPTY
IMPLEMENTATION_EVIDENCE_REQUIRED
IMPLEMENTATION_VALIDATION_ATTEMPT_DUPLICATE
IMPLEMENTATION_VALIDATION_ATTEMPT_DIGEST_MISMATCH
IMPLEMENTATION_VALIDATION_ATTEMPT_FAILED
IMPLEMENTATION_VALIDATION_ATTEMPT_UNKNOWN
IMPLEMENTATION_VALIDATION_ATTEMPT_WRONG_SCOPE
IMPLEMENT_REVIEW_LOOP_REQUIRED
IMPL_VALIDATION_EVIDENCE_REQUIRED
INTERNAL_ERROR
INVALID_ARCHITECTURE_TOOL_SEQUENCE
INVALID_FINGERPRINT
INVALID_IMPLEMENT_TOOL_SEQUENCE
INVALID_PLAN_TOOL_SEQUENCE
INVALID_PROFILE
INVALID_TRANSITION
INVALID_VERDICT
LOCK_TIMEOUT_EXHAUSTED
MCP_RATE_LIMITED
MCP_TOOL_TIMEOUT
MISSING_ADR_SECTIONS
MISSING_CHECKS
MISSING_SESSION_ID
MISSING_WORKTREE
NOT_GIT_REPO
NO_ACTIVE_CHECKS
NO_ARCHITECTURE
NO_IMPLEMENTATION
NO_PLAN
NO_SELF_REVIEW
NO_SESSION
OPENCODE_INSTRUCTION_SOURCE_UNSUPPORTED
ORCHESTRATION_PERMANENTLY_FAILED
PARSE_FAILED
PLAN_APPROVE_WITH_TEXT
PLAN_FINDINGS_WITHOUT_VERDICT
PLAN_REQUIRED
MAX_REVIEW_ITERATIONS_REACHED
PLAN_REVIEW_IN_PROGRESS
PLAN_REVIEW_LOOP_REQUIRED
PLAN_SUBMISSION_MIXED_INPUTS
PLAN_SUBMISSION_REQUIRED
PLUGIN_ENFORCEMENT_UNAVAILABLE
POLICY_SNAPSHOT_MISSING
PROFILE_RESOLUTION_PERSIST_FAILED
PROOFGRAPH_AGGREGATE_CAPABILITY_MISSING
PROOFGRAPH_AGGREGATE_CHECK_MISMATCH
PROOFGRAPH_AGGREGATE_EXTRACTION_MISSING
PROOFGRAPH_AGGREGATE_SCOPE_UNATTESTED
PROOFGRAPH_ASSERTION_BINDING_UNAVAILABLE
PROOFGRAPH_ASSERTION_EVIDENCE_MISSING
PROOFGRAPH_ASSERTION_IDENTITY_MISMATCH
PROOFGRAPH_ASSERTION_PROVIDER_MISMATCH
PROOFGRAPH_CERTIFICATE_INVALID
PROOFGRAPH_CLAIM_CONTRACT_INCOMPLETE
PROOFGRAPH_CLAIM_EVIDENCE_UNRESOLVED
PROOFGRAPH_CLAIM_UNSATISFIABLE
PROOFGRAPH_COUNTEREXAMPLE_OBSERVED
PROOFGRAPH_CRITICAL_FACT_REQUIRED
PROOFGRAPH_CRITICAL_FACTS_UNPROVEN
PROOFGRAPH_EVALUATION_UNAVAILABLE
PROOFGRAPH_EVIDENCE_STALE
PROOFGRAPH_MUTATION_ATTEMPT_UNRESOLVED
PROOFGRAPH_MUTATION_NO_IMPLEMENTATION
PROOFGRAPH_MUTATION_PHASE_INELIGIBLE
PROOFGRAPH_MUTATION_REPORT_INVALID
PROOFGRAPH_MUTATION_REPORT_MISSING
PROOFGRAPH_PROVIDER_EXECUTION_ERROR
PROOFGRAPH_RISK_ASSESSMENT_STALE
READ_FAILED
REGULATED_ACTOR_UNKNOWN
REVIEW_ASSURANCE_STATE_UNAVAILABLE
REVIEW_ATTEMPT_ID_MISSING
REVIEW_ATTEMPT_LINEAGE_UNAVAILABLE
REVIEW_ATTEMPT_NOT_FOUND
REVIEW_ATTEMPT_UNAVAILABLE
REVIEW_ASSURANCE_UNAVAILABLE
REVIEW_BRANCH_PROVENANCE_MISSING
REVIEW_CARD_ARTIFACT_IMMUTABLE
REVIEW_CARD_ARTIFACT_WRITE_FAILED
REVIEW_CONTENT_SOURCE_INCOMPLETE
REVIEW_EVIDENCE_LOCATION_ESCAPES_REPOSITORY
REVIEW_EVIDENCE_LOCATION_INVALID
REVIEW_EVIDENCE_NOT_OBSERVED
REVIEW_FINDING_SUBJECT_ANCHOR_OUT_OF_SCOPE
REVIEW_IMPLEMENTATION_BASE_FREEZE_FAILED
REVIEW_FINDING_SUBJECT_ANCHOR_REQUIRED
REVIEW_FINDINGS_HASH_MISMATCH
REVIEW_FINDINGS_REQUIRED
REVIEW_FINDINGS_SESSION_MISMATCH
REVIEW_ITERATION_MISMATCH
REVIEW_MATERIAL_INTEGRITY_FAILED
REVIEW_MODE_SELF_NOT_ALLOWED
REVIEW_OBLIGATION_AMBIGUOUS
REVIEW_OBSERVATION_AUTHORITY_UNAVAILABLE
REVIEW_OBSERVATION_CAPABILITY_UNKNOWN
REVIEW_OBSERVATION_INVALID_ARGS
REVIEW_OBSERVATION_OVERSIZED
REVIEW_OBSERVATION_PATH_INVALID
REVIEW_OBSERVATION_UNAVAILABLE
REVIEW_OBSERVATION_UNSUPPORTED_ENTRY
REVIEW_OBLIGATION_ID_REQUIRED
REVIEW_OBLIGATION_INPUT_MISMATCH
REVIEW_OBLIGATION_NOT_FOUND
REVIEW_OBLIGATION_UNRESOLVED
REVIEW_PLAN_VERSION_MISMATCH
REVIEW_REPAIR_UNAVAILABLE
REVIEW_REPOSITORY_IDENTITY_MISSING
REVIEW_REPOSITORY_REVISION_UNAVAILABLE
REVIEW_SELF_APPROVAL_DENIED
REVIEW_STATE_INCOMPLETE
REVIEW_SUBJECT_DIGEST_MISMATCH
REVIEW_SUBJECT_NOT_MATERIALIZED
REVIEW_SUBJECT_SCOPE_UNAVAILABLE
REVIEW_TRANSPORT_EVIDENCE_INVALID
REVIEW_URL_CONTENT_ENCODING_INVALID
REVIEW_VERDICT_EVIDENCE_MISSING
REVIEW_VERDICT_MISMATCH
REVIEWER_OUTPUT_RETRY_EXHAUSTED
REVIEWER_OUTPUT_REPAIR_STALLED
REPAIR_PROMPT_REQUIRED
REVIEWER_OUTPUT_SCHEMA_INVALID
REVIEWER_CONTEXT_UNAVAILABLE
INVALID_REVIEW_TOOL_SEQUENCE
REVIEWER_INVOCATION_EXHAUSTED
REVIEWER_TASK_REQUIRES_PENDING_OBLIGATION
REVIEWER_UNAVAILABLE_STRICT
REVISED_PLAN_REQUIRED
RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE
RISK_CLASSIFICATION_MISMATCH
RISK_CLASSIFICATION_REQUIRED
RISK_DOWNGRADE_OVERRIDE_DENIED
RISK_GATE_BLOCKED
SCHEMA_VALIDATION_FAILED
SESSION_DIR_INVALID
SESSION_DIR_NOT_FOUND
SESSION_ERROR
SESSION_LOCK_CONTENDED
STATE_MISSING
STATE_UNREADABLE
STATE_UNAVAILABLE_FOR_REVIEWER_TASK
STRICT_REVIEW_ORCHESTRATION_FAILED
SUBAGENT_CONTEXT_UNVERIFIABLE
SUBAGENT_EVIDENCE_MISSING
SUBAGENT_EVIDENCE_REUSED
SUBAGENT_FINDINGS_ISSUES_MISMATCH
SUBAGENT_FINDINGS_VERDICT_MISMATCH
SUBAGENT_MANDATE_MISMATCH
SUBAGENT_PROMPT_EMPTY
SUBAGENT_PROMPT_MISSING_CONTEXT
SUBAGENT_PROMPT_ARTIFACT_MISSING
SUBAGENT_CHALLENGE_CONTRADICTED
SUBAGENT_CHALLENGE_COUNT_INCOHERENT
SUBAGENT_CHALLENGE_EVIDENCE_MISSING
SUBAGENT_CHALLENGE_INSUBSTANTIAL
SUBAGENT_CHALLENGE_KIND_INCOHERENT
SUBAGENT_CHALLENGE_NOT_DISTINCT
SUBAGENT_IMPLEMENTATION_CHALLENGE_UNRESOLVED
SUBAGENT_PRIOR_CHALLENGE_UNRESOLVED
SUBAGENT_RESOLUTION_VERDICT_DUPLICATE
SUBAGENT_RESOLUTION_VERDICT_INCOHERENT
SUBAGENT_RESOLUTION_VERDICT_UNEXPECTED
SUBAGENT_RESOLUTION_VERDICT_UNKNOWN
SUBAGENT_REVIEW_NOT_INVOKED
SUBAGENT_REVIEW_REQUIRED
TSA_TIMESTAMP_ASSURANCE_FAILED
SUBAGENT_SESSION_MISMATCH
SUBAGENT_TYPE_UNAUTHORIZED
SUBAGENT_UNABLE_TO_REVIEW
SUBAGENT_VERDICT_FINDINGS_INCOHERENT
TICKET_REQUIRED
TOOL_ERROR
UNSUPPORTED_ASSERTION_CAPABILITY
VALIDATION_EVIDENCE_REQUIRED
VALIDATION_EVIDENCE_STACK_NO_COMMANDS
VALIDATION_EVIDENCE_UNVERIFIED
VALIDATION_INCOMPLETE
VALIDATION_SUBJECT_CHANGED
VERIFICATION_SUBJECT_CHANGED
VERIFIED_ACTOR_REQUIRED
CONFIG_INVALID
CONFIG_MISSING
CONFIG_WRITE_FAILED
WORKTREE_MISMATCH
WRITE_FAILED
WRONG_PHASE
```

## Migrated Reason Codes (Human Projection)

The following reason codes are "migrated" onto the Human Projection. They are the
single authority (`src/presentation/reason-copy.ts`) for human copy. On the
rendered presentation surfaces (`/status`, `/why`, `/finish`) the context-free
`headline` becomes the primary copy, the reason code moves into `**Details:**`,
the registry-verbatim message is preserved there, and the human-authored
`explanation` renders as `**Why:**`. Structured blocked tool results remain
canonical and additive: `message` is the interpolated registry message and
`headline` is carried as an additive field. Keep this table in sync with
`REASON_COPY` — the drift test enforces it.

| Code                                    | Headline                                                                        | Explanation                                                                                                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VALIDATION_EVIDENCE_REQUIRED`          | Validation evidence is required before VALIDATION can pass                      | Policy requires Discovery-derived verification commands to be active and executed. VALIDATION must not pass vacuously under this policy.                                                    |
| `VALIDATION_EVIDENCE_UNVERIFIED`        | Validation evidence is unverified, so VALIDATION stays blocked                  | Discovery is not trustworthy enough to confirm whether verification commands exist. VALIDATION is blocked fail-closed instead of asserting false certainty.                                 |
| `VALIDATION_EVIDENCE_STACK_NO_COMMANDS` | A detected stack produced no verification commands, so VALIDATION stays blocked | Discovery found a technology stack but derived no verification commands from it. A stack with zero active checks is treated as a mis-detection hazard, not a verified no-commands property. |
| `PROOFGRAPH_CERTIFICATE_INVALID`        | Evidence approval is blocked by a missing or stale plan certificate             | The plan approval certificate is missing, stale, or does not bind the current plan version.                                                                                                 |
| `PROOFGRAPH_EVALUATION_UNAVAILABLE`     | Evidence approval is blocked because critical claims have no proof evaluation   | Certificate-authorized critical plan claims have no persisted ProofGraph evaluation. Evidence approval cannot proceed on un-evaluated claims.                                               |
| `PROOFGRAPH_RISK_ASSESSMENT_STALE`      | Evidence approval is blocked by a stale implementation risk assessment          | The implementation risk assessment is missing, stale, or predates trigger classification. Record a fresh assessment before approving.                                                       |
| `PROOFGRAPH_CRITICAL_FACT_REQUIRED`     | Evidence approval requires a critical, certificate-authorized fact claim        | The declared risk triggers require at least one critical, certificate-authorized fact claim to be recorded and proven before approval.                                                      |
| `PROOFGRAPH_CRITICAL_FACTS_UNPROVEN`    | Evidence approval is blocked because critical fact claims are not proven        | One or more critical, certificate-authorized fact claims are not yet PROVEN in the persisted ProofGraph.                                                                                    |
| `VALIDATION_SUBJECT_CHANGED`            | The validation subject changed while checks were running                        | The plan or implementation under validation changed during the check run, so the results cannot be bound to a stable subject digest. Re-run the check against the current subject.          |
| `VERIFICATION_SUBJECT_CHANGED`          | The execution subject changed during verification                               | The execution subject changed during the verification phase, so evidence cannot be bound to a stable subject. Re-capture discovery and re-execute verification.                             |
| `FOUR_EYES_ACTOR_MATCH`                 | Four-eyes review required: a different reviewer must approve                    | The session initiator cannot approve their own work. A different person with reviewer permissions must provide the review decision.                                                         |
| `REVIEW_SUBJECT_SCOPE_UNAVAILABLE`      | The review scope is not verifiable for this obligation                          | The review obligation has no frozen reviewed-file scope, so scope verification is unavailable. Re-run the review to create an obligation with a verifiable frozen scope.                    |
| `DISCOVERY_DRIFT_BLOCKED`               | Discovery drift blocks mutating tools                                           | The discovery surface drifted from the persisted binding and the onDrift policy blocks mutating tools. Reconcile drift before continuing.                                                   |
| `DISCOVERY_HEALTH_UNAVAILABLE`          | Discovery evidence is unavailable; mutating tools are blocked                   | Policy requires healthy Discovery before mutating tools may run. Restore Discovery evidence and run hydration to re-establish health.                                                       |
| `DISCOVERY_HEALTH_DEGRADED`             | Discovery is degraded; mutating tools are blocked                               | Discovery is available but degraded, and the onDegraded policy blocks mutating tools. Resolve the degraded collectors and re-run hydration.                                                 |

## Debug Mode

Enable verbose logging via workspace config:

```json
{
  "logging": {
    "level": "debug",
    "mode": "console"
  }
}
```

Config file location: `~/.config/opencode/flowguard.json` (global) or `.opencode/flowguard.json` in the project.

### Log Modes

| Mode           | Output                                                          | Use case                              |
| -------------- | --------------------------------------------------------------- | ------------------------------------- |
| `console`      | stderr/stdout (formatted)                                       | Development, CI, `--log-mode console` |
| `file`         | `{workspace}/.opencode/logs/flowguard-{YYYY-MM-DD}.log` (JSONL) | Production, audit                     |
| `file+console` | Both file and console                                           | Development with persistence          |
| `ui`           | OpenCode TUI via `client.app.log()`                             | Plugin-only (no CLI)                  |
| `both`         | File + OpenCode TUI                                             | Plugin-only (no CLI)                  |

### CLI `--log-mode` Flag

The CLI uses a separate flag because it has no OpenCode plugin context:

```bash
flowguard install --core-tarball ./flowguard-core-1.2.0-tp.1.tgz --log-mode console
flowguard doctor --log-mode file
flowguard uninstall --log-mode file+console
```

Console mode writes formatted lines to stderr/stdout. File mode writes JSONL to the target `.opencode/logs/` directory.

### Log File Location

File logs are written to:

```
~/.config/opencode/workspaces/{fingerprint}/.opencode/logs/flowguard-{YYYY-MM-DD}.log
```

Each line is a JSON object with `ts`, `level`, `component`, `service`, `message`, and optional `fields`. Logs older than `logging.retentionDays` (default 7) are auto-deleted on first write each day.

### Missing Adapter Logs

If adapter-layer operations (persistence, git, archive, identity) produce no logs:

1. Verify `logging.level` is not `silent` or `error` (which suppresses warn/info/debug)
2. Verify `logging.mode` is not set to a mode that doesn't cover your sink
3. If using the plugin: adapter logging requires the plugin to run hooks via `runWithAdapterLoggerAsync()` — ensure the plugin is active
4. If using the CLI: adapter logging is active during the command, reset afterwards

### Identity Log Redaction

Identity, JWT, and JWKS error logs automatically sanitize sensitive data:

- File paths → basename only (e.g. `[redacted:token.jwt]`)
- URIs → hostname only (e.g. `[redacted:auth.example.com]`)
- Issuers → SHA-256 prefix (e.g. `[hashed:a1b2c3d4]`)
- Error messages → absolute paths and URLs stripped

If you see raw paths or URLs in identity logs, file a bug — redaction is applied at every log call site.

## Test Troubleshooting

### Smoke Tests Fail Locally

**Symptom:** `npm run test:smoke` fails with "Built CLI missing".

**Solution:** Smoke tests require a build first:

```bash
npm run build && npm run test:smoke
```

### ACP Smoke Tests Skipped

**Symptom:** ACP tests show as "skipped" in smoke output.

**Cause:** ACP tests require `RUN_OPENCODE_ACP_TESTS=1` and the `opencode` CLI.

**Solution:**

```bash
npm install -g opencode-ai
RUN_OPENCODE_ACP_TESTS=1 npm run test:smoke
```

### PERF Tests Flaky on CI

**Symptom:** Performance tests (e.g., `initWorkspace is fast`, `runDiscovery < 100ms`)
fail intermittently on CI or under heavy load.

**Cause:** Shared CI runners have variable I/O and CPU performance. Performance budgets
include CI-aware multipliers (2x compute, 3x I/O), but extreme contention can still
exceed them.

**Solution:** Re-run the job. These are known flakes and do not indicate regressions.
See `src/test-policy.ts` for budget definitions.

### EBUSY Errors on Windows

**Symptom:** `EBUSY: resource busy or locked, rmdir` during tests.

**Cause:** Windows file locking prevents cleanup of temp directories while handles
are still open (common with vitest parallel execution).

**Solution:** Re-run the test. This is a known Windows-specific flake.

## Accessibility

FlowGuard CLI output is plain text and uses explicit textual status labels. It does not rely on color to communicate status, which improves compatibility with screen readers and other assistive terminal tooling. FlowGuard's current CLI formatters produce plain-text output without ANSI color styling.

Status tags used:

- `[ok]`, `[MISSING]`, `[MODIFIED]`, `[UNMANAGED]`, `[VERSION]`, `[INSTR_MISSING]`, `[INSTR_STALE]`, `[ERROR]`, `[WARN]` — actionable doctor check results
- `[NOTE]` — non-actionable platform characteristics shown by doctor
- `[written]`, `[merged]`, `[skipped]`, `[removed]` — install/uninstall file operations
- `[error]`, `[warn]` — install/uninstall diagnostics
- `[next]`, `[status]` — activation hints and informational notices

## Getting Help

1. Check `/status` for session status
2. Run `/why` for a diagnostic explanation of the current next-action
3. Run `flowguard doctor` for installation/workspace diagnostics
4. Review audit trail in the session directory: `~/.config/opencode/workspaces/{fingerprint}/sessions/{sessionId}/audit.jsonl`
5. Inspect the persisted state: `~/.config/opencode/workspaces/{fingerprint}/sessions/{sessionId}/session-state.json`

## Reset Session

To start fresh:

```bash
# Abort current session
/abort

# Delete session files
rm -rf ~/.config/opencode/workspaces/{fingerprint}/sessions/{sessionId}
```

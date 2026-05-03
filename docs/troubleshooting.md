# Troubleshooting

## Common Issues

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
# Create new session
/hydrate

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
   cat ~/.config/opencode/workspaces/{fingerprint}/config.json
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

| Code                       | Description                                 | Solution                                                  |
| -------------------------- | ------------------------------------------- | --------------------------------------------------------- |
| `NO_SESSION`               | No session exists for the current workspace | Run `/hydrate` first                                      |
| `MISSING_SESSION_ID`       | Tool call missing session id                | Re-invoke via OpenCode (the runtime injects sessionId)    |
| `MISSING_WORKTREE`         | Workspace fingerprint cannot be resolved    | Run from inside a git worktree                            |
| `INVALID_FINGERPRINT`      | Workspace fingerprint mismatch              | Run `flowguard doctor`                                    |
| `WORKSPACE_CONFIG_MISSING` | `workspace.json` is absent                  | Re-run `flowguard install` for this workspace             |
| `WORKSPACE_CONFIG_INVALID` | `workspace.json` failed schema validation   | Restore from a trusted backup or re-install               |
| `SCHEMA_VALIDATION_FAILED` | Persisted session state failed schema check | Restore from archive — pre-1.0 sessions are not supported |

### Command & Phase

| Code                  | Description                                                        | Solution                                                 |
| --------------------- | ------------------------------------------------------------------ | -------------------------------------------------------- |
| `COMMAND_NOT_ALLOWED` | Command is not in the allowed-phase set for current phase          | Check `docs/commands.md` "Allowed in" for the command    |
| `WRONG_PHASE`         | Tool requires a specific phase precondition                        | Run `/status` to see the current phase, then `/continue` |
| `INVALID_VERDICT`     | `/review-decision` verdict is not approve/changes_requested/reject | Pass a valid verdict literal                             |
| `INVALID_TRANSITION`  | Topology event not valid for current phase                         | Run `/status` and `/why` for diagnostic explanation      |

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

| Code                                 | Description                                                                     | Solution                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `SUBAGENT_REVIEW_NOT_INVOKED`        | L1 — primary agent submitted a verdict without invoking the reviewer subagent   | Read the previous tool response and follow the `next` action                                |
| `SUBAGENT_REVIEW_REQUIRED`           | Content-aware review requires analysisFindings from flowguard-reviewer subagent | Call Task tool with subagent_type: "flowguard-reviewer" and pass output as analysisFindings |
| `SUBAGENT_SESSION_MISMATCH`          | L2 — `reviewedBy.sessionId` does not match actual subagent session              | Do not edit `reviewedBy.sessionId`; the runtime authoritatively sets it                     |
| `SUBAGENT_PROMPT_EMPTY`              | L3 — subagent prompt < 200 chars                                                | Use the runtime-built review prompt (do not hand-craft)                                     |
| `SUBAGENT_PROMPT_MISSING_CONTEXT`    | L3 — prompt missing iteration or planVersion context                            | Use the runtime-built prompt                                                                |
| `SUBAGENT_FINDINGS_VERDICT_MISMATCH` | L4 — submitted overallVerdict differs from actual subagent verdict              | Submit the findings exactly as returned by the orchestrator                                 |
| `SUBAGENT_FINDINGS_ISSUES_MISMATCH`  | L4 — submitted blockingIssues count differs from actual count                   | Submit the findings exactly as returned                                                     |
| `SUBAGENT_EVIDENCE_REUSED`           | One-shot review evidence reused for a second obligation                         | Submit a substantively-new artifact for a fresh review obligation                           |
| `MAX_REVIEW_ITERATIONS_REACHED`      | Review loop reached max iterations without convergence ({lastVerdict})          | Submit a fresh /plan or /implement to reset the iteration counter                           |
| `SUBAGENT_UNABLE_TO_REVIEW`          | Reviewer declared the artifact unreviewable; obligation consumed                | Address the reviewer's reason or substantially revise; do not retry the same artifact       |
| `SUBAGENT_CONTEXT_UNVERIFIABLE`      | Strict enforcement cannot validate obligation context from tool output          | Re-run the tool that produced the review obligation                                         |
| `REVIEW_FINDINGS_REQUIRED`           | Mode B verdict submitted without `reviewFindings`                               | Include the structured `reviewFindings` object                                              |
| `REVIEW_FINDINGS_SESSION_MISMATCH`   | Findings came from a different session than the current FlowGuard session       | Use findings produced for the current session                                               |
| `REVIEW_FINDINGS_HASH_MISMATCH`      | Findings hash does not match the review obligation                              | Re-run the review for the current obligation                                                |
| `REVIEW_ASSURANCE_STATE_UNAVAILABLE` | Strict review assurance state cannot be read                                    | Re-hydrate; if persistent, restore from archive                                             |

### Identity & Approvals

| Code                           | Description                                                             | Solution                                                    |
| ------------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| `ACTOR_ASSURANCE_INSUFFICIENT` | Approver assurance below `policy.minimumActorAssuranceForApproval`      | Configure stronger actor assurance (see `docs/policies.md`) |
| `ACTOR_IDP_MODE_REQUIRED`      | `policy.identityProviderMode=required` but actor cannot be IdP-verified | Provide a valid `FLOWGUARD_ACTOR_TOKEN_PATH`                |
| `FOUR_EYES_ACTOR_MATCH`        | Same actor initiated and approved (regulated mode forbids this)         | A different verified actor must approve                     |

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
[`docs/archive.md`](./archive.md#verification-finding-codes) (11 finding codes
covering manifest, hash chain, and per-artifact integrity).

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
ADR_REVIEW_IN_PROGRESS
ADR_SUBMISSION_MIXED_INPUTS
ARCHITECTURE_REVIEW_LOOP_REQUIRED
AUDIT_PERSISTENCE_FAILED
CENTRAL_POLICY_INVALID_JSON
CENTRAL_POLICY_INVALID_MODE
CENTRAL_POLICY_INVALID_SCHEMA
CENTRAL_POLICY_MISSING
CENTRAL_POLICY_PATH_EMPTY
CENTRAL_POLICY_UNREADABLE
COMMAND_NOT_ALLOWED
CONTENT_ANALYSIS_REQUIRED
DECISION_IDENTITY_REQUIRED
DECISION_RECEIPT_ACTOR_MISSING
DISCOVERY_PERSIST_FAILED
DISCOVERY_RESULT_MISSING
EMPTY_ADR_TEXT
EMPTY_ADR_TITLE
EMPTY_PLAN
EMPTY_TICKET
EVIDENCE_ARTIFACT_IMMUTABLE
EVIDENCE_ARTIFACT_MISMATCH
EVIDENCE_ARTIFACT_MISSING
EXISTING_POLICY_WEAKER_THAN_CENTRAL
EXPLICIT_WEAKER_THAN_CENTRAL
FOUR_EYES_ACTOR_MATCH
GIT_COMMAND_FAILED
GIT_NOT_FOUND
HYDRATE_DISCOVERY_CONTRACT_FAILED
IMPLEMENTATION_EVIDENCE_REQUIRED
IMPLEMENT_REVIEW_LOOP_REQUIRED
INTERNAL_ERROR
INVALID_ARCHITECTURE_TOOL_SEQUENCE
INVALID_FINGERPRINT
INVALID_IMPLEMENT_TOOL_SEQUENCE
INVALID_PLAN_TOOL_SEQUENCE
INVALID_PROFILE
INVALID_TRANSITION
INVALID_VERDICT
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
PARSE_FAILED
PLAN_APPROVE_WITH_TEXT
PLAN_FINDINGS_WITHOUT_VERDICT
PLAN_REQUIRED
MAX_REVIEW_ITERATIONS_REACHED
PLAN_REVIEW_IN_PROGRESS
PLAN_REVIEW_LOOP_REQUIRED
PLAN_SUBMISSION_MIXED_INPUTS
PLAN_SUBMISSION_REQUIRED
POLICY_SNAPSHOT_MISSING
PROFILE_RESOLUTION_PERSIST_FAILED
READ_FAILED
REGULATED_ACTOR_UNKNOWN
REVIEW_ASSURANCE_STATE_UNAVAILABLE
REVIEW_CARD_ARTIFACT_IMMUTABLE
REVIEW_CARD_ARTIFACT_WRITE_FAILED
REVIEW_FINDINGS_HASH_MISMATCH
REVIEW_FINDINGS_REQUIRED
REVIEW_FINDINGS_SESSION_MISMATCH
REVISED_PLAN_REQUIRED
SCHEMA_VALIDATION_FAILED
SUBAGENT_CONTEXT_UNVERIFIABLE
SUBAGENT_EVIDENCE_REUSED
SUBAGENT_FINDINGS_ISSUES_MISMATCH
SUBAGENT_FINDINGS_VERDICT_MISMATCH
SUBAGENT_PROMPT_EMPTY
SUBAGENT_PROMPT_MISSING_CONTEXT
SUBAGENT_REVIEW_NOT_INVOKED
SUBAGENT_REVIEW_REQUIRED
SUBAGENT_SESSION_MISMATCH
SUBAGENT_UNABLE_TO_REVIEW
TICKET_REQUIRED
TOOL_ERROR
VALIDATION_INCOMPLETE
VERIFIED_ACTOR_REQUIRED
WORKSPACE_CONFIG_INVALID
WORKSPACE_CONFIG_MISSING
WORKSPACE_CONFIG_WRITE_FAILED
WORKTREE_MISMATCH
WRITE_FAILED
WRONG_PHASE
```

## Debug Mode

Enable verbose logging via workspace config:

```json
{
  "logging": {
    "level": "debug"
  }
}
```

Config file location: `~/.config/opencode/workspaces/{fingerprint}/config.json` or `.opencode/config.json` in the project.

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

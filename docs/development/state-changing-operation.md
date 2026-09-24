# Following a State-Changing Operation

This guide follows the regulated ticket-completion path across distinct
operations. Human approval, export, regulated completion, and recovery are
separate stages with separate durable checkpoints; they are not one tool
transaction. The path is intentionally useful for understanding how a change
can affect state, audit, artifacts, and later recovery.

The example is specifically the regulated ticket flow whose final approval
transitions from `EVIDENCE_REVIEW` to `EXPORT_READY`. Other review gates and
completion flows have their own transitions and must not be inferred from this
example.

## 1. Human approval records a decision and stops at `EXPORT_READY`

The `flowguard_decision` tool is implemented in
[`decision-tool.ts`](../../src/integration/tools/decision/decision-tool.ts).
It checks the human-decision intent when required by policy, resolves the
decision actor, and enters `persistHumanDecision` under
`withMutableSessionTransaction`. The tool delegates the state transition to the
review-decision rail and finalization service; those authorities determine
whether the verdict is allowed and what state it produces.

In the regulated ticket-completion path, an approval at `EVIDENCE_REVIEW`
produces `EXPORT_READY`. The decision receipt is prepared as a semantic audit
intent and persisted with the resulting state through `persistAndFormat`. This
is a persisted decision, not evidence that export has occurred and not a
completed session. Export and regulated archive side effects are deliberately
left to the later export operation.

Relevant implementation: [`decision-tool.ts`](../../src/integration/tools/decision/decision-tool.ts),
[`decision-finalization.ts`](../../src/integration/services/decision-finalization.ts),
and [`review-decision.ts`](../../src/rails/review-decision.ts).

## 2. Export materializes and verifies a package before committing `COMPLETE`

The export tool lives in
[`export-tool.ts`](../../src/integration/tools/simple/export-tool.ts). Its
`materializeExport` function runs in a mutable-session transaction and accepts
only `EXPORT_READY`. It creates the development export, verifies that package,
hashes it, constructs export-completion evidence, and passes that evidence to
the canonical export rail in [`export.ts`](../../src/rails/export.ts).

The rail applies the `EXPORT_MATERIALIZED` transition to `COMPLETE`. The tool
then persists the transitioned state and its transition audit operation using
`writeStateWithArtifactsAndAuditOperations`. If package verification fails,
the tool returns a blocked result and the session remains `EXPORT_READY`.

For regulated policy, `completeRegulatedExport` runs only after the transaction
that materialized and persisted the export has released its session lock. It
then invokes the regulated completion chain. This separation avoids running
the later chain while holding the non-reentrant state-write lock.

## 3. The shared write path commits state, outbox, and derived artifacts

The decision path calls `persistAndFormat`, which sends a successful rail
result to `writeStateWithArtifactsAndAuditOperations`. Export calls that same
writer directly after its rail succeeds. The shared path then runs:

`persistAndFormat` → `writeStateWithArtifactsAndAuditOperations` →
`prepareStateWithAuditOperations` → `writeStateWithArtifactsAlreadyLocked`.

The writer acquires the session write lock unless the current call already
holds it. Under that lock it reads the previous state and prepares the next
state with audit operations. Preparation validates the state, finalizes
implementation-entry authority, refreshes the ProofGraph, and then creates
transition-specific operations, state-write operations, and supplied semantic
intents as applicable. The outbox operations bind pre-state, mutation, and
post-state digests; the audit event is not appended to the trail at this stage.

The current implementation then passes that prepared state to
`writeStateWithArtifactsAlreadyLocked`, which validates it again and performs
implementation-entry finalization and ProofGraph refresh again before
materializing artifacts. Thus this path currently prepares/finalizes and
refreshes the ProofGraph twice. This describes the current write path; it does
not imply a behavior change or a performance finding.

After the second validation and ProofGraph refresh, the writer computes the
serialized-state hash, materializes evidence artifacts against that refreshed
state and hash, and only then writes the state file. If artifact materialization
fails, the state change is not persisted. If the state write fails after
artifact materialization, orphan artifacts may remain, but the state file has
not advanced. This artifacts-first ordering prevents persisted state from
referencing artifacts that were never written.

Later, [`plugin-audit-reconcile.ts`](../../src/integration/plugin-audit-reconcile.ts)
drains committed outbox operations: it verifies the operation digest against
the current state, appends the corresponding audit event when it is not already
present, then acknowledges the operation as reconciled. Regulated completion
invokes this reconciliation at defined points in its chain; writing an outbox
operation and reconciling it into the audit trail are separate steps.

Implementation: [`helpers.ts`](../../src/integration/tools/helpers.ts#L212-L299),
[`audit-outbox.ts`](../../src/integration/audit-outbox.ts), and
[`plugin-audit-reconcile.ts`](../../src/integration/plugin-audit-reconcile.ts).
The artifact/state write ordering is covered by
[`write-state-with-artifacts.test.ts`](../../src/integration/tools/write-state-with-artifacts.test.ts);
outbox digest preparation is covered by
[`audit-outbox.test.ts`](../../src/integration/tools/audit-outbox.test.ts).

## 4. Regulated completion orders audit, lifecycle, archive, and verification

The chain is owned by
[`regulated-completion.ts`](../../src/integration/services/regulated-completion.ts)
and its terminal-decision logic by
[`regulated-completion-decision.ts`](../../src/integration/services/regulated-completion-decision.ts).
It applies only to the exact regulated ticket completion contract:
`EXPORT_READY` plus `EXPORT_MATERIALIZED` to `COMPLETE` without a session error.

The service uses the persisted outbox as its durable checkpoint and performs
the following ordered work:

1. Commit or verify the terminal decision receipt. The ordering contract
   requires that receipt before the export transition is reconciled.
2. Reconcile pending completion audit operations and verify that they are
   reconciled. An audit failure prevents the chain from advancing to archive
   publication.
3. Commit a separate `session_completed` lifecycle operation, then reconcile
   it. Keeping this as a distinct operation establishes its position after the
   decision and transition in the audit trail.
4. Under a separate regulated-completion lock, publish the regulated archive,
   persist its created status, verify the archive, and persist `verified` or
   `failed` status. A previously verified state is returned without republishing.

Ordinary chain failures lead to an attempted persisted `regulatedArchiveStatus:
'failed'`. If persisting that failure also fails, the service logs the failure;
the failed status is not guaranteed to have reached disk. Completion-lock
contention is treated differently: it is not persisted as a domain failure,
because another completion/recovery may own the chain. The service returns a
fresh verified state if available; otherwise it surfaces the contention for a
retry.

The audit sequence is therefore not a cosmetic rendering detail. State-owned
outbox operations and the audit trail jointly preserve the authority and order
of the approval transition and its associated decision receipt, followed by
the export transition and then the `session_completed` lifecycle event.

## 5. Recovery resumes an incomplete durable completion

The plugin before-hook calls
[`recoverRegulatedCompletion`](../../src/integration/plugin-regulated-recovery.ts)
before FlowGuard tools and mutating host tools. Recovery first reads state and
acts only when it matches the exact regulated ticket-completion contract and
the archive is not already verified. It obtains the workspace fingerprint,
re-checks the state under the session write lock, then calls
`resumeRegulatedCompletion` outside that lock. The resume function re-reads the
durable state and re-enters the same completion chain; the service's outbox and
archive status checks govern which work remains.

If state cannot be read at this preliminary recovery check, recovery logs and
returns without resuming. That is not a claim that the request is safe to
continue: the subsequent enforcement path owns the canonical fail-closed error
surface for unreadable state. A missing workspace fingerprint prevents resume
and raises a typed persistence error. Recovery does not apply to unrelated
terminal flows such as `ARCH_COMPLETE` or `PEER_REVIEW_COMPLETE`.

The state lock is held only for the small re-check, not around the resumed
chain. The chain takes its own locks for state writes, audit reconciliation, and
archive publication. Holding the session lock across resume would deadlock when
the chain attempts its own lock acquisition.

## 6. Tests and what they establish

[`regulated-completion.test.ts`](../../src/integration/services/regulated-completion.test.ts)
tests service ordering and failure behavior with mocked audit-reconciliation
and archive boundaries. It covers, among other cases, audit failure blocking
archive publication and completion-chain ordering. It is useful for focused
service behavior, but does not by itself prove the real persistence adapters.

[`plugin-regulated-recovery.test.ts`](../../src/integration/plugin-regulated-recovery.test.ts)
tests the before-hook recovery path using real filesystem persistence and audit
adapters. The archive publication and archive verification boundaries are
mocked, so this suite verifies durable state/outbox recovery behavior without
claiming an end-to-end test of external archive publication.

When changing this flow, trace the call sites across all stages and identify
which existing test owns the altered contract. A change to displayed tool
output does not by itself change state authority; a change to a transition,
outbox operation, audit ordering, archive status, or recovery precondition does.
Start with the [Developer Architecture Map](./architecture-map.md) for module
ownership and verification requirements, and [Your First Change](./first-change.md)
for a smaller additive response change.

# Desktop 2.2.5 chooser acceptance (PENDING)

**Status:** `NOT_VERIFIED`. The installed Desktop GUI bundle is packaged, installed
and host-resolved, but no visual Desktop 2.2.5 acceptance run has been recorded.
CI cannot launch the Desktop GUI; the TUI PTY proof does not certify Desktop.

## Required local proof

Use an isolated operator profile when possible. Record the exact FlowGuard
package SHA-256, OpenCode Desktop version, OS, screenshots or a redacted trace,
and the tested commit.

1. Install the packed artifact and open **OpenCode Desktop 2.2.5**.
2. Open a new governed session and run `/start`; leave it in `READY`.
3. Verify the persistent FlowGuard composer pill above the input
   appears without opening a modal automatically.
4. Open `/choose-workflow`; verify exactly `/task`, `/architecture` and `/review`,
   with `/task` marked recommended but not preselected.
5. Press Escape; verify the session is still `ACTIVE`/`READY` and no command ran.
6. Reopen the chooser, select `/task`; verify the canonical `READY → TICKET`
   transition and the next action `/plan`.
7. At `PLAN_REVIEW`, `ARCH_REVIEW` or `EVIDENCE_REVIEW`, verify the dialog shows
   only the canonical decision commands. Approve or request changes and verify
   the result. At an exhausted review gate, verify only
   `/override-approve`, `/request-changes` and `/reject` are offered, and that an
   override requires a non-empty rationale.
8. Open the dialog, change the session/workflow state in another action, then
   submit the stale selection; verify it is refused with
   `DECISION_BINDING_STALE` and no decision is committed.

The portable Markdown chooser remains the complete fallback while this proof is
pending.

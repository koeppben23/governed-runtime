# Upgrade and Rollback

This document describes how to upgrade FlowGuard and how to rollback to a previous version.

---

## Overview

FlowGuard uses a pre-built proprietary distribution model. Upgrades involve downloading a new release artifact and reinstalling.

---

## Delivery Scope

| Category                    | Description                  | Example                                                |
| --------------------------- | ---------------------------- | ------------------------------------------------------ |
| **Technically Enforced**    | Guarantees by implementation | Zod validation, hash chain                             |
| **Currently Delivered**     | Available in current release | CLI install, uninstall, doctor                         |
| **Optional**                | Can be configured            | Version pinning                                        |
| **Not Covered**             | Intentionally not provided   | Automated upgrades, rollback automation                |
| **Customer Responsibility** | External to FlowGuard        | Artifact archival, testing, compatibility verification |

---

## Upgrade Procedure

### Standard Upgrade

```bash
# 0. Pre-upgrade preflight (read-only, workspace-scoped). Exits 1 when this
#    workspace is not upgrade-ready; historical archives are warnings only.
flowguard inspect --upgrade-check

# 1. Download new release artifact from your approved release source
#    (e.g., GitHub Releases, internal artifact store)

# 2. Verify checksum manually, or keep checksums.sha256 next to the tarball so
#    flowguard install verifies it by default
sha256sum -c checksums.sha256

# 3. Reinstall with new artifact
flowguard install --core-tarball ./flowguard-core-{new}.tgz --force

# 4. Verify installation
flowguard doctor
```

`flowguard inspect --upgrade-check` answers exactly one question: must this
workspace be cleaned up before the upgrade? Active sessions, incompatible or
unreadable state, missing state with a live audit trail, and invalid live audit
trails are reported as blockers. Historical archives are inventoried and
classified under the current contract, but never block the upgrade. Full
archive integrity verification remains the job of the archive verifier, not of
this preflight.

### Upgrade with Project Installation

```bash
# In repository directory
cd /path/to/repository
flowguard install --core-tarball ./flowguard-core-{new}.tgz --install-scope repo --force
```

If the checksum file is not adjacent to the tarball, pass it explicitly with
`--checksums-file <path>`. Missing or mismatched checksum evidence blocks the
upgrade before managed artifacts are written.

### What Gets Updated

| Component         | Updated | Notes                       |
| ----------------- | ------- | --------------------------- |
| **CLI binary**    | Yes     | New `flowguard` command     |
| **Core package**  | Yes     | Via vendor tarball          |
| **Tools**         | Yes     | Re-installed from new core  |
| **Commands**      | Yes     | Updated prompts             |
| **Plugin**        | Yes     | Updated audit hook          |
| **Mandates**      | Yes     | Content-digested, versioned |
| **Configuration** | No      | Preserved                   |

### What Is Preserved

| Component         | Preserved | Notes                                         |
| ----------------- | --------- | --------------------------------------------- |
| **Session state** | Yes       | File-based; compatibility is release-specific |
| **Audit trails**  | Yes       | File-based                                    |
| **Archives**      | Yes       | File-based                                    |
| **Configuration** | Yes       | `flowguard.json` unchanged                    |

**Customer Responsibility:**

- Complete active sessions before upgrading; archive or export only terminal
  sessions (see the operator recovery tree below)
- Verify archives after upgrade
- Test upgrade in non-production

---

## Version Compatibility

### State Schema Compatibility

FlowGuard is a prerelease product. The persisted session-state schema is
`schemaVersion: 'v10'`, `assurance-epoch.v3`, `state-digest.v2`,
`policy-digest.v4`, and audit records are strictly `audit-chain.v3`. Pre-v10
state is **hard-rejected** with `SESSION_STATE_INCOMPATIBLE` at the `readState`
preflight, and audit records that violate the canonical audit-chain.v3
envelope are rejected with `AUDIT_ENVELOPE_INVALID` at every audit persistence
and verification boundary — the trust boundary never classifies legacy
formats, and non-v3 artifacts are never migrated, reinterpreted, or re-sealed.
Complete active sessions (archive terminal ones) before crossing the epoch
boundary. See
[`docs/architecture/schema-migration.md`](./architecture/schema-migration.md)
for the superseded migration proposal.

| From Version                                                     | To Version                                | Compatibility                                                                                                                                                                                                      |
| ---------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Any prerelease                                                   | Later prerelease                          | No forward-compatibility guarantee. Complete active sessions (or archive terminal ones) with the release that wrote them before upgrading; see the operator recovery tree below.                                   |
| State `schemaVersion: v9`/earlier                                | Current state contract (`v10`)            | Incompatible by design. State is rejected with `SESSION_STATE_INCOMPATIBLE`; no migration path exists. Recover with the release that wrote the session per the operator recovery tree, then start a fresh session. |
| Audit trail `audit-chain.v2`/earlier, regardless of state schema | Current audit contract (`audit-chain.v3`) | Incompatible by design. Records are rejected with `AUDIT_ENVELOPE_INVALID`; no migration or re-seal path exists.                                                                                                   |
| `v1.2.0-tp.2` and earlier policy digests                         | A release requiring `policy-digest.v4`    | Incompatible by design. The current digest excludes removed policy authorities; recover with the release that wrote the session per the operator recovery tree, then start a new session.                          |

**FlowGuard validates state on read.** A release that requires an incompatible
schema or evidence contract rejects the state at hydrate time with an explicit
BLOCKED `SCHEMA_VALIDATION_FAILED` (or `SESSION_STATE_INCOMPATIBLE` at the
`readState` contract preflight for pre-v10 state).
Do not edit persisted state to bridge that boundary. Complete an active session
or archive a terminal one with the release that wrote it, then start a fresh
session after upgrading — see the operator recovery tree below.

**Customer Responsibility:**

- Complete every active session with the currently installed artifact before
  upgrading; archive terminal sessions per the operator recovery tree
- Test upgrade in non-production
- Treat every changed schema or required evidence contract as breaking —
  the Assurance epoch replaces migration with hard rejection
  (`docs/architecture/schema-migration.md`)

### Operator recovery for incompatible persisted state

One decision tree governs every hard-cut recovery. Do not edit persisted state,
and do not restore session files across a schema boundary — a restored
pre-boundary session is rejected again at the next read.

1. **Preflight (when the installed release supports it).** Run
   `flowguard inspect --upgrade-check` with the currently installed artifact and
   resolve every `blocker` before upgrading. A directory that is not a git
   worktree reports `WORKSPACE_UNRESOLVED`; a resolvable worktree without an
   initialized FlowGuard workspace reports `WORKSPACE_NOT_INITIALIZED` — run
   `flowguard install` for that worktree first. A worktree whose identity
   changed (for example a git remote was added or removed) reports
   `WORKSPACE_IDENTITY_CHANGED` while a session of the prior fingerprint still
   belongs to this worktree and is unresolved — active, or carrying a state or
   audit blocker. Fully resolved sessions and empty historical workspaces do
   not block. Resolve or repair the prior sessions with the release that wrote
   them, then re-run the preflight. Historical archives are
   reported as warnings only. A release that predates `--upgrade-check` skips
   this step; the blockers below still apply. The preflight reports an active
   session as
   `ACTIVE_SESSION` and incompatible or unreadable state as `STATE_INCOMPATIBLE`
   or `STATE_UNREADABLE`, and exits 1 until every blocker is resolved. Manually
   accepting a residual risk is a documented operator decision, not a successful
   preflight: the classification and exit code stay unchanged, and preserving an
   incompatible session is evidence retention only.
2. **Recover each blocked session with the release that wrote it.** `/archive`
   requires a terminal phase, so the correct action depends on the session
   state:

   | Session state                                                  | Correct recovery                                                                                                                                                                                                                                       |
   | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
   | **Active and readable under the matching release**             | Complete the workflow normally with that release. Do not archive an active session — `/archive` blocks with `COMMAND_NOT_ALLOWED` until the workflow reaches a terminal phase. Export or archive the finished evidence afterwards.                     |
   | **Already terminal**                                           | Archive or export with the matching release when the terminal state is exportable; an aborted session is preserved but is not verifiable as an audit package.                                                                                          |
   | **Not completable or incompatible under the matching release** | Leave the original evidence untouched. Document the remaining blocker explicitly and treat the conflict as accepted or unresolved; do not present it as a clean preflight result.                                                                      |
   | **Matching release artifact unavailable**                      | No migration, no state repair, no compatibility shim. Reinstall the matching release from the approved release source if it is needed to complete or archive the session; otherwise preserve the evidence and handle the hard-cut conflict explicitly. |

3. **Upgrade** with the new artifact (checksum-verified).
4. **Start new sessions** on the current contract and verify archives with the
   archive verifier. Archive restore re-creates evidence at the schema version
   that wrote it; it never produces a session readable across a hard cut.

`SESSION_STATE_INCOMPATIBLE` (readState contract preflight) and
`SCHEMA_VALIDATION_FAILED` (hydrate-time evidence contract) are the two
observable block codes on this path. Both are terminal for the affected
session and share the tree above.

### Reviewer Mandate Compatibility

Reviewer obligations bind both `criteriaVersion` and the reviewer-mandate digest. The
`p38-v1` mandate requires `changes_requested` whenever `blockingIssues` is non-empty.
The `p39-v1` mandate makes the reviewer tool-capability profile part of the attested
contract by denying direct and MCP-prefixed `flowguard_*` tools while preserving
read-only research tools. The `p40-v1` mandate additionally denies the reviewer's
`task` capability, preventing subagent cascades. Each version has its own digest.

Existing obligations remain bound to their persisted `p38-v1` or `p39-v1` criteria and
digest and are never reinterpreted as `p40-v1` evidence. Complete an in-flight
review (then export the finished evidence) before upgrading when its
attestation must remain reproducible; create
a new artifact review cycle to use p40. Rolling back to a p39 build likewise requires a
new review cycle for any p40-bound obligation. Do not edit obligation attestation values
or mandate digests to bridge the version boundary.

### Archive Compatibility

Archives are tar.gz files containing structured JSON. Archive readability depends on the archive format used by each version.

**Customer Responsibility:**

- Verify archive readability after upgrade
- Maintain archives in accessible storage

---

## Rollback Procedure

### Standard Rollback

```bash
# 1. Ensure previous artifact is available
ls -la vendor/flowguard-core-{old}.tgz

# 2. If not available, obtain from backup or approved release source

# 3. Rollback installation
flowguard install --core-tarball ./flowguard-core-{old}.tgz --force

# 4. Verify
flowguard doctor
```

Rollback requires checksum evidence for the previous tarball as well. Keep the
matching `checksums.sha256` beside the rollback tarball or pass
`--checksums-file <path>`.

### Rollback Verification

```bash
# Verify installation (also reports the installed version in its banner)
flowguard doctor --install-scope global

# Or read the shipped VERSION file directly
cat "$(npm root -g)/@flowguard/core/VERSION"
```

---

## Artifact Management

### Artifact Archival

**Customer Responsibility:**

| Action                       | Frequency   | Storage                 |
| ---------------------------- | ----------- | ----------------------- |
| **Download artifacts**       | On release  | Internal artifact store |
| **Verify checksums**         | On download | Before use              |
| **Maintain rollback copies** | Continuous  | Last 2-3 versions       |

### Artifact Storage Recommendations

Maintain at least the current and previous two release tarballs alongside their
checksums:

```
/artifact-store/
├── flowguard-core-<current>.tgz   (current)
├── flowguard-core-<previous>.tgz  (previous)
├── flowguard-core-<rollback>.tgz  (rollback target)
└── checksums.sha256
```

---

## Upgrade Testing

### Pre-Upgrade Checklist

| Step | Action                                              | Verified |
| ---- | --------------------------------------------------- | -------- |
| 1    | Complete active sessions; archive terminal sessions | ☐        |
| 2    | Verify archives                                     | ☐        |
| 3    | Download new artifact                               | ☐        |
| 4    | Verify checksum                                     | ☐        |
| 5    | Test in non-production                              | ☐        |

### Non-Production Testing

```bash
# 1. Create test environment
mkdir /tmp/flowguard-test
cd /tmp/flowguard-test

# 2. Install new version (with matching checksums.sha256 beside the tarball)
flowguard install --core-tarball /path/to/new/flowguard-core-{new}.tgz

# 3. Test installation
flowguard doctor

# 4. Clean up
cd /tmp && rm -rf flowguard-test
```

### Post-Upgrade Verification

```bash
# 1. Verify installation (the doctor banner reports the installed version)
flowguard doctor --install-scope global

# 2. (Optional) Read the shipped VERSION file directly
cat "$(npm root -g)/@flowguard/core/VERSION"
```

---

## Session State During Upgrade

Sessions in progress are stored as files in `.opencode/`. Upgrading FlowGuard reinstalls the CLI and core package but does not modify existing session files.

**Customer Responsibility:**

- Complete active sessions and archive terminal ones before every prerelease
  upgrade
- Verify archives after upgrade; do not expect an active pre-upgrade session to
  remain readable

---

## Troubleshooting

### Upgrade Fails

| Error               | Cause              | Solution                    |
| ------------------- | ------------------ | --------------------------- |
| `tarball not found` | Wrong path         | Verify path to artifact     |
| `checksum mismatch` | Corrupt download   | Re-download, verify         |
| `install failed`    | Permission issue   | Check directory permissions |
| `doctor fails`      | Incomplete install | Re-run install with --force |

### Rollback Fails

| Error                | Cause            | Solution                     |
| -------------------- | ---------------- | ---------------------------- |
| `artifact not found` | No rollback copy | Obtain from backups/releases |
| `doctor fails`       | Partial rollback | Re-run install               |

---

FlowGuard Version: 2.0.0-tp.2
_Last Updated: 2026-08-25_

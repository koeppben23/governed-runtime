# Evidence Package Verification

This document defines what the demo's exported evidence package proves, how a
receiving auditor verifies it offline, and what that verification explicitly
does **not** prove. It exists because the package must remain verifiable after
the demo workspace is gone.

## What the package is

`/export` (development completion at `EXPORT_READY`) materializes exactly one
raw evidence package through the canonical archive path and records
`ExportCompletionEvidence` in the session state:

- package: `<sessionId>.tar.gz` under
  `~/.config/opencode/workspaces/<fingerprint>/sessions/archive/`
- sidecar: the same path plus `.sha256`
- contents: `archive-manifest.json` (schema `archive-manifest.v3`), the
  canonical session state at export time, the full audit trail, and the
  evidence artifacts listed in the manifest (`includedFiles`)

The package snapshots the session at `EXPORT_READY`; the transition to
`COMPLETE` is committed after materialization. A raw archive of an
already-terminal session (`/archive redactionMode=none includeRaw=true`) is
the other fully verifiable package shape and carries the terminal phase.

`/archive` with default redaction creates a **sharing archive**. It omits the
canonical state and audit chain, reports `integrityCapability: not_verifiable`
and `verificationStatus: not_run`, and is not an audit substitute. `/export`
and `/archive` are not synonyms.

## What the verifier checks

`verify-evidence-package.mjs` in this directory is a standalone offline
verifier. It extracts the package into a temporary directory and checks:

| Check              | Detail                                                                                                                                                                                                                                                                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tarball checksum   | Recomputed SHA-256 of the package file against the `.sha256` sidecar (exactly one digest)                                                                                                                                                                                                                                                          |
| Session assignment | Package identity (tarball prefix and `manifest.sessionId`) against `--expect-session`; a valid package of a different session fails even when all internal hashes match                                                                                                                                                                            |
| Manifest schema    | Canonical `archive-manifest.v3` validation via the exported `ArchiveManifestSchema`                                                                                                                                                                                                                                                                |
| Member inventory   | Every manifest-listed file is present, no undeclared or duplicate members, no unsafe paths, regular files only                                                                                                                                                                                                                                     |
| File digests       | Recomputed SHA-256 of every listed file against `manifest.fileDigests`                                                                                                                                                                                                                                                                             |
| Content digest     | Recomputed with the canonical `computeArchiveContentDigest` over the manifest's integrity header and sorted file digests                                                                                                                                                                                                                           |
| State identity     | `state.binding.hostSessionId` and `state.binding.fingerprint` against the manifest; `state.policySnapshot.mode` against `manifest.policyMode`                                                                                                                                                                                                      |
| Flow and phase     | The flow's allowed terminal/export phase (development `EXPORT_READY`/`COMPLETE`, architecture `ARCH_COMPLETE`, peer review `PEER_REVIEW_COMPLETE`, regulated `COMPLETE` with `regulatedArchiveStatus: verified`) and the phase transition shape; `COMPLETE` additionally requires the `EXPORT_READY → COMPLETE` (`EXPORT_MATERIALIZED`) transition |
| Audit chain        | `verifyChain` over the archived `audit/audit.jsonl` (offline), the manifest's `auditChainHead` / `auditEventCount` truncation anchor, and the event identity against the archived state                                                                                                                                                            |

## Requirements

- Node.js 22+ and the `tar` executable.
- The verifier imports the canonical archive primitives (`ArchiveManifestSchema`, `computeArchiveContentDigest`, `verifyChain`, `getLastChainHash`) from `@flowguard/core`. Run it from the governed-runtime checkout of the **same version/build that produced the package**, with `dist/` built (`npm run build`), or from an installation of that package.
- The package file plus its `.sha256` sidecar.

## Usage

```bash
node demos/java-task-manager/verify-evidence-package.mjs \
  /path/to/<sessionId>.tar.gz \
  --expect-session <session-id> \
  --expect-flow development \
  --expect-phase EXPORT_READY
```

Options:

- `--expect-session <id>` (required): the OpenCode session id the package must belong to.
- `--expect-flow development|architecture|peer-review|regulated`: validate the phase against the flow's allowed export/terminal phases.
- `--expect-phase <PHASE>`: exact phase expectation.
- `--expect-sharing`: accept a redacted sharing archive for the limited structural checks; it is still labelled `integrityCapability: not_verifiable`.
- `--json`: machine-readable result.

Exit codes:

| Code | Meaning                                                                                               |
| ---- | ----------------------------------------------------------------------------------------------------- |
| `0`  | Package verified (raw) — or structural checks passed for a deliberately expected sharing archive      |
| `1`  | Verification failed (tamper, identity, digest, inventory, or chain finding)                           |
| `2`  | Usage or runtime error (missing package, missing/incompatible `@flowguard/core`, missing expectation) |
| `3`  | The package is a redacted sharing archive and is not fully verifiable raw evidence                    |

A sharing archive never exits `0` without `--expect-sharing`, and its output
always states `NOT FULLY VERIFIABLE (sharing archive)`.

## Explicit limits

The verifier proves internal consistency of the package against the canonical
formulas. It does **not** prove:

- **Offline TSA assurance.** Timestamp tokens are not cryptographically
  validated offline (trust anchors, OCSP/CRL, and signer validation require the
  configured trust material and, for revocation, network access). TSA-backed
  archive assurance is established by the runtime's own verification.
- **External publication binding.** The product verifier additionally checks
  the archive publication binding against the originating session audit trail.
  An auditor holding only the package has no access to that external evidence,
  so this verifier cannot reproduce it.
- **Authenticity.** The manifest is not signed. A party that can rewrite the
  package can also rewrite the manifest and its content digest. Proving
  authenticity requires a trusted hash, signature, or comparable anchor
  transmitted through an independent channel.

For the reference run, record the verified session id, flow, phase, and the
exact FlowGuard version/commit of the verifier runtime next to the package
(see `FALLBACK.md`, "Frozen Evidence Assets"). Without those values the
`--expect-session` assignment check cannot be reproduced.

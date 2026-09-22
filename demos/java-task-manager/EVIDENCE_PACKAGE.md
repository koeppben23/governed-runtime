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
verifier. It snapshots the package into a private copy (so byte changes to the
original file after the run starts cannot mix versions) and checks:

| Check                    | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tarball checksum         | SHA-256 of the private snapshot against the `.sha256` sidecar (exactly one digest)                                                                                                                                                                                                                                                                                                                                                                               |
| Pre-extraction gate      | An unsafe session prefix, unsafe member path, non-regular entry, or duplicate member never reaches `tar -xzf`; the verifier does not rely on `tar` itself rejecting traversal paths                                                                                                                                                                                                                                                                              |
| Session assignment       | Package identity (tarball prefix and `manifest.sessionId`) against `--expect-session`; a valid package of a different session fails even when all internal hashes match                                                                                                                                                                                                                                                                                          |
| Manifest schema          | Canonical `archive-manifest.v3` validation via the exported `ArchiveManifestSchema`                                                                                                                                                                                                                                                                                                                                                                              |
| Member inventory         | Every manifest-listed file is present, no undeclared or duplicate members, no unsafe paths, regular files only                                                                                                                                                                                                                                                                                                                                                   |
| Manifest inventory paths | Every `includedFiles` path must be a safe relative path with a matching 64-hex digest, no duplicates, and no digest entries for unlisted files; an invalid inventory fails closed and **no payload file is opened**                                                                                                                                                                                                                                              |
| File digests             | Recomputed SHA-256 of every listed file against `manifest.fileDigests`                                                                                                                                                                                                                                                                                                                                                                                           |
| Content digest           | Recomputed with the canonical `computeArchiveContentDigest` over the manifest's integrity header and sorted file digests                                                                                                                                                                                                                                                                                                                                         |
| State schema             | The archived `state/session-state.json` is parsed with the canonical exported `SessionState` schema, not bare JSON                                                                                                                                                                                                                                                                                                                                               |
| State identity           | `state.binding.hostSessionId` and `state.binding.fingerprint` against the manifest; `state.policySnapshot.mode` against `manifest.policyMode`                                                                                                                                                                                                                                                                                                                    |
| Flow and phase           | The flow's allowed terminal/export phase (development `EXPORT_READY`/`COMPLETE`, architecture `ARCH_COMPLETE`, peer review `PEER_REVIEW_COMPLETE`, regulated `COMPLETE`) and the phase transition shape; `COMPLETE` additionally requires the `EXPORT_READY -> COMPLETE` (`EXPORT_MATERIALIZED`) transition                                                                                                                                                      |
| Audit chain              | `verifyChain` over the archived `audit/audit.jsonl` (offline), the manifest's `auditChainHead` / `auditEventCount` truncation anchor, and the event identity against the archived state                                                                                                                                                                                                                                                                          |
| Regulated evidence       | For regulated packages, the canonical `verifyRegulatedCompletionCompleteness` validates the **archived** completion evidence (terminal transition, reconciled outbox, ordered approval/decision/export/lifecycle trail). The mandatory `regulated-<sessionId>.tar.gz` necessarily snapshots `regulatedArchiveStatus: pending` — the live status only becomes `verified` after the archive exists — so the offline verifier never requires the later live status. |

## Evidence manifest

The three demo sessions are bound together by a small, standalone evidence
manifest (`evidence-manifest.example.json` is the checked-in template). It
lists, per flow (`architecture`, `development`, `peer-review`), the session id
and the session's artifacts with their file name and SHA-256:

- `flowguard-package` — a FlowGuard archive, verified with the full checks
  above using the manifest's session/flow assignment.
- `host-chat-export` — the external host chat export. It is **supplementary,
  manually assigned evidence, never FlowGuard authority**: the manifest is
  authored by hand, so the verifier can prove the artifact bytes (`sha256`) and
  the declared assignment, but it does **not** independently prove that a chat
  export belongs to the declared session — there is no host-session metadata
  inside a chat transcript. A byte-identical chat export bound to a different
  session/flow fails (`cross_session_artifact_duplicate`), which is exactly the
  defect where the peer-review export was a copy of the architecture export.

The manifest must declare the three flows exactly once with **distinct session
ids**; reusing one session id across flows fails (`duplicate_session_id`), so a
single session cannot masquerade as three independent runs.

```bash
node demos/java-task-manager/verify-evidence-package.mjs --manifest evidence-manifest.json
```

## Requirements

- Node.js 22+ and the `tar` executable.
- The verifier imports the canonical primitives (`ArchiveManifestSchema`, `computeArchiveContentDigest`, `verifyChain`, `getLastChainHash`, `SessionState`, `verifyRegulatedCompletionCompleteness`) from `@flowguard/core`. Run it from the governed-runtime checkout of the **same version/build that produced the package**, with `dist/` built (`npm run build`), or from an installation of that package.
- The package file plus its `.sha256` sidecar (and, for manifest mode, the evidence manifest plus every declared artifact).

## Usage

```bash
node demos/java-task-manager/verify-evidence-package.mjs \
  /path/to/<sessionId>.tar.gz \
  --expect-session <session-id> \
  --expect-flow development \
  --expect-phase EXPORT_READY
```

Options (package mode):

- `--expect-session <id>` (required): the OpenCode session id the package must belong to.
- `--expect-flow development|architecture|peer-review|regulated`: validate the phase against the flow's allowed export/terminal phases.
- `--expect-phase <PHASE>`: exact phase expectation.
- `--expect-sharing`: accept a redacted sharing archive for the limited structural checks; it is still labelled `integrityCapability: not_verifiable`.
- `--json`: machine-readable result.

Options (manifest mode):

- `--manifest <evidence-manifest.json>`: verify the three-session evidence manifest instead of a single package. Package expectation flags cannot be combined with `--manifest`.

Exit codes:

| Code | Meaning                                                                                                     |
| ---- | ----------------------------------------------------------------------------------------------------------- |
| `0`  | Package verified (raw) — or structural checks passed for a deliberately expected sharing archive            |
| `1`  | Verification failed (tamper, identity, digest, inventory, or chain finding); also any manifest-mode failure |
| `2`  | Usage or runtime error (missing package, missing/incompatible `@flowguard/core`, missing expectation)       |
| `3`  | The package is a redacted sharing archive and is not fully verifiable raw evidence                          |

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

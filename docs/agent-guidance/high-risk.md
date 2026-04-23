# High-Risk Guidance

This guide applies when task class is `HIGH-RISK`.

High-risk surfaces include:

- state and session lifecycle,
- policy, risk logic, and identity,
- audit, hash-chain, and archive integrity,
- release, installer, CI, and supply-chain behavior,
- persistence, migration, and compatibility,
- security and trust boundaries.

## Required Checks

- Identify governing contract and owning authority before edits.
- Preserve fail-closed behavior on ambiguity and errors.
- Avoid silent fallback and duplicate authority.
- Add meaningful negative-path tests for blocked/error conditions.
- Run typecheck, lint, build, and relevant integration or e2e checks.
- For release/installer changes, verify exact generated artifact install path.
- Document rollback or recovery strategy.
- In non-interactive execution (`flowguard run`, `flowguard serve` automation), return `BLOCKED` instead of asking follow-up questions.

## High-Risk Examples

- `/hydrate` must not reach `READY` without mandatory artifacts.
- Release tarball must be install-verified before checksum/SBOM/attestation claims.
- Derived artifacts remain derived evidence, never SSOT.
- Policy gate behavior must remain deterministic and authority-safe.

## Evidence Expectations

- Show direct file-level evidence for invariants and authority boundaries.
- Separate tested behavior from `NOT_VERIFIED` claims.
- If safe continuation is impossible, return `BLOCKED` with recovery steps.

# Release Policy

This document describes how FlowGuard releases are produced, distributed, and supported.

---

## Overview

FlowGuard uses semantic versioning and distributes pre-built proprietary artifacts via GitHub Releases.
Release publication is tag-driven (`v*`): if no release tag has been published yet, the Releases page can be empty for that repository snapshot.

---

## Delivery Scope

| Category                    | Description                  | Example                               |
| --------------------------- | ---------------------------- | ------------------------------------- |
| **Technically Enforced**    | Guarantees by implementation | SHA-256 checksums, Zod validation     |
| **Currently Delivered**     | Available in current release | Release artifacts, checksums          |
| **Customer Responsibility** | Customer handles             | Monitoring releases, testing upgrades |

---

## Versioning

### Semantic Versioning

FlowGuard uses [Semantic Versioning](https://semver.org/):

| Version   | Example | Meaning                                   |
| --------- | ------- | ----------------------------------------- |
| **Major** | 2.0.0   | Breaking changes — check release notes    |
| **Minor** | 1.1.0   | New features — test before production use |
| **Patch** | 1.0.1   | Bug fixes — typically compatible          |

#### Breaking Governance Changes

The following are considered breaking governance semantics changes (major version bump):

- **Mandatory independent subagent review**: Self-review evidence is no longer accepted for governed plan/implementation loops. FlowGuard requires independent reviewer evidence in every policy mode; removed review-policy fields and old snapshots are rejected.

### Version Lifecycle

| Status       | Description            | Duration            |
| ------------ | ---------------------- | ------------------- |
| **Latest**   | Current stable release | Until next release  |
| **Previous** | Prior release          | Best-effort support |
| **Older**    | Unsupported            | No updates          |

---

## Release Process

### Protected Main Release Flow

`main` is the canonical release authority and is protected by repository rules.
Contributor release steps, including the PR-first, tag-after-merge ordering,
are owned by [CONTRIBUTING.md](../CONTRIBUTING.md#release-branches). A `v*` tag
must point at a commit already contained in `origin/main`. Do not use `npm
version` for FlowGuard releases, and do not overwrite or force-push a tag.

### Artifact Creation

1. Build once: TypeScript is compiled and `npm pack` creates one `flowguard-core-{version}.tgz` artifact.
2. Bind: the verify job records that artifact's SHA-256 in `checksums.sha256` and uploads both as one workflow artifact.
3. Verify: runtime and cross-platform smoke jobs download that exact artifact and verify its checksum before use.
4. Gate: mutation testing must complete before publication can run.
5. Publish: the protected `release` environment downloads and re-verifies the same artifact before its tarball provenance attestation and GitHub Release.
6. Authority: write, OIDC, and attestation permissions exist only in the final publish job; all preceding jobs have read-only repository access.

### Artifact Contents

| Component       | Description                                                           |
| --------------- | --------------------------------------------------------------------- |
| **CLI**         | `flowguard` command (install, uninstall, doctor, run, serve, inspect) |
| **Core**        | State machine, rails, adapters, audit                                 |
| **Integration** | OpenCode tools, plugin, commands                                      |
| **Templates**   | Package.json, opencode.json templates                                 |

### Integrity Verification

| Check                         | Mechanism                                                                        |
| ----------------------------- | -------------------------------------------------------------------------------- |
| **Artifact integrity**        | SHA-256 checksum in `checksums.sha256`                                           |
| **Supply chain transparency** | CycloneDX 1.6 SBOM (`sbom.cdx.json`) released beside the tarball                 |
| **Build provenance**          | SLSA-style attestation for the tarball (verifiable with `gh attestation verify`) |
| **Content integrity**         | SHA-256 content digest in `flowguard-mandates.md`                                |

---

## Distribution

### GitHub Releases

All FlowGuard releases are distributed via GitHub Releases (or an approved internal mirror):

| Asset                          | Purpose                                                          |
| ------------------------------ | ---------------------------------------------------------------- |
| `flowguard-core-{version}.tgz` | Pre-built npm package                                            |
| `checksums.sha256`             | Checksum file for verification (consumed by `flowguard install`) |
| `sbom.cdx.json`                | CycloneDX 1.6 software bill of materials                         |
| Build provenance attestation   | SLSA-style provenance (verifiable with `gh attestation verify`)  |
| `LICENSE`                      | Plain-text copy of the FlowGuard license                         |

### Release Announcements

Release notes are published on the GitHub Releases page, including:

- Changes since previous version
- Known issues
- Upgrade considerations

---

## Support Lifecycle

### Version Support

| Version Type       | Support Level                              |
| ------------------ | ------------------------------------------ |
| **Latest patch**   | Full support — bug fixes, security patches |
| **Previous minor** | Best-effort — security patches only        |
| **Older major**    | Unsupported                                |

### Security Updates

Critical security vulnerabilities are addressed in the latest patch release. Organizations should:

- Monitor releases for security updates
- Test security patches before deploying
- Maintain rollback capability

---

## Upgrade Considerations

### Minor Upgrades (1.x → 1.y)

- Typically backward compatible
- Test in non-production first
- Archive sessions before upgrading

### Major Upgrades (1.x → 2.0)

- May include breaking changes
- Check release notes for migration requirements
- Plan for extended testing period

---

## Artifact Archival

### Customer Responsibility

Organizations should maintain:

- Copies of current and previous release artifacts
- Checksums for verification
- Rollback procedure documentation

### Recommended Archive

Sample layout — replace the placeholder versions with the actual releases
your organization needs to retain:

```
/artifact-store/
├── flowguard-core-<current>.tgz   # current
├── flowguard-core-<previous>.tgz  # previous
├── flowguard-core-<rollback>.tgz  # rollback candidate
├── checksums.sha256                # release-versioned (one per release)
├── sbom.cdx.json                   # release-versioned
└── release-notes/
    └── <created from GitHub Releases as needed>
```

Release-note files (`v1.2.0-rc.3.md`, etc.) are not shipped inside the repo;
download them from the GitHub Releases page or auto-fill from `CHANGELOG.md`.

---

## Contact

For release-related questions:

- Check [GitHub Releases](https://github.com/koeppben23/governed-runtime/releases)
- Open a [GitHub Issue](https://github.com/koeppben23/governed-runtime/issues)

---

FlowGuard Version: 1.2.0-tp.2
_Last Updated: 2026-04-15_

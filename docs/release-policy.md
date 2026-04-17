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
| **Minor** | 1.0.0   | New features — test before production use |
| **Patch** | 1.0.0   | Bug fixes — typically compatible          |

### Version Lifecycle

| Status       | Description            | Duration            |
| ------------ | ---------------------- | ------------------- |
| **Latest**   | Current stable release | Until next release  |
| **Previous** | Prior release          | Best-effort support |
| **Older**    | Unsupported            | No updates          |

---

## Release Process

### Artifact Creation

1. Build: TypeScript compiled to JavaScript
2. Package: `npm pack` creates `.tgz` artifact
3. Sign: SHA-256 checksum generated
4. Publish: Artifact uploaded to GitHub Releases

### Artifact Contents

| Component       | Description                           |
| --------------- | ------------------------------------- |
| **CLI**         | `flowguard` command                   |
| **Core**        | State machine, rails, adapters, audit |
| **Integration** | OpenCode tools, plugin, commands      |
| **Templates**   | Package.json, opencode.json templates |

### Integrity Verification

| Check                  | Mechanism                                         |
| ---------------------- | ------------------------------------------------- |
| **Artifact integrity** | SHA-256 checksum published on Releases page       |
| **Content integrity**  | SHA-256 content digest in `flowguard-mandates.md` |

---

## Distribution

### GitHub Releases

All FlowGuard releases are distributed via GitHub Releases (or an approved internal mirror):

| Asset                          | Purpose                        |
| ------------------------------ | ------------------------------ |
| `flowguard-core-{version}.tgz` | Pre-built npm package          |
| `checksums.sha256`             | Checksum file for verification |

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

```
/artifact-store/
├── flowguard-core-1.1.0.tgz
├── flowguard-core-1.1.0.tgz
├── checksums.sha256
└── release-notes/
    ├── v1.2.0.md
    └── 1.0.0.md
```

---

## Contact

For release-related questions:

- Check [GitHub Releases](https://github.com/koeppben23/governed-runtime/releases)
- Open a [GitHub Issue](https://github.com/koeppben23/governed-runtime/issues)

---

_FlowGuard Version: 1.1.0_
_Last Updated: 2026-04-15_

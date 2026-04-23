# Support Model

Responsibilities, contact channels, and expectations for FlowGuard support.

---

## Overview

FlowGuard is a proprietary software product maintained by the owner. This document defines what support is available, who is responsible for what, and how to get help.

FlowGuard is a **locally installed development tool**, not a hosted service. There is no SaaS infrastructure, no uptime SLA, and no managed operations. Commercial support contracts are not currently offered.

---

## Responsibility Matrix

| Area                     | Responsible Party       | Description                                           |
| ------------------------ | ----------------------- | ----------------------------------------------------- |
| FlowGuard source code    | **Maintainer**          | Bug fixes, security patches, releases                 |
| Installation and CLI     | **Maintainer**          | Installer, doctor, upgrade path                       |
| Documentation            | **Maintainer**          | Accuracy of docs, guides, and references              |
| Security vulnerabilities | **Maintainer**          | Triage, fix, coordinated disclosure                   |
| OpenCode integration     | **Maintainer**          | Tool bindings, plugin, command prompts                |
| OpenCode runtime         | **OpenCode project**    | OpenCode bugs, updates, LLM integration               |
| Node.js / Bun runtime    | **Runtime project**     | Node.js or Bun bugs and updates                       |
| Host environment         | **Organization / User** | OS, filesystem, network, permissions                  |
| Policy configuration     | **Organization / User** | Choosing policy mode, profile, active checks          |
| Compliance assessment    | **Organization / User** | Mapping FlowGuard controls to regulatory requirements |
| Audit trail retention    | **Organization / User** | Storing, archiving, and managing session data         |
| Access control           | **Organization / User** | Who can run FlowGuard, who can review                 |
| CI/CD integration        | **Organization / User** | Wrapping FlowGuard in pipeline scripts                |

---

## Contact Channels

### Bug Reports and Feature Requests

Open a [GitHub Issue](https://github.com/koeppben23/governed-runtime/issues).

Include:

- FlowGuard version (`flowguard --version` or check `VERSION` file)
- Node.js version (`node --version`)
- Operating system
- Steps to reproduce
- Expected vs. actual behavior
- Relevant error messages or reason codes

### Security Vulnerabilities

**Do not open a public issue.** Use GitHub's private vulnerability reporting:

1. Go to [Security Advisories](https://github.com/koeppben23/governed-runtime/security/advisories)
2. Click **"Report a vulnerability"**
3. Provide description, reproduction steps, and impact assessment

See [SECURITY.md](../SECURITY.md) for the full disclosure policy.

### Questions and Discussions

Open a [GitHub Issue](https://github.com/koeppben23/governed-runtime/issues) with the `question` label.

---

## Response Expectations

FlowGuard is maintained as a proprietary commercial product. Response times are best-effort, not contractual SLAs.

| Category                    | Target Response           | Target Resolution |
| --------------------------- | ------------------------- | ----------------- |
| **Security — Critical**     | 72 hours (acknowledgment) | 14 days           |
| **Security — Non-critical** | 1 week                    | Next release      |
| **Bug — Workflow blocked**  | 1 week                    | Best effort       |
| **Bug — Non-blocking**      | 2 weeks                   | Best effort       |
| **Feature request**         | 2 weeks (triage)          | Roadmap dependent |
| **Question**                | 2 weeks                   | Best effort       |

These are targets, not guarantees. Response and resolution times depend on severity, complexity, and maintainer availability.

### What "Response" Means

- The issue has been read and triaged
- A severity/priority label has been assigned
- An initial assessment or request for more information has been posted

### What "Resolution" Means

- A fix, workaround, or documented decision has been provided
- For bugs: a patch release or a commit on main
- For features: acceptance or rejection with rationale

---

## Supported Versions

| Version      | Status                                              |
| ------------ | --------------------------------------------------- |
| 1.x (latest) | Supported — receives bug fixes and security patches |
| < 1.0        | Not supported                                       |

Only the latest release within the supported major version receives patches. Users should upgrade to the latest release before reporting issues.

---

## Self-Service Resources

Before opening an issue, check these resources:

| Resource           | Location                                          | Content                                                  |
| ------------------ | ------------------------------------------------- | -------------------------------------------------------- |
| Installation guide | [docs/installation.md](./installation.md)         | Standard installation steps                              |
| Air-gapped guide   | [docs/air-gapped-guide.md](./air-gapped-guide.md) | Offline installation                                     |
| Troubleshooting    | [docs/troubleshooting.md](./troubleshooting.md)   | FAQ and common errors                                    |
| Reason codes       | FlowGuard output                                  | Every block includes a reason code and recovery guidance |
| Doctor command     | `flowguard doctor`                                | Verifies installation integrity                          |

### Using Reason Codes

When FlowGuard blocks progress, it emits a specific reason code with recovery steps. Example:

```
Blocked: COMMAND_NOT_ALLOWED
Reason: /implement is not valid in phase TICKET
Recovery: Use /ticket to record a task first, then /plan to create a plan.
```

Include the full reason code and recovery text when reporting issues — it helps triage significantly.

---

## Enterprise Support

Organizations deploying FlowGuard in regulated environments should:

1. **Designate an internal owner** responsible for FlowGuard configuration, upgrades, and integration.
2. **Monitor releases** on the [Releases page](https://github.com/koeppben23/governed-runtime/releases) for security patches.
3. **Subscribe to Security Advisories** via GitHub's watch feature on the repository.
4. **Maintain internal documentation** mapping FlowGuard controls to your specific compliance requirements (see [BSI C5 Mapping](./bsi-c5-mapping.md) for an example framework).
5. **Test upgrades** in a non-production environment before rolling out to teams.

---

## Contributing

Bug fixes and improvements are welcome. See [CONTRIBUTING.md](../CONTRIBUTING.md) for development setup, code style, testing requirements, and the PR process.

---

_FlowGuard Version: 1.2.0-rc.1-rc.1_
_Last Updated: 2026-04-15_

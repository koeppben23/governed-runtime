# Support Model

Responsibilities, contact channels, and expectations for FlowGuard support.

---

## Overview

FlowGuard is a proprietary software product maintained by the owner. This document defines what support is available, who is responsible for what, and how to get help.

FlowGuard is a **locally installed development tool**, not a hosted service. There is no SaaS infrastructure, no uptime SLA, and no managed operations.

Contractual support is not generally available as a public self-service offering today. For regulated or procurement-driven deployments, support terms can be discussed via direct commercial inquiry (see Enterprise Support below).

---

## Responsibility Matrix

| Area                     | Responsible Party       | Description                                                   |
| ------------------------ | ----------------------- | ------------------------------------------------------------- |
| FlowGuard source code    | **Maintainer**          | V2 development, releases, and best-effort security triage     |
| Installation and CLI     | **Maintainer**          | Installer, doctor, upgrade path                               |
| Documentation            | **Maintainer**          | Accuracy of docs, guides, and references                      |
| Security vulnerabilities | **Maintainer**          | Triage and coordinated disclosure; remediation is best-effort |
| OpenCode integration     | **Maintainer**          | Tool bindings, plugin, command prompts                        |
| OpenCode runtime         | **OpenCode project**    | OpenCode bugs, updates, LLM integration                       |
| Node.js / Bun runtime    | **Runtime project**     | Node.js or Bun bugs and updates                               |
| Host environment         | **Organization / User** | OS, filesystem, network, permissions                          |
| Policy configuration     | **Organization / User** | Choosing policy mode, profile, active checks                  |
| Compliance assessment    | **Organization / User** | Mapping FlowGuard controls to regulatory requirements         |
| Audit trail retention    | **Organization / User** | Storing, archiving, and managing session data                 |
| Access control           | **Organization / User** | Who can run FlowGuard, who can review                         |
| CI/CD integration        | **Organization / User** | Wrapping FlowGuard in pipeline scripts                        |

---

## Contact Channels

### Bug Reports and Feature Requests

Open a [GitHub Issue](https://github.com/koeppben23/governed-runtime/issues).

Include:

- FlowGuard version (`flowguard doctor --install-scope global` reports the installed version, or read the shipped `VERSION` file)
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

### Hands-on Evaluation Requests

FlowGuard is proprietary software. The public repository is available for
read-only evaluation; hands-on use requires prior written permission from the
copyright holder. Contact the author via
[LinkedIn](https://www.linkedin.com/in/benjamin-fuchs-ba6986190/) to request an
authorized technical evaluation or discuss your organization's governance
requirements.

---

## Response Expectations

FlowGuard is maintained as a proprietary commercial product. Security reports
and support requests are reviewed on a best-effort basis. Triage and remediation
are prioritized according to severity, impact, exploitability, and maintainer
availability.

No guaranteed response or remediation times apply unless explicitly agreed under
a separate support contract.

### What "Response" Means

When capacity permits, the maintainer reads and triages the report, assigns a
severity or priority where possible, and may request more information.

### What "Resolution" Means

A resolution may be a fix, workaround, documented decision, or no action if the
request is out of scope or cannot be prioritized.

---

## Supported Versions

| Version    | Support status                                                                                |
| ---------- | --------------------------------------------------------------------------------------------- |
| 2.0.0-tp.x | Active development — Technical Preview, best-effort support; no production support commitment |
| 1.x        | Legacy — no active maintenance or security patch commitment                                   |
| < 1.0      | Unsupported                                                                                   |

FlowGuard's active development is focused exclusively on V2. V1.x releases remain
available as historical artifacts but are not actively maintained. The
`2.0.0-tp.x` line is a technical preview; it is not a GA support claim.

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

### Commercial / Contractual Support Path

For organizations that require contractual support terms (for example regulated
enterprise buyers), use the following path:

1. Open a GitHub issue labeled `enterprise-support-request` with non-sensitive context (deployment model, expected scale, regulatory scope).
2. Request private follow-up for commercial terms.
3. Agree support scope, response targets, patch windows, and upgrade guidance separately in a support contract before production rollout.

This creates a documented procurement path even when no public standard support SKU is listed.

---

## Contributing

Bug reports and security reports are welcome. Code contributions require prior
written permission from the copyright holder; see
[CONTRIBUTING.md](../CONTRIBUTING.md) for the authorized-contributor workflow,
development setup, code style, testing requirements, and the PR process.

---

FlowGuard Version: 2.0.0-tp.3
_Last Updated: 2026-04-15_

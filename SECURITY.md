# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |

## Security Update Policy

- **Critical vulnerabilities**: Acknowledgment within 72 hours, best-effort fix timeline
- **High/Medium/Low**: Next planned release

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Use GitHub's private vulnerability reporting:

1. Go to the [Security Advisories](https://github.com/koeppben23/governed-runtime/security/advisories) page
2. Click **"Report a vulnerability"**
3. Provide a description of the vulnerability, steps to reproduce, and impact assessment

You will receive an acknowledgment within 72 hours. We aim to provide a fix or mitigation plan within 14 days for critical issues.

## Scope

FlowGuard is a **governance runtime library** — it enforces development workflow policies
and provides tamper-evident audit trails. It does NOT provide network security, encryption
at rest, or LLM prompt injection protection.

### In Scope

The following are in scope for security reports:

- Authentication/authorization bypass in governance workflows
- State manipulation that circumvents workflow gates (phase transitions, evidence tampering)
- Audit trail integrity violations (hash chain breaks, event omission, timestamp forgery)
- Path traversal or file system escape in workspace or session directory handling
- Secret exposure through logs, state files, archive artifacts, or export/redaction paths
- Trust boundary violations between policy modes — e.g., solo-mode actor approving a regulated gate
- Identity provider configuration bypass — e.g., required IdP mode silently degrading without error

### Out of Scope

- Vulnerabilities in third-party dependencies (report upstream; we monitor via `npm audit`)
- Issues requiring physical access to the host machine
- Social engineering or phishing attacks
- LLM prompt injection, model hallucinations, or AI safety concerns
- Network-layer attacks (FlowGuard has no open ports)
- Encryption at rest for state files or audit artifacts (plaintext JSON/JSONL by design,
  with SHA-256 hash chains for tamper evidence, not confidentiality)

## Disclosure Policy

- We follow coordinated disclosure: fixes are released before public disclosure
- Security advisories are published via GitHub Security Advisories
- Credit is given to reporters unless anonymity is requested

## Enterprise Security Considerations

- FlowGuard operates locally with no outbound network calls
- All data remains on the local filesystem
- Audit trails use SHA-256 hash chains for tamper evidence
- Policy snapshots are immutable and SHA-256 hashed per session

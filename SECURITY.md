# Security Policy

## Supported Versions

| Version    | Support status                                                                                |
| ---------- | --------------------------------------------------------------------------------------------- |
| 2.0.0-tp.x | Active development — Technical Preview, best-effort support; no production support commitment |
| 1.x        | Legacy — no active maintenance or security patch commitment                                   |
| < 1.0      | Unsupported                                                                                   |

FlowGuard's active development is focused exclusively on V2. V1.x releases remain
available as historical artifacts but are not actively maintained. `2.0.0-tp.x`
is a technical preview line; it is not a GA support claim.

## Security Assurance

The executable CI security gates and their limits are documented in
[docs/security-assurance.md](./docs/security-assurance.md). CodeQL analyses are
configured to upload SARIF to GitHub code scanning; the recorded analysis
evidence is maintained in that document. The `security-policy` CI job verifies
only the declarative repository intent file; it does not verify the live GitHub
private vulnerability reporting setting. The live setting was last verified on
2026-11-17 and reported `enabled: true`.

## Security Update Policy

Security reports are reviewed on a best-effort basis. Triage and remediation are
prioritized according to severity, impact, exploitability, and maintainer
availability.

No guaranteed response or remediation times apply unless explicitly agreed under
a separate support contract.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Use GitHub's private vulnerability reporting:

1. Go to the [Security Advisories](https://github.com/koeppben23/governed-runtime/security/advisories) page
2. Click **"Report a vulnerability"**
3. Provide a description of the vulnerability, steps to reproduce, and impact assessment

Reports are reviewed on a best-effort basis. No guaranteed response or remediation time applies unless separately agreed under a support contract.

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
- Network-layer attacks against operator-enabled network surfaces. FlowGuard opens no
  listener in the default OpenCode/plugin path, but Claude Code HTTP hook mode starts
  an explicit localhost hook server when configured.
- Encryption at rest for state files or audit artifacts (plaintext JSON/JSONL by design,
  with SHA-256 hash chains for tamper evidence, not confidentiality)

## Disclosure Policy

- We follow coordinated disclosure: fixes are released before public disclosure
- Security advisories are published via GitHub Security Advisories
- Credit is given to reporters unless anonymity is requested

## Enterprise Security Considerations

- FlowGuard is filesystem-first and offline-capable by default.
- Outbound runtime network access occurs only when explicitly configured or invoked,
  such as `/review url=...` HTTPS content loading or remote JWKS refresh via
  `identityProvider.mode=jwks` with `jwksUri`.
- Session state, audit trails, and archives remain on the local filesystem unless an
  operator exports, copies, or configures host tooling to transmit them.
- Audit trails use SHA-256 hash chains for tamper evidence
- Policy snapshots are immutable and SHA-256 hashed per session

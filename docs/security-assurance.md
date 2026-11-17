# Security Assurance

This document records what the repository's security gates actually verify and
where their limits are. A green check is evidence that the configured check ran;
it is not a proof that the Work contains no vulnerabilities. Findings remain
subject to triage under [SECURITY.md](../SECURITY.md).

## Executable gates

| Gate              | Workflow / job                                               | What it proves                                                                         | What it does not prove                                                                                                        |
| ----------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Dependency audit  | `.github/workflows/security.yml` / `audit`                   | `npm audit --audit-level=high` completed on PRs, `main`, and the weekly schedule       | It does not cover source-level vulnerabilities, runtime configuration, or advisories that npm does not report                 |
| CodeQL            | `.github/workflows/security.yml` / `codeql-sast`             | CodeQL `security-extended` runs against the TypeScript build with SARIF upload enabled | It does not prove an absence of findings; open alerts must be triaged                                                         |
| Secret scan       | `.github/workflows/ci.yml` / `secrets-scan`                  | Gitleaks scanned the checkout and PR history available to the action                   | It does not prove that no secret exists outside the scanned history or in external systems                                    |
| PVR intent        | `.github/workflows/ci.yml` / `security-policy`               | The repository contains the declarative `.github/security-advisories.yml` intent file  | It does **not** verify the live GitHub private vulnerability reporting setting                                                |
| Dependency review | `.github/workflows/ci.yml` / `dependency-review`             | The PR dependency diff is reviewed for high-severity advisories                        | This job is advisory: it is PR-only and currently uses `continue-on-error: true`, so it is not a merge-blocking security gate |
| Workflow hygiene  | `.github/workflows/ci.yml` / `actionlint`, `actions-pinning` | Workflow syntax is valid and action references follow the pinning policy               | It does not prove that pinned actions are free of vulnerabilities                                                             |

## CodeQL

The `codeql-sast` job keeps `security-events: write` and is configured to upload
the SARIF result with `upload: always`. A successful run must produce a new
analysis with a new identifier; a green job alone is not enough.

Verify the uploaded analysis after a PR run:

```bash
gh api 'repos/koeppben23/governed-runtime/code-scanning/analyses?per_page=5'
```

Record the new analysis `id`, `created_at`, `commit_sha`, `results_count`,
`rules_count`, and `url` in the PR evidence. If `results_count` is nonzero,
triage the findings before claiming the security work is complete.

## Private vulnerability reporting

`.github/security-advisories.yml` is a repository-local declaration of intent,
not a GitHub setting and not an activation mechanism. The `security-policy` CI
job checks only that declaration. It must not be described as proof that GitHub
private vulnerability reporting is enabled.

The live setting is verified manually with a repository-admin-capable token:

```bash
gh api repos/koeppben23/governed-runtime/private-vulnerability-reporting
```

Last verified: **2026-11-17**. Result: `{"enabled":true}`.

Re-run the command after repository settings changes and update this record. Do
not add a long-lived admin token to CI merely to automate this check; the
declarative file plus a recorded live verification is the accepted boundary.

## Reporting and triage

Report vulnerabilities through GitHub private vulnerability reporting as
described in [SECURITY.md](../SECURITY.md). Do not open a public issue for a
security vulnerability.

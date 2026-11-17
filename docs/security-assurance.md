# Security Assurance

This document records what the repository's security gates actually verify and
where their limits are. A green check is evidence that the configured check ran;
it is not a proof that the Work contains no vulnerabilities. Findings remain
subject to triage under [SECURITY.md](../SECURITY.md).

## Executable gates

| Gate              | Workflow / job                                               | What it proves                                                                                       | What it does not prove                                                                                                        |
| ----------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Dependency audit  | `.github/workflows/security.yml` / `audit`                   | High/critical audit with the documented time-boxed exception; any other high/critical advisory fails | It does not cover source-level vulnerabilities, runtime configuration, or advisories that npm does not report                 |
| CodeQL            | `.github/workflows/security.yml` / `codeql-sast`             | CodeQL `security-extended` runs against the TypeScript build with SARIF upload enabled               | It does not prove an absence of findings; open alerts must be triaged                                                         |
| Secret scan       | `.github/workflows/ci.yml` / `secrets-scan`                  | Gitleaks scanned the checkout and PR history available to the action                                 | It does not prove that no secret exists outside the scanned history or in external systems                                    |
| PVR intent        | `.github/workflows/ci.yml` / `security-policy`               | The repository contains the declarative `.github/security-advisories.yml` intent file                | It does **not** verify the live GitHub private vulnerability reporting setting                                                |
| Dependency review | `.github/workflows/ci.yml` / `dependency-review`             | The PR dependency diff is reviewed for high-severity advisories                                      | This job is advisory: it is PR-only and currently uses `continue-on-error: true`, so it is not a merge-blocking security gate |
| Workflow hygiene  | `.github/workflows/ci.yml` / `actionlint`, `actions-pinning` | Workflow syntax is valid and action references follow the pinning policy                             | It does not prove that pinned actions are free of vulnerabilities                                                             |

## Time-boxed dependency-audit exception

The `audit` job runs `scripts/security-audit.mjs`, not a blanket ignore. The
script fails on every high or critical advisory except the single active,
expiring exception below. A critical advisory is never covered.

| Field    | Value                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------- |
| Advisory | `GHSA-fc5q-39xc-vjpf` / `CVE-2026-112366`                                                                     |
| Package  | `picomatch <= 4.0.7`                                                                                          |
| Severity | High (ReDoS)                                                                                                  |
| Expires  | **2026-12-17**                                                                                                |
| Reason   | No patched `picomatch` release exists; npm audit suggests a breaking `vitest` downgrade                       |
| Removal  | Update `picomatch` to a patched release, regenerate the lockfile, remove this exception, and re-run the audit |

The exception is intentionally narrow:

- Any unrelated high advisory fails the job.
- Any critical advisory, including a critical revision of this advisory, fails.
- An expired exception fails before the audit result is accepted.
- The allowed dependency-chain entries are accepted only while the sole
  high/critical advisory object is the exception above.

FlowGuard source does not import `picomatch` directly; it is pulled in
transitively through tooling and the host SDK. CodeQL, Gitleaks, and dependency
review remain active while this exception is in place. The exception must be
removed when a patched release is available or on its expiry date, whichever
comes first.

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

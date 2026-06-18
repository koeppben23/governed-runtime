# GitHub Branch Protection

This document defines the merge-blocking settings for the `main` branch.

## Rule Target

- Branch name pattern: `main`

## Required Protection Settings

| Setting                                      | Value     |
| -------------------------------------------- | --------- |
| Require a pull request before merging        | Enabled   |
| Required approvals                           | 1 or more |
| Dismiss stale reviews                        | Enabled   |
| Require status checks to pass before merging | Enabled   |
| Do not allow bypassing the above settings    | Enabled   |
| Do not allow force pushes                    | Enabled   |
| Do not allow deletion                        | Enabled   |

## Required Status Checks (merge-blocking)

Only real CI job names are allowed in this list. Configure the following check
names exactly (grouped by the workflow that produces them):

From `.github/workflows/conventional-commits.yml`:

- `Validate Commit Messages`

From `.github/workflows/ci.yml`:

- `unit`
- `test`
- `integration`
- `architecture`
- `typecheck`
- `lint`
- `format`
- `actions-pinning`
- `build`
- `install-verify (ubuntu-latest)`
- `install-verify (macos-latest)`
- `install-verify (windows-latest)`
- `smoke`
- `independent-review-e2e`
- `actionlint`
- `secrets-scan`
- `security-policy`
- `dependency-review`
- `install (ubuntu-latest)`
- `install (macos-latest)`
- `install (windows-latest)`

From `.github/workflows/security.yml`:

- `audit`
- `codeql-sast`

`install-verify (...)` and `install (...)` are distinct required jobs and must
both stay aligned with CI truth.

> Live-setting changes required when this PR merges (admin action):
>
> - **Remove `mutation`** from the required list — it no longer runs on PRs (see
>   below). If left required, every PR stays blocked on a never-reported check.
> - **Add `dependency-review`** — configured with `fail-on-severity: high` and
>   `continue-on-error: true`. The check runs but is non-blocking until
>   [Dependency Graph](https://github.com/koeppben23/governed-runtime/settings/security_analysis)
>   is enabled for the repository (required by the action). After enabling,
>   remove `continue-on-error: true` and add it to the required list.
> - `audit` and `codeql-sast` keep the same check names (now produced by
>   `security.yml`); no name change is needed.

## Non-blocking CI Jobs

The following jobs run but are intentionally **not** required:

| Job                   | Why non-blocking                                                                                                                                                                                                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sdk-baseline`        | Snapshot comparison against upstream SDK/host baselines; drift is informational and acted on via a separate update workflow (`scripts/check-opencode-host-drift.mjs`).                                                                                                                                |
| `unused-dependencies` | `knip --dependencies`; a false positive should not block a release. Review the diff manually.                                                                                                                                                                                                         |
| `fuzz`                | `fast-check` property tests with a fixed seed (~100 iterations). Deep fuzzing runs on the nightly schedule (`fuzz-nightly.yml`); regressions block via the nightly cadence, not the PR.                                                                                                               |
| `mutation`            | Stryker runs on the nightly/release cadence (`mutation.yml`), not per-PR. A reliable per-PR incremental gate is not achievable with the current perTest + vitest-runner setup (see the workflow rationale); it is therefore not a required check.                                                     |
| `dependency-review`   | `fail-on-severity: high` is configured; runs as advisory (`continue-on-error: true`) because [Dependency Graph](https://github.com/koeppben23/governed-runtime/settings/security_analysis) is not yet enabled for this repository. Will become a required check after the repo setting is toggled on. |

If any of these is promoted to merge-blocking, move it to the required list
above in the same PR that flips the branch-protection setting.

## Source of Truth

- CI workflow: `.github/workflows/ci.yml`
- Security workflow: `.github/workflows/security.yml`
- Commit title check: `.github/workflows/conventional-commits.yml`

If CI job names change, update this file and the branch protection required-check list together.

## Quick Validation Steps

1. Open `Settings -> Branches -> Branch protection rules -> main`.
2. Verify all settings in this file are enabled.
3. Verify all required check names above are present and exact.
4. Open a test PR and confirm merge stays blocked until all required checks pass.

## Emergency Procedure

Use admin override only for incident response:

1. Record incident context and approver.
2. Apply emergency fix.
3. Re-enable full protection immediately.
4. Create post-incident review entry.
